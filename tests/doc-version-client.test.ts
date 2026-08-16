import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CookieJar } from "tough-cookie";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { YuqueWebClient } from "../src/yuque-client.js";
import type { AppConfig } from "../src/config.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("personal Doc version client", () => {
  it("lists and reads a version with the captured query contract", async () => {
    const observed: Array<{ path: string; query: Record<string, string> }> = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/personal_books") {
        return response.end(
          JSON.stringify({
            data: [
              {
                id: 44,
                slug: "yuque-web-mcp-e2e",
                name: "yuque-web-mcp-e2e",
                description: "sandbox",
                items_count: 1,
                public: 0,
                user: { login: "alice", type: "User" },
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/docs/version-doc") {
        return response.end(JSON.stringify({ data: docFixture() }));
      }
      if (
        url.pathname === "/api/docs/alice/yuque-web-mcp-e2e/version-doc/text"
      ) {
        return response.end(
          JSON.stringify({
            data: { title: "version doc", content: "current body" },
          }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        return response.end(
          JSON.stringify({
            data: [
              {
                type: "DOC",
                title: "version doc",
                uuid: "version-node",
                parent_uuid: "",
                level: 0,
                visible: 1,
                doc_id: 77,
                url: "version-doc",
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/doc_versions") {
        observed.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        });
        return response.end(
          JSON.stringify({
            data: [
              versionSummary(),
              { ...versionSummary(), id: 902, name: "release-candidate" },
            ],
          }),
        );
      }
      if (url.pathname === "/api/doc_versions/901") {
        observed.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        });
        return response.end(
          JSON.stringify({
            data: {
              ...versionSummary(),
              doc_type: "Doc",
              format: "lake",
              slug: "version-doc",
              content: lake("historical body"),
              content_html: "<p>historical body</p>",
            },
          }),
        );
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
    if (!address || typeof address === "string") {
      throw new Error("No test server address");
    }

    const directory = await mkdtemp(join(tmpdir(), "yuque-version-client-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const origin = `http://127.0.0.1:${address.port}`;
    const bookUrl = `${origin}/alice/yuque-web-mcp-e2e`;
    const docUrl = `${bookUrl}/version-doc`;
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "doc-version-client-test",
        verifiedAt: "2026-08-16T00:00:00.000Z",
        sourceBundles: [],
        endpoints: [
          endpoint("list_personal_books", "/api/mine/personal_books", ["data"]),
          endpoint("get_doc", "/api/docs/{docSlug}", [
            "data.id",
            "data.content",
          ]),
          endpoint(
            "get_doc_text",
            "/api/docs/{groupSlug}/{bookSlug}/{docSlug}/text",
            ["data.title", "data.content"],
          ),
          endpoint("get_toc", "/api/catalog_nodes", ["data"]),
          endpoint("list_doc_versions", "/api/doc_versions", ["data"]),
          endpoint("get_doc_version", "/api/doc_versions/{versionId}", [
            "data.id",
            "data.doc_id",
            "data.content",
          ]),
        ],
      }),
    );
    const config = testConfig(directory, contractPath, origin, bookUrl);
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "alice", name: "Alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      config,
      await ContractRegistry.load(contractPath),
      sessions,
    );

    const listedVersions = await client.listDocVersions(
      "employee.a",
      docUrl,
      0,
      25,
    );
    expect(listedVersions).toMatchObject({
      doc: {
        location: {
          displayPath: "个人：Alice / yuque-web-mcp-e2e / version doc",
        },
      },
      offset: 0,
      limit: 25,
      hasMore: false,
      versions: [
        {
          id: "901",
          docId: "77",
          released: true,
          authorLogin: "alice",
        },
        {
          id: "902",
          name: "release-candidate",
          versionUrl: `${origin}/r/doc_versions/902`,
        },
      ],
    });
    expect(listedVersions.versions[0]).not.toHaveProperty("versionUrl");
    await expect(
      client.getDocVersion("employee.a", docUrl, "901"),
    ).resolves.toMatchObject({
      version: {
        id: "901",
        docId: "77",
        plainText: "historical body",
        format: "lake",
      },
    });
    expect(observed).toEqual([
      {
        path: "/api/doc_versions",
        query: {
          doc_id: "77",
          doc_type: "Doc",
          offset: "0",
          limit: "25",
        },
      },
      {
        path: "/api/doc_versions/901",
        query: { doc_id: "77" },
      },
    ]);
    await expect(
      client.getDocVersion("employee.a", docUrl, "not-an-id"),
    ).rejects.toThrow("positive numeric identifier");
  });
});

function docFixture(): Record<string, unknown> {
  return {
    id: 77,
    title: "version doc",
    slug: "version-doc",
    book_id: 44,
    content: lake("current body"),
    format: "lake",
    type: "Doc",
    draft_version: 3,
    updated_at: "2026-08-16T00:00:00.000Z",
  };
}

function versionSummary(): Record<string, unknown> {
  return {
    id: 901,
    doc_id: 77,
    title: "version doc",
    name: null,
    created_at: "2026-08-16T00:00:00.000Z",
    draft: false,
    isReleased: true,
    publication_status: 1,
    user: { id: 1, login: "alice", name: "Alice" },
  };
}

function lake(text: string): string {
  return `<!doctype lake><p>${text}</p>`;
}

function endpoint(
  capability: string,
  path: string,
  requiredResponsePaths: string[],
): Record<string, unknown> {
  return {
    capability,
    verified: true,
    verifiedHostTypes: ["personal"],
    method: "GET",
    path,
    idempotent: true,
    requiredResponsePaths,
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
    requestTimeoutMs: 2_000,
    writeConsistencyMode: "strict",
    allowUnverifiedContracts: false,
    allowObjectDeletion: false,
    allowPermissionChanges: false,
    writeBookAllowlist: [bookUrl],
  };
}
