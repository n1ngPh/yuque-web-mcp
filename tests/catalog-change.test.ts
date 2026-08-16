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

describe("verified personal catalog CRUD", () => {
  it("creates a root group with one insert and one rename then verifies it", async () => {
    const fixture = await createFixture();
    const preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "create",
      title: "yuque-web-mcp-created",
      expectedParentPath: "个人：Alice / yuque-web-mcp-e2e",
    });

    await expect(
      fixture.client.changeCatalog("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "create",
        title: "yuque-web-mcp-created",
        expectedParentPath: "个人：Alice / yuque-web-mcp-e2e",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({
      status: "created",
      display_path: "个人：Alice / yuque-web-mcp-e2e / yuque-web-mcp-created",
    });
    expect(fixture.bodies()).toEqual([
      {
        action: "insert",
        book_id: 44,
        format: "list",
        target_uuid: null,
        type: "TITLE",
      },
      {
        action: "edit",
        book_id: 44,
        format: "list",
        node_uuid: "created-1",
        title: "yuque-web-mcp-created",
      },
    ]);
  });

  it("moves into and after a group, renames it, then deletes it empty", async () => {
    const fixture = await createFixture();

    let preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "move",
      nodeUuid: "child",
      targetUuid: "parent",
      position: "into",
    });
    await expect(
      fixture.client.changeCatalog("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "move",
        nodeUuid: "child",
        targetUuid: "parent",
        position: "into",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({
      status: "moved",
      display_path: "个人：Alice / yuque-web-mcp-e2e / parent / child",
    });

    preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "move",
      nodeUuid: "child",
      targetUuid: "anchor",
      position: "after",
    });
    await fixture.client.changeCatalog("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "move",
      nodeUuid: "child",
      targetUuid: "anchor",
      position: "after",
      baselineFingerprint: preview.baselineFingerprint,
    });

    preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "rename",
      nodeUuid: "child",
      title: "child-renamed",
    });
    await fixture.client.changeCatalog("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "rename",
      nodeUuid: "child",
      title: "child-renamed",
      baselineFingerprint: preview.baselineFingerprint,
    });

    preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "delete",
      nodeUuid: "child",
    });
    await expect(
      fixture.client.changeCatalog("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "delete",
        nodeUuid: "child",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({ status: "deleted" });
    expect(fixture.bodies().map((body) => body.action)).toEqual([
      "prependChild",
      "moveAfter",
      "edit",
      "destroyWithChildren",
    ]);
    expect(fixture.bodies().at(-1)).toMatchObject({ has_child: false });
  });

  it("moves a Doc or Sheet catalog entry into a directory and back to root", async () => {
    const fixture = await createFixture();

    let preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "move",
      nodeUuid: "nested-doc",
      targetUuid: "parent",
      position: "into",
    });
    await expect(
      fixture.client.changeCatalog("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "move",
        nodeUuid: "nested-doc",
        targetUuid: "parent",
        position: "into",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({
      status: "moved",
      display_path: "个人：Alice / yuque-web-mcp-e2e / parent / nested-doc",
    });

    preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "move",
      nodeUuid: "nested-doc",
      targetUuid: "anchor",
      position: "after",
    });
    await expect(
      fixture.client.changeCatalog("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "move",
        nodeUuid: "nested-doc",
        targetUuid: "anchor",
        position: "after",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({
      status: "moved",
      display_path: "个人：Alice / yuque-web-mcp-e2e / nested-doc",
    });
    expect(fixture.bodies()).toEqual([
      expect.objectContaining({
        action: "prependChild",
        node_uuid: "nested-doc",
        target_uuid: "parent",
      }),
      expect.objectContaining({
        action: "moveAfter",
        node_uuid: "nested-doc",
        target_uuid: "anchor",
      }),
    ]);
  });

  it("keeps Doc and Sheet rename or deletion behind dedicated tools", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.client.prepareCatalogChange("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "rename",
        nodeUuid: "nested-doc",
        title: "renamed-doc",
      }),
    ).rejects.toThrow("rename is restricted to directory TITLE nodes");
    await expect(
      fixture.client.prepareCatalogChange("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "delete",
        nodeUuid: "nested-doc",
      }),
    ).rejects.toThrow("dedicated Doc or Sheet deletion Preview");
    expect(fixture.bodies()).toHaveLength(0);
  });

  it("blocks non-empty deletion and stale previews before a write", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.client.prepareCatalogChange("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "delete",
        nodeUuid: "nonempty",
      }),
    ).rejects.toThrow("Non-empty directory deletion is disabled");
    const preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "rename",
      nodeUuid: "child",
      title: "child-renamed",
    });
    fixture.externalRename();
    await expect(
      fixture.client.changeCatalog("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "rename",
        nodeUuid: "child",
        title: "child-renamed",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).rejects.toThrow("changed after Preview");
    expect(fixture.bodies()).toHaveLength(0);
  });

  it("reconciles delayed directory deletion with read-only polling", async () => {
    const fixture = await createFixture({ delayedDeleteReads: 2 });
    const preview = await fixture.client.prepareCatalogChange("employee.a", {
      bookUrl: fixture.bookUrl,
      action: "delete",
      nodeUuid: "child",
    });

    await expect(
      fixture.client.changeCatalog("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "delete",
        nodeUuid: "child",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({ status: "deleted" });
    expect(fixture.bodies()).toHaveLength(1);
    expect(fixture.bodies()[0]).toMatchObject({
      action: "destroyWithChildren",
      node_uuid: "child",
    });
  });
});

async function createFixture(
  options: { delayedDeleteReads?: number } = {},
): Promise<{
  client: YuqueWebClient;
  bookUrl: string;
  bodies: () => Array<Record<string, unknown>>;
  externalRename: () => void;
}> {
  let sequence = 0;
  let nodes = initialNodes();
  let pendingDeletionUuid: string | undefined;
  let pendingDeleteReads = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/mine/personal_books") {
      return response.end(JSON.stringify({ data: [bookFixture()] }));
    }
    if (url.pathname === "/api/catalog_nodes" && request.method === "GET") {
      if (pendingDeletionUuid) {
        if (pendingDeleteReads > 0) pendingDeleteReads -= 1;
        else {
          nodes = nodes.filter((node) => node.uuid !== pendingDeletionUuid);
          pendingDeletionUuid = undefined;
        }
      }
      return response.end(JSON.stringify({ data: nodes }));
    }
    if (url.pathname === "/api/catalog_nodes" && request.method === "PUT") {
      void readJsonBody(request).then((body) => {
        bodies.push(body);
        const action = body.action;
        if (action === "insert") {
          sequence += 1;
          nodes = [
            rawNode({
              uuid: `created-${String(sequence)}`,
              title: "无标题",
              parentUuid:
                typeof body.target_uuid === "string"
                  ? body.target_uuid
                  : undefined,
            }),
            ...nodes,
          ];
        } else if (action === "edit") {
          nodes = nodes.map((node) =>
            node.uuid === body.node_uuid
              ? { ...node, title: body.title }
              : node,
          );
        } else if (action === "prependChild" || action === "moveAfter") {
          const target = nodes.find((node) => node.uuid === body.target_uuid);
          const moving = nodes.find((node) => node.uuid === body.node_uuid);
          if (!target || !moving) throw new Error("Missing test move node");
          const without = nodes.filter((node) => node.uuid !== moving.uuid);
          const targetIndex = without.findIndex(
            (node) => node.uuid === target.uuid,
          );
          const changed = {
            ...moving,
            parent_uuid:
              action === "prependChild"
                ? target.uuid
                : target.parent_uuid || null,
            level:
              action === "prependChild"
                ? Number(target.level) + 1
                : Number(target.level),
          };
          without.splice(targetIndex + 1, 0, changed);
          nodes = without;
        } else if (action === "destroyWithChildren") {
          if (options.delayedDeleteReads) {
            pendingDeletionUuid = String(body.node_uuid);
            pendingDeleteReads = options.delayedDeleteReads;
          } else {
            nodes = nodes.filter((node) => node.uuid !== body.node_uuid);
          }
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
  const directory = await mkdtemp(join(tmpdir(), "yuque-catalog-test-"));
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
    testConfig(directory, contractPath, origin, bookUrl),
    await ContractRegistry.load(contractPath),
    sessions,
  );
  return {
    client,
    bookUrl,
    bodies: () => bodies,
    externalRename: () => {
      nodes = nodes.map((node) =>
        node.uuid === "parent" ? { ...node, title: "external" } : node,
      );
    },
  };
}

function initialNodes(): Array<Record<string, unknown>> {
  return [
    rawNode({ uuid: "parent", title: "parent" }),
    rawNode({ uuid: "child", title: "child" }),
    rawNode({ uuid: "anchor", title: "anchor", type: "DOC", docId: 91 }),
    rawNode({ uuid: "nonempty", title: "nonempty" }),
    rawNode({
      uuid: "nested-doc",
      title: "nested-doc",
      type: "DOC",
      docId: 92,
      parentUuid: "nonempty",
      level: 1,
    }),
  ];
}

function rawNode(input: {
  uuid: string;
  title: string;
  type?: "TITLE" | "DOC";
  docId?: number;
  parentUuid?: string;
  level?: number;
}): Record<string, unknown> {
  return {
    uuid: input.uuid,
    type: input.type ?? "TITLE",
    title: input.title,
    parent_uuid: input.parentUuid ?? null,
    level: input.level ?? 0,
    visible: 1,
    doc_id: input.docId ?? null,
    url: input.docId ? `doc-${String(input.docId)}` : null,
  };
}

function bookFixture(): Record<string, unknown> {
  return {
    id: 44,
    name: "yuque-web-mcp-e2e",
    description: "sandbox",
    slug: "abc123",
    type: "Book",
    public: 0,
    extend_private: 0,
    organization_id: 0,
    user_id: 7,
    items_count: 2,
    updated_at: "2026-08-16T00:00:00.000Z",
    user: { login: "alice", type: "User" },
  };
}

function contractFixture(): Record<string, unknown> {
  return {
    version: "catalog-test",
    verifiedAt: "2026-08-16T00:00:00.000Z",
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
        capability: "get_toc",
        verified: true,
        verifiedHostTypes: ["personal"],
        method: "GET",
        path: "/api/catalog_nodes",
        idempotent: true,
        requiredResponsePaths: ["data"],
      },
      {
        capability: "change_catalog",
        verified: true,
        verifiedHostTypes: ["personal"],
        method: "PUT",
        path: "/api/catalog_nodes",
        deletionEffect: "catalog_node",
        targetResourceType: "CatalogNode",
        idempotent: false,
        liveWriteEnabled: true,
        requiredResponsePaths: ["data", "meta.book_id", "meta.toc_updated_at"],
      },
    ],
  };
}

function testConfig(
  dataDir: string,
  contractPath: string,
  personalHost: string,
  bookUrl: string,
): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: personalHost,
    personalYuqueHost: personalHost,
    organization: "",
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
    writeBookAllowlist: [bookUrl],
    allowObjectDeletion: true,
  };
}

async function readJsonBody(
  request: NodeJS.ReadableStream,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as Record<string, unknown>;
}
