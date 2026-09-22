import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CookieJar } from "tough-cookie";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { YuqueWebClient } from "../src/yuque-client.js";
import { parseTableSchema, parseTableRecords } from "../src/table-model.js";
import { callTool, type McpDependencies } from "../src/mcp.js";
import type { AppConfig } from "../src/config.js";

const columns = [
  { id: "title", name: "Title", type: "text" },
  {
    id: "status",
    name: "Status",
    type: "select",
    options: [{ id: "doing", value: "In progress" }],
  },
  {
    id: "tags",
    name: "Tags",
    type: "multiSelect",
    options: [{ id: "a", value: "Alpha" }],
  },
  { id: "owner", name: "Owner", type: "mention" },
  { id: "due", name: "Due", type: "date" },
  { id: "progress", name: "Progress", type: "progress" },
  { id: "creator", name: "Creator", type: "userId" },
  { id: "created", name: "Created", type: "createdAt" },
];
const schema = {
  format: "laketable",
  type: "Table",
  version: 1.4,
  sheet: [
    {
      id: "sheet-a",
      columns,
      views: { grid: { id: "grid", name: "Grid", type: "GRID", data: {} } },
    },
  ],
};
const record = (index: number) => ({
  uuid: `record-${index}`,
  doc_id: 12,
  doc_type: "Doc",
  sheet_id: "sheet-a",
  user_id: 7,
  modifier_id: 7,
  created_at: "2026-09-18T00:00:00Z",
  updated_at: "2026-09-18T00:00:00Z",
  data: JSON.stringify({
    title: { value: `Task ${index}` },
    status: { value: "doing" },
    tags: { value: ["a", "unknown"] },
    owner: { value: [{ id: 7, name: "Alice" }] },
    due: { value: { text: "2026-09-30", time: "2026-09-29T16:00:00Z" } },
    progress: { value: "25.000000" },
  }),
});
const users = [{ id: 7, user_id: 7, name: "Alice" }];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Table/laketable read", () => {
  it("decodes actual records independently of empty views.data and maps display values", () => {
    const sheet = parseTableSchema(JSON.stringify(schema))[0]!;
    const page = parseTableRecords(
      { records: [record(0)], hasMore: false, users },
      sheet,
      "12",
      100,
    );
    const values = Object.fromEntries(
      page.records[0]!.cells.map((c) => [c.column_id, c.display_value]),
    );
    expect(values).toEqual({
      title: "Task 0",
      status: "In progress",
      tags: ["Alpha", "unknown"],
      owner: ["Alice"],
      due: "2026-09-30",
      progress: "25%",
      creator: "Alice",
      created: "2026-09-18T00:00:00Z",
    });
    expect(
      page.records[0]!.cells.find((c) => c.column_id === "status")?.value,
    ).toBe("doing");
  });

  it("rejects malformed, mismatched, duplicate and non-progressing pages", () => {
    const sheet = parseTableSchema(JSON.stringify(schema))[0]!;
    for (const records of [
      [{ ...record(0), doc_id: 99 }],
      [{ ...record(0), sheet_id: "another" }],
      [record(0), record(0)],
      [{ ...record(0), data: "bad json" }],
    ]) {
      expect(() =>
        parseTableRecords({ records, hasMore: false, users }, sheet, "12", 100),
      ).toThrow();
    }
    expect(() =>
      parseTableRecords(
        { records: [], hasMore: true, users },
        sheet,
        "12",
        100,
      ),
    ).toThrow(/progress/);
    expect(() =>
      parseTableRecords({ records: [], users }, sheet, "12", 100),
    ).toThrow(/hasMore/);
    expect(() =>
      parseTableSchema('{"format":"lakesheet","sheet":[]}'),
    ).toThrow();
    expect(() => parseTableSchema("not-json")).toThrow(/Invalid Table JSON/);
    expect(() =>
      parseTableRecords(
        { records: [record(0), record(1)], hasMore: false, users },
        sheet,
        "12",
        1,
      ),
    ).toThrow(/bounded/);
  });

  it("reads paginated HTTP records and routes legacy get_doc calls without reading schema-as-text", async () => {
    const fixture = await createFixture();
    const first = await fixture.client.getTable("employee.a", fixture.url, {
      limit: 2,
    });
    expect(first).toMatchObject({
      source_type: "Table",
      output_format: "table_records",
      returned_count: 2,
      next_offset: 2,
      has_more: true,
      complete: false,
      view_filters_applied: false,
      display_path: "空间：test / Book / Table",
    });
    const last = await fixture.client.getTable("employee.a", fixture.url, {
      offset: 2,
      limit: 2,
    });
    expect(last).toMatchObject({
      returned_count: 1,
      next_offset: null,
      has_more: false,
      complete: false,
    });
    expect(last.records).toMatchObject([{ id: "record-2" }]);
    const deps = { client: fixture.client } as McpDependencies;
    await expect(
      callTool("employee.a", "yuque_get_doc", { doc_url: fixture.url }, deps),
    ).resolves.toMatchObject({
      returned_count: 3,
      complete: true,
      output_format: "table_records",
    });
    await expect(
      callTool(
        "employee.a",
        "yuque_get_table",
        { doc_url: fixture.url, offset: 3, limit: 2 },
        deps,
      ),
    ).resolves.toMatchObject({ records: [], has_more: false, complete: false });
    await expect(
      callTool(
        "employee.a",
        "yuque_get_doc",
        { doc_url: fixture.url, cursor: 10 },
        deps,
      ),
    ).rejects.toThrow(/text cursor/);
    await expect(
      fixture.client.getTable("employee.a", fixture.url, {
        sheetId: "missing",
      }),
    ).rejects.toThrow(/sheet_id/);
    await expect(
      fixture.client.getTable("employee.a", fixture.url, { limit: 5001 }),
    ).rejects.toThrow(/limit/);
    await expect(
      fixture.client.getTable("employee.a", fixture.url, { offset: -1 }),
    ).rejects.toThrow(/offset/);
    await expect(
      fixture.client.getExportOptions("employee.a", fixture.url),
    ).rejects.toThrow(/abilities/);
    expect(fixture.unexpected).toEqual([]);
  });

  it("requires sheet selection and does not query rows from an arbitrary sheet", async () => {
    const fixture = await createFixture(true);
    const result = await fixture.client.getTable("employee.a", fixture.url);
    expect(result.selection_required).toBe(true);
    expect(result).not.toHaveProperty("records");
    expect(fixture.recordQueries).toHaveLength(0);
  });
});

describe("bounded Table queries through MCP", () => {
  it("continues compact byte-limited pages without skipping rows", async () => {
    const f = await createFixture(false, {}, false, 601);
    const ids: string[] = [];
    let offset = 0;
    let limited = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await f.client.getTable("employee.a", f.url, {
        columns: ["Title", "Status"],
        raw: false,
        limit: 500,
        offset,
      });
      expect(
        Buffer.byteLength(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          }),
        ),
      ).toBeLessThanOrEqual(40960);
      const rows = result.records as Array<{ id: string }>;
      ids.push(...rows.map((r) => r.id));
      limited ||= result.output_limited === true;
      if (!result.has_more) break;
      expect(result.next_offset).toBe(offset + rows.length);
      offset = result.next_offset as number;
    }
    expect(limited).toBe(true);
    expect(ids).toEqual(Array.from({ length: 601 }, (_, i) => `record-${i}`));
  });

  it("filters before pagination and projection and keeps legacy reads intact", async () => {
    const f = await createFixture();
    const deps = { client: f.client } as McpDependencies;
    const result = await callTool(
      "employee.a",
      "yuque_get_table",
      {
        doc_url: f.url,
        filter: { Owner: { id: "7" } },
        columns: ["Title"],
        raw: false,
        offset: 1,
        limit: 1,
      },
      deps,
    );
    expect(result).toMatchObject({
      total: 3,
      matched_total: 3,
      returned_count: 1,
      has_more: true,
      next_offset: 2,
      pagination_basis: "filtered_records",
      records: [
        {
          id: "record-1",
          cells: [{ column_id: "title", display_value: "Task 1" }],
        },
      ],
    });
    expect(result).not.toHaveProperty("records.0.cells.0.value");
    const last = await f.client.getTable("employee.a", f.url, {
      filter: { Owner: "Alice" },
      offset: 2,
      limit: 1,
    });
    expect(last).toMatchObject({ has_more: false, next_offset: null });
    const legacy = await f.client.getTable("employee.a", f.url, { limit: 1 });
    expect(legacy).toHaveProperty("records.0.cells.0.value", "Task 0");
    expect(f.unexpected).toEqual([]);
  });

  it("computes stats from all scanned pages without returning row payloads", async () => {
    const f = await createFixture(false, {}, false, 601);
    const result = await callTool(
      "employee.a",
      "yuque_get_table_stats",
      {
        doc_url: f.url,
        group_by: ["Status", "Owner"],
        filter: { Progress: 25 },
      },
      { client: f.client } as McpDependencies,
    );
    expect(result).toMatchObject({
      total: 601,
      matched_total: 601,
      scan_complete: true,
      distributions: [
        {
          column_id: "status",
          buckets: [{ value: "doing", label: "In progress", count: 601 }],
        },
        {
          column_id: "owner",
          buckets: [{ value: "7", label: "Alice", count: 601 }],
        },
      ],
    });
    expect(result).not.toHaveProperty("records");
    expect(f.recordQueries.map((q) => q.get("offset"))).toEqual(["0", "500"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(3000);
  });

  it("returns no matches accurately and refuses incomplete scans", async () => {
    const f = await createFixture();
    expect(
      await f.client.getTableStats("employee.a", f.url, {
        groupBy: ["Status"],
        filter: { Owner: { id: "99" } },
      }),
    ).toMatchObject({
      total: 3,
      matched_total: 0,
      distributions: [{ buckets: [] }],
    });
    const large = await createFixture(false, {}, false, 5001);
    await expect(
      large.client.getTableStats("employee.a", large.url, {
        groupBy: ["Status"],
      }),
    ).rejects.toThrow(/5000 rows/);
  });
});

describe("document metadata read", () => {
  it.each([
    ["Doc", "lake", false],
    ["Sheet", "lakesheet", true],
    ["Table", "laketable", false],
  ])(
    "reads %s metadata without text or row requests",
    async (type, format, personal) => {
      const f = await createFixture(
        false,
        {
          type,
          format,
          user_id: 7,
          user: {
            id: 7,
            name: "Alice",
            login: "alice",
            email: "private@example.test",
          },
          last_editor: { id: 8, name: "Bob", login: "bob" },
          created_at: "2026-09-01T00:00:00Z",
        },
        personal,
      );
      const result = await callTool(
        "employee.a",
        "yuque_get_doc_metadata",
        { doc_url: f.url },
        { client: f.client } as McpDependencies,
      );
      expect(result).toMatchObject({
        id: "12",
        url: f.url,
        source_type: type,
        source_format: format,
        creator: { id: "7", name: "Alice", login: "alice" },
        last_editor: { id: "8", name: "Bob", login: "bob" },
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-18T00:00:00Z",
        full_path: expect.any(Array),
        display_path: expect.stringContaining("Table"),
      });
      for (const key of ["body", "content", "records", "raw", "markdown"])
        expect(result).not.toHaveProperty(key);
      expect(result).not.toHaveProperty("creator.email");
      expect(f.recordQueries).toEqual([]);
      expect(f.unexpected).toEqual([]);
    },
  );

  it("does not infer a creator or creation date from the editor or updated date", async () => {
    const f = await createFixture(false, {
      created_at: "invalid",
      last_editor: { id: 8, name: "Bob" },
    });
    expect(await f.client.getDocMetadata("employee.a", f.url)).toMatchObject({
      creator: null,
      creator_source: null,
      created_at: null,
      last_editor: { id: "8", name: "Bob", login: null },
    });
  });

  it("preserves a creator ID when the user object is absent", async () => {
    const f = await createFixture(false, { user_id: 7 });
    expect(await f.client.getDocMetadata("employee.a", f.url)).toMatchObject({
      creator: { id: "7", name: null, login: null },
      last_editor: null,
    });
  });

  it.each([
    { book_id: 99 },
    { slug: "other-doc" },
    { id: 99 },
    { user_id: 7, user: { id: 8 } },
  ])("rejects mismatched identity %j", async (detail) => {
    const f = await createFixture(false, detail);
    await expect(f.client.getDocMetadata("employee.a", f.url)).rejects.toThrow(
      /another target|catalog location|creator ID/,
    );
    expect(f.recordQueries).toEqual([]);
  });
});

async function createFixture(
  multipleSheets = false,
  metadata: Record<string, unknown> = {},
  personal = false,
  totalRows = 3,
) {
  const unexpected: string[] = [];
  const recordQueries: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") {
      unexpected.push(req.method!);
      res.statusCode = 405;
      return res.end("{}");
    }
    if (
      personal &&
      ["/api/mine/collaborations", "/api/mine/collaborate_books"].includes(
        url.pathname,
      )
    )
      return res.end(JSON.stringify({ data: [] }));
    if (
      url.pathname ===
      (personal ? "/api/mine/personal_books" : "/api/mine/books")
    )
      return res.end(
        JSON.stringify({
          data: [
            {
              id: 11,
              slug: "book",
              name: "Book",
              items_count: 1,
              user: { login: "team" },
            },
          ],
        }),
      );
    if (url.pathname === "/api/docs/table-doc")
      return res.end(
        JSON.stringify({
          data: {
            id: 12,
            title: "Table",
            slug: "table-doc",
            book_id: 11,
            type: "Table",
            format: "laketable",
            draft_version: 1,
            updated_at: "2026-09-18T00:00:00Z",
            content: JSON.stringify(
              multipleSheets
                ? {
                    ...schema,
                    sheet: [
                      ...schema.sheet,
                      { ...schema.sheet[0], id: "sheet-b" },
                    ],
                  }
                : schema,
            ),
            ...metadata,
          },
        }),
      );
    if (url.pathname === "/api/catalog_nodes")
      return res.end(
        JSON.stringify({
          data: [
            {
              type: "DOC",
              title: "Table",
              uuid: "node-a",
              parent_uuid: "",
              level: 0,
              visible: 1,
              doc_id: 12,
              url: "table-doc",
            },
          ],
        }),
      );
    if (url.pathname === "/api/modules/table/doc/TableRecordController/show") {
      recordQueries.push(url.searchParams);
      expect(url.searchParams.get("docId")).toBe("12");
      expect(url.searchParams.get("docType")).toBe("Doc");
      expect(url.searchParams.get("sheetId")).toBe("sheet-a");
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return res.end(
        JSON.stringify({
          records: Array.from(
            { length: Math.max(0, Math.min(limit, totalRows - offset)) },
            (_, i) => record(offset + i),
          ),
          hasMore: offset + limit < totalRows,
          users,
        }),
      );
    }
    unexpected.push(url.pathname);
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server address");
  const host = `http://127.0.0.1:${address.port}`;
  const dataDir = await mkdtemp(join(tmpdir(), "yuque-table-test-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const sessions = new SessionStore(dataDir, new CryptoBox(key));
  await sessions.save("employee.a", {
    cookies: new CookieJar().serializeSync(),
    csrfToken: "csrf",
    account: { id: "7", login: "alice" },
    savedAt: new Date().toISOString(),
  });
  const config: AppConfig = {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: host,
    personalYuqueHost: personal ? host : "https://www.yuque.com",
    organization: personal ? "" : "test",
    dataDir,
    databasePath: join(dataDir, "state.db"),
    contractPath: "contracts/yuque-web-2026-08-14.json",
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey: key,
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 5000,
    writeConsistencyMode: "strict",
    writeKillSwitch: true,
    allowUnverifiedContracts: false,
  };
  const client = new YuqueWebClient(
    config,
    await ContractRegistry.load(config.contractPath),
    sessions,
  );
  cleanups.push(() => client.close());
  return {
    client,
    url: `${host}/team/book/table-doc`,
    unexpected,
    recordQueries,
  };
}
