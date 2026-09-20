import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CookieJar } from "tough-cookie";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { YuqueWebClient, validateExportUrl } from "../src/yuque-client.js";
import { ChangeStore } from "../src/change-store.js";
import { AppDatabase } from "../src/db.js";
import { callTool, type McpDependencies } from "../src/mcp.js";
import type { AppConfig } from "../src/config.js";
import { archiveFixture } from "./helpers/archive-fixture.js";

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of cleanups.splice(0).reverse()) await c();
});
const host = "https://example-team.yuque.com";

describe("native Table document transfer and export", () => {
  it.each(["copy", "move"] as const)(
    "%s through MCP and verify contents, IDs and catalog without deleting test documents",
    async (action) => {
      const f = await fixture(),
        p = await f.preview(action);
      expect(f.writes).toHaveLength(0);
      await expect(f.confirm(p)).resolves.toMatchObject({
        state: "succeeded",
        action,
        record_count: 2,
        target_doc_id: action === "copy" ? 14 : 12,
      });
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]).toEqual({
        path: `/api/catalog_nodes/${action}`,
        method: "PUT",
        body: {
          book_id: 11,
          node_uuid: "node-12",
          target_uuid: null,
          action: "prependChild",
          target_book_id: 22,
          with_children: action === "move",
          insert_to_catalog: true,
        },
      });
      await expect(f.status(p)).resolves.toMatchObject({
        state: "succeeded",
        phase: "completed",
        reconciliation: {
          source_present: action === "copy",
          target_present: true,
          target_contents_match: true,
        },
      });
      await expect(f.confirm(p)).rejects.toThrow(/succeeded/);
      expect(f.writes).toHaveLength(1);
    },
  );

  it.each([
    "organization-open",
    "strict",
    "kill",
    "path",
    "digest",
    "delete-confirm",
  ])("blocks %s before consuming the transfer token", async (gate) => {
    const f = await fixture(),
      p = await f.preview("move");
    if (gate === "organization-open") f.config.writeOrganizationOpen = false;
    if (gate === "strict") f.config.writeConsistencyMode = "strict";
    if (gate === "kill") f.config.writeKillSwitch = true;
    await expect(
      f.changes.confirmChange(
        "employee.a",
        p.change_token,
        gate === "digest" ? "wrong" : p.diff_digest,
        gate !== "delete-confirm",
        gate === "path" ? "wrong" : p.display_path,
      ),
    ).rejects.toThrow();
    expect(f.db.getPendingChange(p.change_token)?.state).toBe("previewed");
    expect(f.writes).toHaveLength(0);
  });

  it("allows copying from a source book that is not separately writable", async () => {
    const f = await fixture();
    const p = await f.preview("copy");
    await expect(f.confirm(p)).resolves.toMatchObject({ state: "succeeded" });
    expect(f.tables.has(12)).toBe(true);
  });

  it.each([
    "source-change",
    "catalog-change",
    "corrupt-copy",
    "copy-timeout",
    "move-timeout",
  ])("stops and reconciles %s without duplicate writes", async (mode) => {
    const f = await fixture(),
      p = await f.preview(mode === "move-timeout" ? "move" : "copy");
    f.behavior.mode = mode;
    if (mode === "source-change")
      f.tables.get(12)!.table.records[0]!.data.text = { value: "concurrent" };
    if (mode === "catalog-change")
      f.catalogs[22]!.push({
        type: "TITLE",
        title: "New directory",
        uuid: "folder",
        parent_uuid: "",
        level: 0,
        visible: 1,
      });
    const state = mode.endsWith("change")
      ? "conflict"
      : mode.endsWith("timeout")
        ? "unknown"
        : "partial";
    await expect(f.confirm(p)).resolves.toMatchObject({
      state,
      automatic_retry_allowed: false,
    });
    const before = f.writes.length;
    await f.status(p);
    await expect(f.confirm(p)).rejects.toThrow();
    expect(f.writes).toHaveLength(before);
    expect(before).toBe(state === "conflict" ? 0 : 1);
  });

  it.each(["same-book", "child", "duplicate-title", "invalid-parent"])(
    "rejects unsupported transfer scope: %s",
    async (mode) => {
      const f = await fixture();
      if (mode === "child")
        f.catalogs[11]!.push({
          type: "TITLE",
          title: "Child",
          uuid: "child",
          parent_uuid: "node-12",
          level: 1,
          visible: 1,
        });
      if (mode === "duplicate-title")
        f.catalogs[22]!.push({
          type: "TITLE",
          title: "Source",
          uuid: "duplicate",
          parent_uuid: "",
          level: 0,
          visible: 1,
        });
      await expect(
        f.client.prepareTableTransfer("employee.a", {
          action: "copy",
          sourceUrl: `${host}/team/book/source`,
          targetBookUrl: `${host}/team/${mode === "same-book" ? "book" : "target-book"}`,
          targetParentUuid: mode === "invalid-parent" ? "missing" : undefined,
        }),
      ).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    },
  );

  it("supports an explicitly selected existing target directory and owner-isolated status", async () => {
    const f = await fixture();
    f.catalogs[22]!.push({
      type: "TITLE",
      title: "Tests",
      uuid: "folder",
      parent_uuid: "",
      level: 0,
      visible: 1,
    });
    const p = await f.changes.previewTableTransfer("employee.a", {
      action: "copy",
      sourceUrl: `${host}/team/book/source`,
      targetBookUrl: `${host}/team/target-book`,
      targetParentUuid: "folder",
    });
    await expect(f.confirm(p)).resolves.toMatchObject({ state: "succeeded" });
    expect(f.writes[0]!.body.target_uuid).toBe("folder");
    await expect(
      f.changes.getTableTransferStatus("employee.b", p.change_token),
    ).rejects.toThrow(/Owner mismatch/);
  });

  it("offers only Excel for organization Tables and polls without reading the file", async () => {
    const f = await fixture();
    await expect(
      f.client.getExportOptions("employee.a", `${host}/team/book/source`),
    ).resolves.toMatchObject({
      targetType: "Table",
      availableFormats: [{ format: "excel" }],
    });
    await expect(
      f.client.createExportLink(
        "employee.a",
        `${host}/team/book/source`,
        "word",
      ),
    ).rejects.toThrow(/cannot be exported/);
    const result = await f.client.createExportLink(
      "employee.a",
      `${host}/team/book/source`,
      "excel",
    );
    expect(result).toMatchObject({
      targetType: "Table",
      format: "excel",
      pollRequests: 2,
      browserLoginRequired: true,
    });
    expect(f.exportBodies).toEqual([
      { type: "excel", force: 0 },
      { type: "excel", force: 0 },
    ]);
    expect(f.downloads).toHaveLength(0);
    expect(() =>
      validateExportUrl({
        rawUrl: "https://untrusted.example/file.xlsx",
        format: "excel",
        targetType: "Table",
        documentOrigin: host,
        ownerSlug: "team",
        bookSlug: "book",
        docSlug: "source",
      }),
    ).toThrow();
  });
});

async function fixture() {
  const model = archiveFixture(),
    behavior = { mode: "normal" };
  const tables = new Map([
    [12, { table: model.source, bookId: 11, slug: "source", title: "Source" }],
  ]);
  const catalogs: Record<number, any[]> = {
    11: [
      {
        type: "DOC",
        title: "Source",
        uuid: "node-12",
        parent_uuid: "",
        level: 0,
        visible: 1,
        doc_id: 12,
        url: "source",
      },
    ],
    22: [],
  };
  let staleSource: any[] | undefined;
  const writes: Array<{ path: string; method: string; body: any }> = [],
    exportBodies: unknown[] = [],
    downloads: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)),
        body = init.body ? JSON.parse(String(init.body)) : {};
      const send = (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/api/mine/books")
        return send({
          data: [
            {
              id: 11,
              slug: "book",
              name: "Book",
              items_count: 1,
              public: 0,
              user: { login: "team" },
            },
            {
              id: 22,
              slug: "target-book",
              name: "Target book",
              items_count: 0,
              public: 0,
              user: { login: "team" },
            },
          ],
        });
      if (url.pathname === "/api/catalog_nodes") {
        const bookId = Number(url.searchParams.get("book_id"));
        if (bookId === 11 && staleSource) {
          const old = staleSource;
          staleSource = undefined;
          return send({ data: old });
        }
        return send({ data: catalogs[bookId] });
      }
      if (url.pathname.startsWith("/api/catalog_nodes/")) {
        writes.push({ path: url.pathname, method: init.method!, body });
        const action = url.pathname.split("/").at(-1),
          original = tables.get(12)!;
        const id = action === "copy" ? 14 : 12,
          slug = action === "copy" ? "copied" : original.slug;
        const transferred = {
          ...original,
          table: structuredClone(original.table),
          bookId: 22,
          slug,
        };
        transferred.table.id = String(id);
        transferred.table.columns.reverse();
        for (const c of transferred.table.columns) c.options?.reverse(); // Native copies may enumerate fields in a different order.
        if (behavior.mode === "corrupt-copy")
          transferred.table.records[0]!.data.text = { value: "corrupted" };
        tables.set(id, transferred);
        if (action === "move") {
          staleSource = structuredClone(catalogs[11]);
          catalogs[11] = [];
        }
        catalogs[22]!.unshift({
          type: "DOC",
          title: "Source",
          uuid: action === "copy" ? "node-14" : "node-12",
          parent_uuid: body.target_uuid ?? "",
          level: body.target_uuid ? 1 : 0,
          visible: 1,
          doc_id: id,
          url: slug,
        });
        if (behavior.mode.endsWith("timeout"))
          throw new TypeError("Network timeout after remote commit");
        return send({ meta: { docIds: [id] }, data: catalogs[11] });
      }
      if (url.pathname.endsWith("/export")) {
        exportBodies.push(body);
        return send({
          data:
            exportBodies.length === 1
              ? { state: "pending" }
              : {
                  state: "success",
                  url: "/attachments/__temp/7/xlsx/fixture.xlsx?filename=fixture.xlsx&attachable_type=Doc&attachable_id=12",
                },
        });
      }
      if (url.pathname.startsWith("/api/docs/")) {
        const doc = [...tables.values()].find(
          (t) => t.slug === url.pathname.split("/").at(-1),
        )!;
        return send({
          data: {
            id: Number(doc.table.id),
            slug: doc.slug,
            title: doc.title,
            book_id: doc.bookId,
            type: "Table",
            format: "laketable",
            draft_version: 1,
            updated_at: "2026-09-20T00:00:00Z",
            abilities: { export: true },
            content: JSON.stringify({
              format: "laketable",
              sheet: [
                {
                  id: doc.table.sheetId,
                  columns: doc.table.columns,
                  views: {
                    grid: { id: "grid", name: "Grid", type: "GRID", data: {} },
                  },
                },
              ],
            }),
          },
        });
      }
      const table = tables.get(
        Number(body.docId ?? url.searchParams.get("docId")),
      )?.table;
      if (url.pathname.endsWith("/show"))
        return send({
          records: table!.records.map((r) => ({
            ...r,
            doc_id: Number(table!.id),
            doc_type: "Doc",
            sheet_id: table!.sheetId,
            data: JSON.stringify(r.data),
          })),
          users: [],
          hasMore: false,
        });
      if (url.pathname.endsWith("/getContent"))
        return send({
          content: Object.fromEntries(
            body.recordIds.map((id: string) => [id, null]),
          ),
        });
      downloads.push(url.href);
      throw new Error("Unexpected request");
    },
  );
  const dataDir = await mkdtemp(join(tmpdir(), "yuque-transfer-test-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32),
    crypto = new CryptoBox(key),
    sessions = new SessionStore(dataDir, crypto);
  await sessions.save("employee.a", {
    cookies: new CookieJar().serializeSync(),
    csrfToken: "fixture",
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
    personalYuqueHost: "https://www.yuque.com",
    organization: "test",
    dataDir,
    databasePath: join(dataDir, "state.db"),
    contractPath: "contracts/yuque-web-2026-08-14.json",
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey: key,
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 1000,
    writeConsistencyMode: "best_effort",
    writeKillSwitch: false,
    writeOrganizationOpen: true,
    allowUnverifiedContracts: false,
  };
  const client = new YuqueWebClient(
    config,
    await ContractRegistry.load(config.contractPath),
    sessions,
    undefined,
    async () => {},
  );
  cleanups.push(() => client.close());
  const db = new AppDatabase(config.databasePath);
  cleanups.push(() => db.close());
  const changes = new ChangeStore(config, db, crypto, client),
    deps = { client, changes } as McpDependencies;
  const preview = (action: "copy" | "move") =>
    callTool(
      "employee.a",
      `yuque_preview_${action}_table`,
      {
        source_doc_url: `${host}/team/book/source`,
        target_book_url: `${host}/team/target-book`,
      },
      deps,
    ) as ReturnType<ChangeStore["previewTableTransfer"]>;
  const confirm = (p: {
    change_token: string;
    diff_digest: string;
    display_path: string;
  }) =>
    callTool(
      "employee.a",
      "yuque_confirm_change",
      {
        change_token: p.change_token,
        diff_digest: p.diff_digest,
        confirmation_text: p.display_path,
        confirm_deletions: true,
      },
      deps,
    );
  const status = (p: { change_token: string }) =>
    callTool(
      "employee.a",
      "yuque_get_table_transfer_status",
      { change_token: p.change_token, reconcile: true },
      deps,
    );
  return {
    client,
    changes,
    db,
    config,
    preview,
    confirm,
    status,
    writes,
    tables,
    catalogs,
    behavior,
    exportBodies,
    downloads,
  };
}
