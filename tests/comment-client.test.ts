import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
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

interface CommentFixture {
  id: number;
  parent_id: number | null;
  root_id: number | null;
  body: string;
  body_asl: string;
  format: "lake";
  created_at: string;
  updated_at: string;
  user: { id: number; login: string; name: string };
  sub_comments: CommentFixture[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("personal Doc comment client", () => {
  it("lists nested comments and performs one-shot own-comment create/update/delete", async () => {
    const comments = [
      comment(10, "alice", "baseline", [comment(11, "peer", "reply")]),
    ];
    let nextId = 12;
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
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
      if (url.pathname === "/api/docs/comment-doc") {
        return response.end(
          JSON.stringify({
            data: {
              id: 77,
              title: "comment doc",
              slug: "comment-doc",
              book_id: 44,
              content: lake("doc body"),
              format: "lake",
              type: "Doc",
              draft_version: 3,
              updated_at: "2026-08-16T00:00:00.000Z",
            },
          }),
        );
      }
      if (
        url.pathname === "/api/docs/alice/yuque-web-mcp-e2e/comment-doc/text"
      ) {
        return response.end(
          JSON.stringify({
            data: { title: "comment doc", content: "doc body" },
          }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        return response.end(
          JSON.stringify({
            data: [
              {
                type: "DOC",
                title: "comment doc",
                uuid: "doc-node",
                parent_uuid: "",
                level: 0,
                visible: 1,
                doc_id: 77,
                url: "comment-doc",
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/docs/convert") {
        const body = await jsonBody(request);
        return response.end(
          JSON.stringify({ data: { content: lake(String(body.content)) } }),
        );
      }
      if (url.pathname === "/api/comments/floor" && request.method === "GET") {
        return response.end(
          JSON.stringify({
            data: {
              comments,
              meta: {
                commentCount: flatten(comments).length,
                hasMore: false,
                lastId: null,
                rootTotal: comments.length,
                total: flatten(comments).length,
              },
            },
          }),
        );
      }
      if (url.pathname === "/api/comments" && request.method === "POST") {
        methods.push("POST");
        const body = await jsonBody(request);
        const created = comment(nextId++, "alice", "");
        created.body = String(body.body);
        created.body_asl = String(body.body_asl);
        comments.push(created);
        return response.end(JSON.stringify({ data: created }));
      }
      const match = url.pathname.match(/^\/api\/comments\/(\d+)$/);
      if (match && request.method === "PUT") {
        methods.push("PUT");
        const body = await jsonBody(request);
        const current = flatten(comments).find(
          (entry) => entry.id === Number(match[1]),
        );
        if (!current) return notFound(response);
        current.body = String(body.body);
        current.body_asl = String(body.body_asl);
        current.updated_at = "2026-08-16T00:01:00.000Z";
        return response.end(JSON.stringify({ data: current }));
      }
      if (match && request.method === "DELETE") {
        methods.push("DELETE");
        const id = Number(match[1]);
        const index = comments.findIndex((entry) => entry.id === id);
        if (index < 0) return notFound(response);
        const [removed] = comments.splice(index, 1);
        return response.end(
          JSON.stringify({
            data: {
              ...removed,
              deleted_at: "2026-08-16T00:02:00.000Z",
            },
          }),
        );
      }
      notFound(response);
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

    const directory = await mkdtemp(join(tmpdir(), "yuque-comment-client-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const origin = `http://127.0.0.1:${address.port}`;
    const bookUrl = `${origin}/alice/yuque-web-mcp-e2e`;
    const docUrl = `${bookUrl}/comment-doc`;
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "comment-client-test",
        verifiedAt: "2026-08-16T00:00:00.000Z",
        sourceBundles: [],
        endpoints: [
          endpoint("list_personal_books", "GET", "/api/mine/personal_books", [
            "data",
          ]),
          endpoint("get_doc", "GET", "/api/docs/{docSlug}", [
            "data.id",
            "data.content",
          ]),
          endpoint(
            "get_doc_text",
            "GET",
            "/api/docs/{groupSlug}/{bookSlug}/{docSlug}/text",
            ["data.title", "data.content"],
          ),
          endpoint("get_toc", "GET", "/api/catalog_nodes", ["data"]),
          endpoint("convert_markdown", "POST", "/api/docs/convert", [
            "data.content",
          ]),
          endpoint("list_comments", "GET", "/api/comments/floor", [
            "data.comments",
            "data.meta",
          ]),
          endpoint("create_comment", "POST", "/api/comments", ["data.id"], {
            liveWriteEnabled: true,
          }),
          endpoint(
            "update_comment",
            "PUT",
            "/api/comments/{commentId}",
            ["data.id"],
            { liveWriteEnabled: true, deletionEffect: "content" },
          ),
          endpoint(
            "delete_comment",
            "DELETE",
            "/api/comments/{commentId}",
            ["data.id", "data.deleted_at"],
            { liveWriteEnabled: true, deletionEffect: "content" },
          ),
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
      { render: async (asl) => `<!doctype html><body>${asl}</body>` },
    );

    await expect(
      client.listComments("employee.a", docUrl),
    ).resolves.toMatchObject({
      total: 2,
      doc: {
        location: {
          displayPath: "个人：Alice / yuque-web-mcp-e2e / comment doc",
        },
      },
      comments: [
        { id: "10", body: "baseline", authorLogin: "alice" },
        { id: "11", body: "reply", authorLogin: "peer", parentId: "10" },
      ],
    });
    await expect(
      client.prepareCommentChange("employee.a", {
        docUrl,
        action: "delete",
        commentId: "11",
      }),
    ).rejects.toThrow("current employee's own comments");

    const create = await client.prepareCommentChange("employee.a", {
      docUrl,
      action: "create",
      body: "created through MCP",
    });
    const created = await client.changeComment("employee.a", {
      docUrl,
      action: "create",
      body: create.body,
      bodyAsl: create.bodyAsl,
      bodyHtml: create.bodyHtml,
      baselineFingerprint: create.baselineFingerprint,
    });
    expect(created).toMatchObject({ status: "created", comment_id: "12" });

    const update = await client.prepareCommentChange("employee.a", {
      docUrl,
      action: "update",
      commentId: "12",
      body: "updated through MCP",
    });
    await expect(
      client.changeComment("employee.a", {
        docUrl,
        action: "update",
        commentId: "12",
        body: update.body,
        bodyAsl: update.bodyAsl,
        bodyHtml: update.bodyHtml,
        baselineFingerprint: update.baselineFingerprint,
      }),
    ).resolves.toMatchObject({ status: "updated", comment_id: "12" });

    const deletion = await client.prepareCommentChange("employee.a", {
      docUrl,
      action: "delete",
      commentId: "12",
    });
    await expect(
      client.changeComment("employee.a", {
        docUrl,
        action: "delete",
        commentId: "12",
        baselineFingerprint: deletion.baselineFingerprint,
      }),
    ).resolves.toMatchObject({ status: "deleted", comment_id: "12" });
    expect(methods).toEqual(["POST", "PUT", "DELETE"]);
    expect(flatten(comments).map((entry) => entry.id)).toEqual([10, 11]);
  });
});

function comment(
  id: number,
  login: string,
  text: string,
  subComments: CommentFixture[] = [],
): CommentFixture {
  return {
    id,
    parent_id: id === 11 ? 10 : null,
    root_id: id === 11 ? 10 : null,
    body: `<!doctype html><p>${text}</p>`,
    body_asl: lake(text),
    format: "lake",
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    user: { id, login, name: login },
    sub_comments: subComments,
  };
}

function flatten(values: CommentFixture[]): CommentFixture[] {
  return values.flatMap((value) => [value, ...flatten(value.sub_comments)]);
}

function lake(text: string): string {
  return `<!doctype lake><p>${text}</p>`;
}

async function jsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as Record<string, unknown>;
}

function notFound(response: import("node:http").ServerResponse): void {
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
}

function endpoint(
  capability: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  requiredResponsePaths: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    capability,
    verified: true,
    verifiedHostTypes: ["personal"],
    method,
    path,
    idempotent: method === "GET",
    requiredResponsePaths,
    ...extra,
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
    writeConsistencyMode: "best_effort",
    allowUnverifiedContracts: false,
    allowObjectDeletion: false,
    allowPermissionChanges: false,
    writeBookAllowlist: [bookUrl],
  };
}
