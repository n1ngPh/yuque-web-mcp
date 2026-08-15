import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { CookieJar } from "tough-cookie";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { classifyYuqueHostType, YuqueWebClient } from "../src/yuque-client.js";
import type { AppConfig } from "../src/config.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Yuque HTTP replay client", () => {
  it("classifies a standalone same-origin configuration as personal", () => {
    expect(
      classifyYuqueHostType({
        baseHost: "https://www.yuque.com",
        yuqueHost: "https://www.yuque.com",
        personalYuqueHost: "https://www.yuque.com",
        organization: "",
      }),
    ).toBe("personal");
    expect(
      classifyYuqueHostType({
        baseHost: "https://www.yuque.com",
        yuqueHost: "https://company.yuque.com",
        personalYuqueHost: "https://www.yuque.com",
        organization: "company",
      }),
    ).toBe("personal");
    expect(
      classifyYuqueHostType({
        baseHost: "https://company.yuque.com",
        yuqueHost: "https://company.yuque.com",
        personalYuqueHost: "https://www.yuque.com",
        organization: "company",
      }),
    ).toBe("organization");
  });

  it("resolves a document URL through personal books in standalone same-origin mode", async () => {
    let personalBookRequests = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/personal_books") {
        personalBookRequests += 1;
        return response.end(
          JSON.stringify({
            data: [
              {
                id: 11,
                slug: "personal-book",
                name: "默认知识库",
                items_count: 1,
                user: { login: "u10001", type: "User" },
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/docs/personal-doc") {
        return response.end(
          JSON.stringify({
            data: {
              id: 12,
              title: "个人文档",
              slug: "personal-doc",
              book_id: 11,
              content: "<p>personal</p>",
              format: "lake",
              draft_version: 3,
            },
          }),
        );
      }
      if (url.pathname === "/api/docs/u10001/personal-book/personal-doc/text") {
        return response.end(
          JSON.stringify({ data: { title: "个人文档", content: "正文" } }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        return response.end(
          JSON.stringify({
            data: [
              {
                type: "DOC",
                title: "个人文档",
                uuid: "personal-doc-uuid",
                parent_uuid: "",
                level: 0,
                visible: 1,
                doc_id: 12,
                url: "personal-doc",
              },
            ],
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
    if (!address || typeof address === "string")
      throw new Error("No test server address");

    const directory = await mkdtemp(join(tmpdir(), "yuque-standalone-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "standalone-personal-test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          {
            ...endpoint("list_personal_books", "/api/mine/personal_books", [
              "data",
            ]),
            verifiedHostTypes: ["personal"],
          },
          {
            ...endpoint("get_doc", "/api/docs/{docSlug}", [
              "data.id",
              "data.content",
            ]),
            verifiedHostTypes: ["personal"],
          },
          {
            ...endpoint(
              "get_doc_text",
              "/api/docs/{groupSlug}/{bookSlug}/{docSlug}/text",
              ["data.title", "data.content"],
            ),
            verifiedHostTypes: ["personal"],
          },
          {
            ...endpoint("get_toc", "/api/catalog_nodes", ["data"]),
            verifiedHostTypes: ["personal"],
          },
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const config = testConfig(directory, contractPath, origin);
    config.personalYuqueHost = origin;
    config.organization = "";
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "u10001", name: "8890" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      config,
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(
      client.getDoc(
        "employee.a",
        `${origin}/u10001/personal-book/personal-doc`,
      ),
    ).resolves.toMatchObject({
      title: "个人文档",
      markdown: "正文",
      location: {
        displayPath: "个人：8890 / 默认知识库 / 个人文档",
      },
    });
    expect(personalBookRequests).toBe(1);
  });

  it("sends employee cookies and web headers without a browser process", async () => {
    let observed: Record<string, string | undefined> = {};
    const server = createServer((request, response) => {
      observed = {
        cookie: request.headers.cookie,
        csrf: request.headers["x-csrf-token"] as string | undefined,
        login: request.headers["x-login"] as string | undefined,
      };
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "yuque_ctoken=csrf-refreshed; Path=/",
      });
      response.end(JSON.stringify({ data: { id: 1, login: "alice" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");

    const directory = await mkdtemp(join(tmpdir(), "yuque-client-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          {
            capability: "get_user",
            verified: true,
            method: "GET",
            path: "/api/mine/account",
            idempotent: true,
            requiredResponsePaths: ["data.id"],
          },
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const config = testConfig(directory, contractPath, origin);
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    const jar = new CookieJar();
    await jar.setCookie("yuque_session=employee-a; Path=/", origin);
    await sessions.save("employee.a", {
      cookies: jar.serializeSync(),
      csrfToken: "csrf-a",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      config,
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(client.getUser("employee.a")).resolves.toEqual({
      id: 1,
      login: "alice",
    });
    expect(observed).toEqual({
      cookie: "yuque_session=employee-a",
      csrf: "csrf-a",
      login: "alice",
    });
    await expect(sessions.load("employee.a")).resolves.toMatchObject({
      csrfToken: "csrf-refreshed",
    });
  });

  it("removes the local owner session when Yuque requires relogin", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: "force_redirect_login" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");

    const directory = await mkdtemp(join(tmpdir(), "yuque-client-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          {
            capability: "get_user",
            verified: true,
            method: "GET",
            path: "/api/mine/account",
            idempotent: true,
            requiredResponsePaths: [],
          },
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    const stored = {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    };
    await sessions.save("employee.a", stored);
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin),
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(client.getUser("employee.a")).rejects.toThrow(
      "login has expired",
    );
    await expect(sessions.load("employee.a")).resolves.toBeUndefined();
  });

  it("preserves the local session on an ordinary permission 403", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: "permission_denied" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");

    const directory = await mkdtemp(join(tmpdir(), "yuque-client-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          {
            capability: "get_user",
            verified: true,
            method: "GET",
            path: "/api/mine/account",
            idempotent: true,
            requiredResponsePaths: [],
          },
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin),
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(client.getUser("employee.a")).rejects.toMatchObject({
      name: "YuqueHttpError",
      status: 403,
    });
    await expect(sessions.load("employee.a")).resolves.toMatchObject({
      account: { login: "alice" },
    });
  });

  it("discovers scopes and reads a personal book through its own host", async () => {
    let organizationOrigin = "";
    let personalConversionCount = 0;
    let observedNativeDocSave: Record<string, unknown> | undefined;
    let observedDocPublish: Record<string, unknown> | undefined;
    let observedLockUuid: string | null = null;
    const personalServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/organizations") {
        return response.end(
          JSON.stringify({
            data: [{ id: 9, name: "Acme", host: organizationOrigin }],
          }),
        );
      }
      if (url.pathname === "/api/mine/personal_books") {
        return response.end(
          JSON.stringify({
            data:
              Number(url.searchParams.get("offset") ?? 0) === 0
                ? [
                    {
                      id: 11,
                      slug: "personal-book",
                      name: "测试知识库",
                      items_count: 1,
                      user: { login: "u1", type: "User" },
                    },
                  ]
                : [],
          }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        return response.end(
          JSON.stringify({
            data: [
              {
                type: "DOC",
                title: "test01",
                uuid: "personal-doc-uuid",
                parent_uuid: "",
                level: 0,
                visible: 1,
                doc_id: 12,
                url: "personal-doc",
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/docs/personal-doc") {
        if (url.searchParams.get("mode") === "edit") {
          return response.end(
            JSON.stringify({
              data: {
                id: 12,
                title: "test01",
                slug: "personal-doc",
                book_id: 11,
                type: "Doc",
                format: "lake",
                body: "<p>personal html</p>",
                body_asl: '<p data-lake-id="published">personal</p>',
                body_draft: "<p>personal draft html</p>",
                body_draft_asl: '<p data-lake-id="draft">personal draft</p>',
                draft_version: 3,
                updated_at: "2026-08-15T00:00:00.000Z",
              },
            }),
          );
        }
        return response.end(
          JSON.stringify({
            data: {
              id: 12,
              title: "test01",
              slug: "personal-doc",
              book_id: 11,
              content: "<p>personal</p>",
              format: "lake",
              draft_version: 0,
            },
          }),
        );
      }
      if (url.pathname === "/api/docs/12/content" && request.method === "PUT") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          observedNativeDocSave = JSON.parse(body) as Record<string, unknown>;
          response.end(JSON.stringify({ data: { id: 12, draft_version: 4 } }));
        });
        return;
      }
      if (url.pathname === "/api/docs/12/lock" && request.method === "GET") {
        observedLockUuid = url.searchParams.get("uuid");
        return response.end(
          JSON.stringify({
            data: {
              doc: {
                draft_version: 3,
                last_editor: { id: 1, name: "Alice", avatar: null },
                locker: null,
                collab_members: [],
              },
            },
          }),
        );
      }
      if (url.pathname === "/api/docs/12/publish" && request.method === "PUT") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          observedDocPublish = JSON.parse(body) as Record<string, unknown>;
          response.end(JSON.stringify({ data: {} }));
        });
        return;
      }
      if (url.pathname === "/api/docs/u1/personal-book/personal-doc/text") {
        return response.end(
          JSON.stringify({ data: { title: "test01", content: "personal" } }),
        );
      }
      if (url.pathname === "/api/docs/convert" && request.method === "POST") {
        personalConversionCount += 1;
        return response.end(
          JSON.stringify({ data: { content: "<p>personal conversion</p>" } }),
        );
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    const organizationServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/books") {
        return response.end(
          JSON.stringify({
            data:
              Number(url.searchParams.get("offset") ?? 0) === 0
                ? [
                    {
                      ...bookFixture(21, "company-book", "Company book", 0),
                      organization_id: 9,
                      user: {
                        login: "team",
                        organization: { id: 9, name: "Acme" },
                      },
                    },
                  ]
                : [],
          }),
        );
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    personalServer.listen(0, "127.0.0.1");
    organizationServer.listen(0, "127.0.0.1");
    await Promise.all([
      once(personalServer, "listening"),
      once(organizationServer, "listening"),
    ]);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => personalServer.close(() => resolve())),
      () =>
        new Promise<void>((resolve) =>
          organizationServer.close(() => resolve()),
        ),
    );
    const personalAddress = personalServer.address();
    const organizationAddress = organizationServer.address();
    if (
      !personalAddress ||
      typeof personalAddress === "string" ||
      !organizationAddress ||
      typeof organizationAddress === "string"
    ) {
      throw new Error("No test server address");
    }
    const personalOrigin = `http://127.0.0.1:${personalAddress.port}`;
    organizationOrigin = `http://127.0.0.1:${organizationAddress.port}`;

    const directory = await mkdtemp(join(tmpdir(), "yuque-scope-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "scope-test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          endpoint("list_organizations", "/api/mine/organizations", ["data"]),
          endpoint("list_personal_books", "/api/mine/personal_books", ["data"]),
          endpoint("list_books", "/api/mine/books", ["data"]),
          endpoint("get_toc", "/api/catalog_nodes", ["data"]),
          endpoint("get_doc", "/api/docs/{docSlug}", [
            "data.id",
            "data.content",
          ]),
          endpoint("get_doc_editor", "/api/docs/{docSlug}", [
            "data.id",
            "data.title",
            "data.slug",
            "data.book_id",
            "data.type",
            "data.format",
            "data.body",
            "data.body_asl",
            "data.body_draft",
            "data.body_draft_asl",
            "data.draft_version",
          ]),
          {
            capability: "get_doc_lock",
            verified: true,
            verifiedHostTypes: ["personal"],
            method: "GET",
            path: "/api/docs/{docId}/lock",
            idempotent: true,
            requiredResponsePaths: [
              "data.doc.draft_version",
              "data.doc.last_editor",
              "data.doc.locker",
              "data.doc.collab_members",
            ],
          },
          {
            capability: "save_doc_content",
            verified: true,
            verifiedHostTypes: ["personal"],
            liveWriteEnabled: true,
            method: "PUT",
            path: "/api/docs/{docId}/content",
            idempotent: false,
            requiredResponsePaths: ["data.id", "data.draft_version"],
          },
          {
            capability: "publish_doc",
            verified: true,
            verifiedHostTypes: ["personal"],
            liveWriteEnabled: true,
            method: "PUT",
            path: "/api/docs/{docId}/publish",
            idempotent: false,
            requiredResponsePaths: [],
          },
          endpoint(
            "get_doc_text",
            "/api/docs/{groupSlug}/{bookSlug}/{docSlug}/text",
            ["data.title", "data.content"],
          ),
          {
            capability: "convert_markdown",
            verified: true,
            verifiedHostTypes: ["organization", "personal"],
            method: "POST",
            path: "/api/docs/convert",
            idempotent: true,
            requiredResponsePaths: ["data.content"],
          },
        ],
      }),
    );
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "u1", name: "Alice" },
      savedAt: new Date().toISOString(),
    });
    const config = testConfig(directory, contractPath, organizationOrigin);
    config.personalYuqueHost = personalOrigin;
    const client = new YuqueWebClient(
      config,
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(client.listScopes("employee.a")).resolves.toMatchObject({
      defaultScopeId: "organization",
      scopes: [
        { id: "personal", label: "个人：Alice", host: personalOrigin },
        {
          id: "organization:9",
          label: "空间：Acme",
          host: organizationOrigin,
        },
      ],
    });
    await expect(
      client.listAllBooks("employee.a", "personal"),
    ).resolves.toMatchObject([
      {
        name: "测试知识库",
        scopeId: "personal",
        scopeLabel: "个人：Alice",
        url: `${personalOrigin}/u1/personal-book`,
      },
    ]);
    await expect(
      client.listAllBooks("employee.a", "organization:9"),
    ).resolves.toMatchObject([
      { name: "Company book", scopeId: "organization:9" },
    ]);
    await expect(
      client.getDoc(
        "employee.a",
        `${personalOrigin}/u1/personal-book/personal-doc`,
      ),
    ).resolves.toMatchObject({
      title: "test01",
      markdown: "personal",
      location: {
        displayPath: "个人：Alice / 测试知识库 / test01",
      },
    });
    await expect(
      client.getDocEditorDraft(
        "employee.a",
        `${personalOrigin}/u1/personal-book/personal-doc`,
      ),
    ).resolves.toMatchObject({
      title: "test01",
      version: 3,
      publishedAsl: '<p data-lake-id="published">personal</p>',
      draftAsl: '<p data-lake-id="draft">personal draft</p>',
      publishedHtml: "<p>personal html</p>",
      draftHtml: "<p>personal draft html</p>",
      location: {
        displayPath: "个人：Alice / 测试知识库 / test01",
      },
    });
    await expect(
      client.getResourceLockState("employee.a", {
        docId: "12",
        docUrl: `${personalOrigin}/u1/personal-book/personal-doc`,
      }),
    ).resolves.toEqual({
      draftVersion: 3,
      lockerPresent: false,
      collaboratorCount: 0,
    });
    expect(observedLockUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(
      client.updateDocNativeDraft("employee.a", {
        docId: "12",
        draftVersion: 3,
        bodyAsl: '<p data-lake-id="draft">personal draft</p>',
        bodyHtml: "<p>personal draft html</p>",
        referer: `${personalOrigin}/u1/personal-book/personal-doc/edit`,
      }),
    ).resolves.toMatchObject({ id: 12, draft_version: 4 });
    await expect(
      client.publishDoc("employee.a", {
        docId: "12",
        referer: `${personalOrigin}/u1/personal-book/personal-doc/edit`,
      }),
    ).resolves.toEqual({});
    expect(observedNativeDocSave).toEqual({
      body_asl: '<p data-lake-id="draft">personal draft</p>',
      body_html: "<p>personal draft html</p>",
      created_by: "online",
      draft_version: 3,
      edit_type: "Lake",
      format: "lake",
      save_type: "user",
      sync_dynamic_data: false,
      target_uuid: null,
    });
    expect(observedDocPublish).toEqual({
      cover: null,
      force: false,
      notify: false,
      ignoreGlobalMessage: true,
    });
    await expect(
      client.search("employee.a", "test01", undefined, 20, "personal"),
    ).rejects.toThrow("Personal global search is not verified");
    await expect(
      client.convertMarkdownToLake(
        "employee.a",
        "personal conversion",
        `${personalOrigin}/u1/personal-book`,
      ),
    ).resolves.toBe("<p>personal conversion</p>");
    expect(personalConversionCount).toBe(1);
  });

  it("indexes document locations and reads verified plain text", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/books") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return response.end(
          JSON.stringify({
            data:
              offset === 0
                ? [
                    bookFixture(1, "book", "First book", 1),
                    bookFixture(2, "second", "Second book", 0),
                  ]
                : [],
          }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        const bookId = Number(url.searchParams.get("book_id"));
        return response.end(
          JSON.stringify({
            data:
              bookId === 1
                ? [
                    {
                      type: "TITLE",
                      title: "Folder",
                      uuid: "folder",
                      parent_uuid: "",
                      level: 0,
                      visible: 1,
                    },
                    {
                      type: "DOC",
                      title: "Document",
                      uuid: "document",
                      parent_uuid: "folder",
                      level: 1,
                      visible: 1,
                      doc_id: 10,
                      url: "doc-slug",
                    },
                  ]
                : [],
          }),
        );
      }
      if (url.pathname === "/api/docs/doc-slug") {
        return response.end(
          JSON.stringify({
            data: {
              id: 10,
              title: "Document",
              slug: "doc-slug",
              book_id: 1,
              content: "<lake-content />",
              format: "lake",
              updated_at: "2026-08-14T00:00:00.000Z",
              draft_version: 3,
            },
          }),
        );
      }
      if (url.pathname === "/api/docs/team/book/doc-slug/text") {
        return response.end(
          JSON.stringify({
            data: { title: "Document", content: "Readable text" },
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
    if (!address || typeof address === "string")
      throw new Error("No test server address");

    const directory = await mkdtemp(join(tmpdir(), "yuque-client-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "read-test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          endpoint("list_books", "/api/mine/books", ["data"]),
          endpoint("get_toc", "/api/catalog_nodes", ["data"]),
          endpoint("get_doc", "/api/docs/{docSlug}", [
            "data.id",
            "data.content",
          ]),
          endpoint(
            "get_doc_text",
            "/api/docs/{groupSlug}/{bookSlug}/{docSlug}/text",
            ["data.title", "data.content"],
          ),
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin),
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(client.listAllBooks("employee.a")).resolves.toHaveLength(2);
    const documents = await client.listAllDocs("employee.a");
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      title: "Document",
      url: `${origin}/team/book/doc-slug`,
      position: {
        path: ["Folder", "Document"],
        fullPath: ["空间：test", "First book", "Folder", "Document"],
        displayPath: "空间：test / First book / Folder / Document",
        level: 1,
      },
    });
    await expect(
      client.getDoc("employee.a", `${origin}/team/book/doc-slug`),
    ).resolves.toMatchObject({
      id: "10",
      title: "Document",
      markdown: "Readable text",
      format: "lake",
      version: 3,
      location: {
        fullPath: ["空间：test", "First book", "Folder", "Document"],
        displayPath: "空间：test / First book / Folder / Document",
      },
    });
  });

  it("replays verified organization search and Markdown conversion schemas", async () => {
    let searchQuery: Record<string, string | null> = {};
    let conversionBody: Record<string, unknown> = {};
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/zsearch") {
        for (const key of ["p", "q", "limit", "type", "tab", "scope"]) {
          searchQuery[key] = url.searchParams.get(key);
        }
        return response.end(
          JSON.stringify({
            data: {
              hits: [],
              totalHits: 0,
              info: { scope: "/" },
            },
          }),
        );
      }
      if (url.pathname === "/api/docs/convert") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          conversionBody = JSON.parse(body) as Record<string, unknown>;
          response.end(JSON.stringify({ data: { content: "<lake />" } }));
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
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    const directory = await mkdtemp(join(tmpdir(), "yuque-search-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "search-convert-test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          endpoint("search", "/api/zsearch", [
            "data.hits",
            "data.totalHits",
            "data.info.scope",
          ]),
          {
            capability: "convert_markdown",
            verified: true,
            method: "POST",
            path: "/api/docs/convert",
            idempotent: false,
            requiredResponsePaths: ["data.content"],
          },
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin),
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(
      client.search("employee.a", "needle", undefined, 7),
    ).resolves.toMatchObject({ hits: [], totalHits: 0 });
    expect(searchQuery).toEqual({
      p: "1",
      q: "needle",
      limit: "7",
      type: "content",
      tab: "organization",
      scope: "/",
    });
    await expect(
      client.convertMarkdown("employee.a", "# heading"),
    ).resolves.toEqual({ content: "<lake />" });
    expect(conversionBody).toEqual({
      content: "# heading",
      from: "markdown",
      to: "lake",
    });
  });

  it("replays the verified editor-mode Sheet read without a browser", async () => {
    let observedQuery: Record<string, string | null> = {};
    let observedReferer: string | undefined;
    let observedSheetWrite: Record<string, unknown> | undefined;
    const bodyDraft = JSON.stringify({
      format: "lakesheet",
      version: "3.5.5",
      larkJson: true,
      sheet: deflateSync(
        JSON.stringify([
          {
            id: "sheet-1",
            name: "Sheet1",
            rowCount: 200,
            colCount: 26,
            data: {
              0: { 0: { v: "field" } },
              1: {
                1: {
                  v: {
                    class: "formula",
                    formula: "A1*2",
                    value: 4,
                  },
                },
              },
            },
            mergeCells: {},
            filter: {},
          },
        ]),
      ).toString("latin1"),
      calcChain: [],
      vessels: {},
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/books") {
        return response.end(
          JSON.stringify({
            data:
              Number(url.searchParams.get("offset") ?? 0) === 0
                ? [bookFixture(1, "book", "Example Project", 1)]
                : [],
          }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        return response.end(
          JSON.stringify({
            data: [
              {
                type: "TITLE",
                title: "yuque-web-mcp",
                uuid: "folder",
                parent_uuid: "",
                level: 0,
                visible: 1,
              },
              {
                type: "DOC",
                title: "test_表格",
                uuid: "sheet",
                parent_uuid: "folder",
                level: 1,
                visible: 1,
                doc_id: 20,
                url: "sheet-slug",
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/docs/20/content" && request.method === "PUT") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          observedSheetWrite = JSON.parse(body) as Record<string, unknown>;
          response.end(
            JSON.stringify({
              data: {
                id: 20,
                draft_version: 5,
                body_draft: bodyDraft,
              },
            }),
          );
        });
        return;
      }
      if (url.pathname === "/api/docs/sheet-slug") {
        observedReferer = request.headers.referer;
        for (const key of [
          "mode",
          "forceLocal",
          "include_contributors",
          "include_hits",
          "include_like",
          "merge_dynamic_data",
        ]) {
          observedQuery[key] = url.searchParams.get(key);
        }
        return response.end(
          JSON.stringify({
            data: {
              id: 20,
              title: "test_表格",
              slug: "sheet-slug",
              type: "Sheet",
              book_id: 1,
              format: "lakesheet",
              body_draft: bodyDraft,
              draft_version: 4,
              updated_at: "2026-08-14T00:00:00.000Z",
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
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    const directory = await mkdtemp(join(tmpdir(), "yuque-sheet-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "sheet-read-test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          endpoint("list_books", "/api/mine/books", ["data"]),
          endpoint("get_toc", "/api/catalog_nodes", ["data"]),
          endpoint("get_sheet", "/api/docs/{docSlug}", [
            "data.body_draft",
            "data.draft_version",
          ]),
          {
            capability: "save_sheet_content",
            verified: true,
            verifiedHostTypes: ["organization", "personal"],
            liveWriteEnabled: true,
            method: "PUT",
            path: "/api/docs/{docId}/content",
            idempotent: false,
            requiredResponsePaths: [
              "data.id",
              "data.draft_version",
              "data.body_draft",
            ],
          },
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin),
      await ContractRegistry.load(contractPath),
      sessions,
    );

    await expect(
      client.getSheet("employee.a", `${origin}/team/book/sheet-slug`),
    ).resolves.toMatchObject({
      title: "test_表格",
      version: 4,
      location: {
        displayPath: "空间：test / Example Project / yuque-web-mcp / test_表格",
      },
      workbook: {
        revision: "4",
        worksheets: [
          {
            id: "sheet-1",
            cells: {
              A1: { value: "field" },
              B2: { value: 4, formula: "=A1*2" },
            },
          },
        ],
      },
    });
    expect(observedQuery).toEqual({
      mode: "edit",
      forceLocal: "false",
      include_contributors: "true",
      include_hits: "true",
      include_like: "true",
      merge_dynamic_data: "false",
    });
    expect(observedReferer).toBe(`${origin}/team/book/sheet-slug/edit`);
    await expect(
      client.updateSheetDraft("employee.a", {
        docId: "20",
        draftVersion: 4,
        bodyDraft,
        referer: `${origin}/team/book/sheet-slug/edit`,
      }),
    ).resolves.toMatchObject({ id: 20, draft_version: 5 });
    expect(observedSheetWrite).toEqual({
      body_asl: bodyDraft,
      body_html: null,
      created_by: "online",
      draft_version: 4,
      edit_type: "Lake",
      format: "lakesheet",
      save_type: "user",
      sync_dynamic_data: false,
      target_uuid: null,
    });
  });

  it("creates a Doc with the statically verified body, rejects duplicates and reads it back", async () => {
    const slug = "0123456789abcdef";
    const lake = '<!doctype lake><p data-lake-id="a">created body</p>';
    const html = "<!doctype html><p>created body</p>";
    let created = false;
    let createCalls = 0;
    let mountCalls = 0;
    let observedCreateBody: Record<string, unknown> | undefined;
    const docDetail = {
      id: 30,
      title: "test_Node创建文档",
      slug,
      type: "Doc",
      book_id: 1,
      format: "lake",
      content: lake,
      draft_version: 1,
      updated_at: "2026-08-15T00:00:00.000Z",
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/personal_books") {
        return response.end(
          JSON.stringify({
            data:
              Number(url.searchParams.get("offset") ?? 0) === 0
                ? [bookFixture(1, "book", "测试知识库", created ? 1 : 0)]
                : [],
          }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        if (request.method === "PUT") mountCalls += 1;
        return response.end(
          JSON.stringify({
            data: created
              ? [
                  {
                    type: "DOC",
                    title: docDetail.title,
                    uuid: "created-node",
                    parent_uuid: "",
                    level: 0,
                    visible: 1,
                    doc_id: docDetail.id,
                    url: slug,
                  },
                ]
              : [],
          }),
        );
      }
      if (url.pathname === "/api/docs" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          createCalls += 1;
          observedCreateBody = JSON.parse(body) as Record<string, unknown>;
          created = true;
          response.end(JSON.stringify({ data: docDetail }));
        });
        return;
      }
      if (url.pathname === `/api/docs/${slug}` && created) {
        return response.end(JSON.stringify({ data: docDetail }));
      }
      if (url.pathname === `/api/docs/team/book/${slug}/text` && created) {
        return response.end(
          JSON.stringify({
            data: { title: docDetail.title, content: "created body" },
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
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    const directory = await mkdtemp(join(tmpdir(), "yuque-create-doc-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "personal-create-doc-test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          {
            ...endpoint("list_personal_books", "/api/mine/personal_books", [
              "data",
            ]),
            verifiedHostTypes: ["personal"],
          },
          {
            ...endpoint("get_toc", "/api/catalog_nodes", ["data"]),
            verifiedHostTypes: ["personal"],
          },
          {
            ...endpoint("get_doc", "/api/docs/{docSlug}", [
              "data.id",
              "data.title",
              "data.slug",
              "data.book_id",
              "data.content",
              "data.draft_version",
            ]),
            verifiedHostTypes: ["personal"],
          },
          {
            ...endpoint(
              "get_doc_text",
              "/api/docs/{groupSlug}/{bookSlug}/{docSlug}/text",
              ["data.title", "data.content"],
            ),
            verifiedHostTypes: ["personal"],
          },
          {
            capability: "create_doc",
            verified: true,
            verifiedHostTypes: ["personal"],
            liveWriteEnabled: true,
            method: "POST",
            path: "/api/docs",
            idempotent: false,
            requiredResponsePaths: [
              "data.id",
              "data.slug",
              "data.title",
              "data.book_id",
              "data.type",
              "data.format",
            ],
          },
          {
            capability: "mount_catalog_node",
            verified: false,
            observedHostTypes: ["personal"],
            liveWriteEnabled: false,
            method: "PUT",
            path: "/api/catalog_nodes",
            idempotent: false,
            requiredResponsePaths: [],
          },
        ],
      }),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const config = {
      ...testConfig(directory, contractPath, "https://company.invalid"),
      personalYuqueHost: origin,
    };
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
      { render: async () => html },
    );
    const bookUrl = `${origin}/team/book`;

    await expect(
      client.createDoc("employee.a", {
        bookUrl,
        title: docDetail.title,
        slug,
        convertedLake: lake,
        expectedParentPath: "个人：Alice / 测试知识库",
      }),
    ).resolves.toMatchObject({
      status: "created",
      id: "30",
      slug,
      title: docDetail.title,
      docUrl: `${bookUrl}/${slug}`,
      displayPath: `个人：Alice / 测试知识库 / ${docDetail.title}`,
      catalogMounted: true,
      reconciledAfterUnknownResponse: false,
    });
    expect(observedCreateBody).toEqual({
      action: "prependChild",
      body: html,
      body_draft: html,
      body_asl: lake,
      body_draft_asl: lake,
      book_id: 1,
      format: "lake",
      insert_to_catalog: true,
      slug,
      status: 1,
      title: docDetail.title,
      type: "Doc",
      target_uuid: "",
    });
    expect(createCalls).toBe(1);
    expect(mountCalls).toBe(0);
    await expect(
      client.prepareCreateTarget("employee.a", {
        bookUrl,
        title: docDetail.title,
        slug: "fedcba9876543210",
      }),
    ).rejects.toThrow("same title already exists");
    expect(createCalls).toBe(1);
  });
});

function bookFixture(
  id: number,
  slug: string,
  name: string,
  itemsCount: number,
): Record<string, unknown> {
  return {
    id,
    slug,
    name,
    items_count: itemsCount,
    updated_at: "2026-08-14T00:00:00.000Z",
    user: { login: "team" },
  };
}

function endpoint(
  capability: string,
  path: string,
  requiredResponsePaths: string[],
): Record<string, unknown> {
  return {
    capability,
    verified: true,
    verifiedHostTypes: ["organization", "personal"],
    method: "GET",
    path,
    idempotent: true,
    requiredResponsePaths,
  };
}

function testConfig(
  dataDir: string,
  contractPath: string,
  yuqueHost: string,
): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost,
    personalYuqueHost: yuqueHost,
    organization: "test",
    dataDir,
    databasePath: join(dataDir, "state.db"),
    contractPath,
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey: randomBytes(32),
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 5_000,
    allowUnverifiedContracts: false,
  };
}
