import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";
import type { AppConfig } from "../src/config.js";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { YuqueWebClient } from "../src/yuque-client.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("file import", () => {
  it("imports a markdown file and returns the Doc without relocation", async () => {
    const fixture = await createFixture();
    const result = await fixture.client.importFile("employee.a", {
      bookUrl: fixture.bookUrl,
      fileType: "markdown",
      fileName: "report.md",
      content: Buffer.from("# Hello\n\nWorld", "utf8"),
    });
    expect(result.status).toBe("success");
    expect(result.format).toBe("lake");
    expect(result.slug).toBe("imported-slug");
    expect(result.url).toBe("http://127.0.0.1/alice/abc123/imported-slug");
    expect(result.displayPath).toBeUndefined();

    const imported = fixture.importBodies()[0]!;
    expect(imported).toBeDefined();
    expect(imported.book_id).toBe("44");
    expect(imported.type).toBe("markdown");
    expect(imported.import_type).toBe("create");
    expect(imported.action).toBe("prependChild");
    expect(imported.insert_to_catalog).toBe("true");
    expect(imported.filename).toBe("file");
    expect(imported.options).toBe('{"enableLatex":1}');
    expect(imported.fileName).toBe("report.md");
  });

  it("imports and relocates into parent_uuid via the catalog move", async () => {
    const fixture = await createFixture();
    const result = await fixture.client.importFile("employee.a", {
      bookUrl: fixture.bookUrl,
      fileType: "excel",
      fileName: "data.xlsx",
      content: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      parentUuid: "target-dir",
    });
    expect(result.status).toBe("success");
    expect(result.format).toBe("lakesheet");
    expect(result.displayPath).toContain("target-dir");

    const moves = fixture
      .catalogBodies()
      .filter(
        (body) =>
          body.action === "prependChild" && body.target_uuid === "target-dir",
      );
    expect(moves).toHaveLength(1);
    expect(moves[0]!.node_uuid).toBe("imported-node");
  });

  it("rejects organization catalog create/rename/delete but allows move", async () => {
    const fixture = await createFixture({ organization: true });
    await expect(
      fixture.client.prepareCatalogChange("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "create",
        title: "new-group",
      }),
    ).rejects.toThrow(/organization spaces support document moves only/i);
    await expect(
      fixture.client.prepareCatalogChange("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "rename",
        nodeUuid: "imported-node",
        title: "renamed",
      }),
    ).rejects.toThrow(/organization spaces support document moves only/i);
    const preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "move",
      nodeUuid: "imported-node",
      targetUuid: "target-dir",
      position: "into",
    });
    expect(preview.action).toBe("move");
  });
});

interface Fixture {
  client: YuqueWebClient;
  bookUrl: string;
  importBodies: () => Array<Record<string, string>>;
  catalogBodies: () => Array<Record<string, unknown>>;
}

async function createFixture(
  options: { organization?: boolean } = {},
): Promise<Fixture> {
  let importedNodeUuid = "imported-node";
  const importBodies: Array<Record<string, string>> = [];
  const catalogBodies: Array<Record<string, unknown>> = [];
  let nodes = initialNodes();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (
      url.pathname === "/api/mine/personal_books" ||
      url.pathname === "/api/mine/books"
    ) {
      return response.end(JSON.stringify({ data: [bookFixture(options)] }));
    }
    if (url.pathname === "/api/catalog_nodes" && request.method === "GET") {
      return response.end(JSON.stringify({ data: nodes }));
    }
    if (url.pathname === "/api/catalog_nodes" && request.method === "PUT") {
      void readJsonBody(request).then((body) => {
        catalogBodies.push(body);
        const action = body.action as string;
        if (action === "prependChild" || action === "moveAfter") {
          nodes = nodes.map((node) =>
            node.uuid === body.node_uuid
              ? {
                  ...node,
                  parent_uuid:
                    action === "prependChild" ? body.target_uuid : null,
                  level: action === "prependChild" ? 1 : 0,
                }
              : node,
          );
        }
        response.end(
          JSON.stringify({
            data: nodes,
            meta: {
              book_id: 44,
              deletedDocIds: [],
              toc_updated_at: new Date().toISOString(),
            },
          }),
        );
      });
      return;
    }
    if (url.pathname === "/api/import" && request.method === "POST") {
      void readBody(request).then((buffer) => {
        const fields = parseMultipartFields(buffer);
        importBodies.push(fields);
        const fileType = fields["type"] ?? "markdown";
        response.end(
          JSON.stringify({
            data: {
              id: 99,
              type: fileType === "markdown" ? "Doc" : "doc",
              status: fileType === "markdown" ? undefined : "pending",
            },
          }),
        );
      });
      return;
    }
    if (url.pathname === "/api/import/result" && request.method === "POST") {
      void readJsonBody(request).then((body) => {
        const files = JSON.parse(String(body.files)) as Array<{
          id: number;
          type: string;
          name: string;
        }>;
        const file = files[0]!;
        const format = body.format === "excel" ? "lakesheet" : "lake";
        response.end(
          JSON.stringify({
            data: [
              {
                id: file.id,
                type: file.type,
                status: "success",
                slug: "imported-slug",
                format,
                title: file.name.replace(/\.[^.]+$/, ""),
                url: "http://127.0.0.1/alice/abc123/imported-slug",
              },
            ],
          }),
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const origin = `http://127.0.0.1:${address.port}`;
  const bookUrl = `${origin}/alice/abc123`;
  const directory = await mkdtemp(join(tmpdir(), "yuque-import-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(contractPath, JSON.stringify(contractFixture()));
  const sessions = new SessionStore(
    directory,
    new CryptoBox(randomBytes(32)),
    "employee.a",
  );
  await sessions.save("employee.a", {
    cookies: new CookieJar().serializeSync(),
    csrfToken: "csrf",
    account: { id: "7", login: "alice", name: "Alice" },
    savedAt: new Date().toISOString(),
  });
  const client = new YuqueWebClient(
    testConfig(directory, contractPath, origin, bookUrl, options),
    await ContractRegistry.load(contractPath),
    sessions,
  );
  return {
    client,
    bookUrl,
    importBodies: () => importBodies,
    catalogBodies: () => catalogBodies,
  };
}

function initialNodes(): Array<Record<string, unknown>> {
  return [
    rawNode({ uuid: "target-dir", title: "target-dir" }),
    rawNode({
      uuid: "imported-node",
      title: "imported",
      type: "DOC",
      docId: 99,
    }),
  ];
}

function rawNode(input: {
  uuid: string;
  title: string;
  type?: "TITLE" | "DOC";
  docId?: number;
}): Record<string, unknown> {
  return {
    uuid: input.uuid,
    type: input.type ?? "TITLE",
    title: input.title,
    parent_uuid: null,
    level: 0,
    visible: 1,
    doc_id: input.docId ?? null,
    url: input.docId ? `doc-${String(input.docId)}` : null,
  };
}

function bookFixture(options: {
  organization?: boolean;
}): Record<string, unknown> {
  return {
    id: 44,
    name: "yuque-web-mcp-e2e",
    description: "sandbox",
    slug: "abc123",
    type: "Book",
    public: 0,
    extend_private: 0,
    organization_id: options.organization ? 16074057 : 0,
    user_id: 7,
    items_count: 2,
    updated_at: "2026-08-26T00:00:00.000Z",
    user: { login: "alice", type: "User" },
  };
}

function contractFixture(): Record<string, unknown> {
  return {
    version: "import-test",
    verifiedAt: "2026-08-26T00:00:00.000Z",
    sourceBundles: [],
    endpoints: [
      {
        capability: "list_personal_books",
        verified: true,
        verifiedHostTypes: ["personal"],
        method: "GET",
        path: "/api/mine/personal_books",
        idempotent: true,
        requiredResponsePaths: ["data"],
      },
      {
        capability: "list_books",
        verified: true,
        verifiedHostTypes: ["organization"],
        method: "GET",
        path: "/api/mine/books",
        idempotent: true,
        requiredResponsePaths: ["data"],
      },
      {
        capability: "get_toc",
        verified: true,
        verifiedHostTypes: ["personal", "organization"],
        method: "GET",
        path: "/api/catalog_nodes",
        idempotent: true,
        requiredResponsePaths: ["data"],
      },
      {
        capability: "change_catalog",
        verified: true,
        verifiedHostTypes: ["personal", "organization"],
        method: "PUT",
        path: "/api/catalog_nodes",
        deletionEffect: "catalog_node",
        targetResourceType: "CatalogNode",
        idempotent: false,
        liveWriteEnabled: true,
        liveWriteHostTypes: ["personal", "organization"],
        requiredResponsePaths: ["data", "meta.book_id", "meta.toc_updated_at"],
      },
      {
        capability: "import",
        verified: true,
        verifiedHostTypes: ["personal", "organization"],
        liveWriteEnabled: true,
        liveWriteHostTypes: ["personal", "organization"],
        method: "POST",
        path: "/api/import",
        idempotent: false,
        requiredResponsePaths: ["data.id"],
      },
      {
        capability: "import_result",
        verified: true,
        verifiedHostTypes: ["personal", "organization"],
        method: "POST",
        path: "/api/import/result",
        idempotent: false,
        requiredResponsePaths: ["data"],
      },
    ],
  };
}

function testConfig(
  dataDir: string,
  contractPath: string,
  host: string,
  bookUrl: string,
  options: { organization?: boolean },
): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: host,
    personalYuqueHost: host,
    organization: options.organization ? "Example Organization" : "",
    dataDir,
    databasePath: join(dataDir, "state.db"),
    contractPath,
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey: randomBytes(32),
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 1_000,
    writeConsistencyMode: "best_effort",
    allowUnverifiedContracts: false,
    allowObjectDeletion: true,
    writeOrganizationOpen: options.organization === true,
    writePersonalOpen: true,
  };
}

function parseMultipartFields(body: Buffer): Record<string, string> {
  const text = body.toString("latin1");
  const fields: Record<string, string> = {};
  const re = /name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    fields[match[1]!] = match[2]!;
  }
  const fileMatch = /name="file"; filename="([^"]+)"/.exec(text);
  if (fileMatch) fields.fileName = fileMatch[1]!;
  return fields;
}

function readBody(
  request: import("node:http").IncomingMessage,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  return readBody(request).then(
    (buffer) => JSON.parse(buffer.toString("utf8")) as Record<string, unknown>,
  );
}
