import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";
import type { AppConfig } from "../src/config.js";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import {
  YuqueHttpError,
  YuqueWebClient,
  type PreparedBookDeletion,
  type PreparedObjectDeletion,
} from "../src/yuque-client.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("whole-object deletion HTTP client", () => {
  it.each([
    { resourceType: "Doc" as const, id: 77, capability: "delete_doc" },
    { resourceType: "Sheet" as const, id: 88, capability: "delete_sheet" },
  ])(
    "sends one typed $resourceType catalog transaction and verifies read-back",
    async ({ resourceType, id, capability }) => {
      const observed: Array<{
        method: string;
        path: string;
        body: Record<string, unknown>;
        headers: Record<string, string | string[] | undefined>;
      }> = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        observed.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body,
          headers: request.headers,
        });
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            data: [],
            meta: {
              book_id: 44,
              node_uuid: `${resourceType.toLowerCase()}-node`,
              toc_updated_at: "2026-08-16T00:00:00.000Z",
              deletedDocIds: [id],
            },
          }),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      cleanups.push(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const origin = `http://127.0.0.1:${address.port}`;
      const directory = await mkdtemp(join(tmpdir(), "yuque-delete-client-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const contractPath = join(directory, "contract.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          version: "delete-client-test",
          verifiedAt: "2026-08-16T00:00:00.000Z",
          sourceBundles: [],
          endpoints: [
            destructiveContract("delete_doc", "doc_object", "Doc"),
            destructiveContract("delete_sheet", "sheet_object", "Sheet"),
          ],
        }),
      );
      const bookUrl = `${origin}/alice/book`;
      const config = testConfig(directory, contractPath, origin, bookUrl);
      const sessions = new SessionStore(
        directory,
        new CryptoBox(randomBytes(32)),
        "employee.a",
      );
      await sessions.save("employee.a", {
        cookies: new CookieJar().serializeSync(),
        csrfToken: "csrf-token",
        account: { id: "1", login: "alice", name: "Alice" },
        savedAt: new Date().toISOString(),
      });
      const client = new YuqueWebClient(
        config,
        await ContractRegistry.load(contractPath),
        sessions,
      );
      const prepared = preparedDeletion(
        origin,
        resourceType,
        id,
        `${resourceType.toLowerCase()}-node`,
      );
      client.prepareObjectDeletion = vi.fn(async () => prepared);
      client.getToc = vi.fn(async () => ({ book: prepared.book, nodes: [] }));
      if (resourceType === "Doc") {
        client.getDoc = vi.fn(async () => {
          throw new YuqueHttpError(404, "not found");
        });
      } else {
        client.getSheet = vi.fn(async () => {
          throw new YuqueHttpError(404, "not found");
        });
      }

      await expect(
        client.deleteObject("employee.a", {
          docUrl: prepared.targetUrl,
          resourceType,
          baselineFingerprint: prepared.baseFingerprint,
        }),
      ).resolves.toMatchObject({
        status: "trashed",
        resource_type: resourceType,
        doc_id: String(id),
        catalog_absent: true,
        direct_read_rejected: true,
        reconciled_after_unknown_response: false,
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        method: "PUT",
        path: "/api/catalog_nodes",
        body: {
          action: "destroyWithChildren",
          book_id: 44,
          format: "list",
          has_child: false,
          node_uuid: `${resourceType.toLowerCase()}-node`,
        },
      });
      expect(observed[0]?.headers).toMatchObject({
        origin,
        referer: prepared.targetUrl,
        "x-csrf-token": "csrf-token",
        "x-login": "alice",
        "x-requested-with": "XMLHttpRequest",
      });
      expect(capability).toBe(
        resourceType === "Doc" ? "delete_doc" : "delete_sheet",
      );
    },
  );

  it("rejects a deletion response that reports another document ID", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [],
          meta: {
            book_id: 44,
            node_uuid: "doc-node",
            toc_updated_at: "2026-08-16T00:00:00.000Z",
            deletedDocIds: [999],
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const origin = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), "yuque-delete-client-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "delete-client-test",
        verifiedAt: "2026-08-16T00:00:00.000Z",
        sourceBundles: [],
        endpoints: [destructiveContract("delete_doc", "doc_object", "Doc")],
      }),
    );
    const bookUrl = `${origin}/alice/book`;
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf-token",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin, bookUrl),
      await ContractRegistry.load(contractPath),
      sessions,
    );
    const prepared = preparedDeletion(origin, "Doc", 77, "doc-node");
    client.prepareObjectDeletion = vi.fn(async () => prepared);
    await expect(
      client.deleteObject("employee.a", {
        docUrl: prepared.targetUrl,
        resourceType: "Doc",
        baselineFingerprint: prepared.baseFingerprint,
      }),
    ).rejects.toThrow("unexpected document set");
  });

  it("sends one irreversible non-empty knowledge-base DELETE and reconciles the personal list", async () => {
    const observed: Array<{ method: string; path: string }> = [];
    const server = createServer((request, response) => {
      observed.push({ method: request.method ?? "", path: request.url ?? "" });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            id: 44,
            slug: "book",
            name: "Book",
            type: "Book",
            organization_id: 0,
            public: 0,
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const origin = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(
      join(tmpdir(), "yuque-book-delete-client-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "book-delete-client-test",
        verifiedAt: "2026-08-16T00:00:00.000Z",
        sourceBundles: [],
        endpoints: [
          {
            capability: "delete_book",
            verified: true,
            observedHostTypes: ["personal"],
            verifiedHostTypes: ["personal"],
            liveWriteEnabled: true,
            method: "DELETE",
            path: "/api/books/{bookId}",
            deletionEffect: "knowledge_base",
            targetResourceType: "KnowledgeBase",
            idempotent: false,
            requiredResponsePaths: [
              "data.id",
              "data.slug",
              "data.name",
              "data.type",
              "data.organization_id",
              "data.public",
            ],
          },
        ],
      }),
    );
    const bookUrl = `${origin}/alice/book`;
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf-token",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin, bookUrl),
      await ContractRegistry.load(contractPath),
      sessions,
    );
    const prepared: PreparedBookDeletion = {
      book: preparedDeletion(origin, "Doc", 77, "doc-node").book,
      catalog: [preparedDeletion(origin, "Doc", 77, "doc-node").node],
      displayPath: "个人：Alice / Book",
      baseFingerprint: "book-delete-base",
      allowNonempty: true,
    };
    client.prepareBookDeletion = vi.fn(async () => prepared);
    client.listAllBooks = vi.fn(async () => []);
    client.getBook = vi.fn(async () => {
      throw new Error("not found");
    });

    await expect(
      client.deleteBook("employee.a", {
        bookUrl,
        allowNonempty: true,
        baselineFingerprint: prepared.baseFingerprint,
      }),
    ).resolves.toMatchObject({
      status: "deleted",
      deletion_effect: "irreversible_book_removal",
      deleted_catalog_nodes: 1,
      list_absent: true,
      direct_read_rejected: true,
    });
    expect(observed).toEqual([{ method: "DELETE", path: "/api/books/44" }]);
  });
});

function destructiveContract(
  capability: "delete_doc" | "delete_sheet",
  deletionEffect: "doc_object" | "sheet_object",
  targetResourceType: "Doc" | "Sheet",
) {
  return {
    capability,
    verified: true,
    observedHostTypes: ["personal"],
    verifiedHostTypes: ["personal"],
    liveWriteEnabled: true,
    method: "PUT",
    path: "/api/catalog_nodes",
    deletionEffect,
    targetResourceType,
    idempotent: false,
    requiredResponsePaths: [
      "data",
      "meta.book_id",
      "meta.node_uuid",
      "meta.toc_updated_at",
      "meta.deletedDocIds",
    ],
  };
}

function preparedDeletion(
  origin: string,
  resourceType: "Doc" | "Sheet",
  id: number,
  nodeUuid: string,
): PreparedObjectDeletion {
  const bookUrl = `${origin}/alice/book`;
  const targetUrl = `${bookUrl}/${resourceType.toLowerCase()}`;
  const displayPath = `个人：Alice / Book / ${resourceType}`;
  return {
    resourceType,
    book: {
      id: 44,
      name: "Book",
      description: "sandbox",
      slug: "book",
      groupLogin: "alice",
      url: bookUrl,
      itemsCount: 1,
      scopeId: "personal",
      scopeType: "personal",
      scopeName: "Alice",
      scopeLabel: "个人：Alice",
      host: origin,
      ownerType: "User",
      ownerLogin: "alice",
      accessType: "owner",
      role: "owner",
      private: true,
    },
    node: {
      type: "DOC",
      title: resourceType,
      uuid: nodeUuid,
      level: 0,
      order: 0,
      visible: true,
      path: [resourceType],
      fullPath: ["个人：Alice", "Book", resourceType],
      displayPath,
      docId: id,
      docSlug: resourceType.toLowerCase(),
      docUrl: targetUrl,
    },
    targetUrl,
    displayPath,
    baseFingerprint: `${resourceType.toLowerCase()}-base`,
    version: 1,
  };
}

function testConfig(
  directory: string,
  contractPath: string,
  origin: string,
  bookUrl: string,
): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: origin,
    personalYuqueHost: origin,
    organization: "",
    dataDir: directory,
    databasePath: join(directory, "state.db"),
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
    allowPermissionChanges: false,
    writeBookAllowlist: [bookUrl],
  };
}
