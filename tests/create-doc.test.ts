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

describe("Doc creation reconciliation", () => {
  it("reconciles a timed-out POST that actually created the Doc without retrying", async () => {
    const fixture = await createFixture({
      postTimesOut: true,
      createBeforeTimeout: true,
      initiallyMounted: true,
    });

    await expect(fixture.create()).resolves.toMatchObject({
      status: "created",
      catalogMounted: true,
      reconciledAfterUnknownResponse: true,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0 });
  });

  it("marks a timed-out POST with no matching Doc as unknown and never retries", async () => {
    const fixture = await createFixture({
      postTimesOut: true,
      createBeforeTimeout: false,
      initiallyMounted: false,
    });

    await expect(fixture.create()).rejects.toMatchObject({
      name: "CreateResultUnknownError",
      message: expect.stringContaining("do not retry"),
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0 });
  });

  it("does not guess a catalog-mount fallback when the create POST leaves the Doc unmounted", async () => {
    const fixture = await createFixture({
      initiallyMounted: false,
      enableMount: true,
    });

    await expect(fixture.create()).resolves.toMatchObject({
      status: "partial_created_unmounted",
      catalogMounted: false,
      reconciledAfterUnknownResponse: false,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0 });
    expect(fixture.mountBody()).toBeUndefined();
  });

  it("returns partial success when the Doc exists but catalog mounting fails", async () => {
    const fixture = await createFixture({
      initiallyMounted: false,
      enableMount: true,
      mountFails: true,
    });

    await expect(fixture.create()).resolves.toMatchObject({
      status: "partial_created_unmounted",
      catalogMounted: false,
      reconciledAfterUnknownResponse: false,
      docUrl: expect.stringContaining("/team/book/0123456789abcdef"),
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0 });
  });

  it("returns partial success when post-create content read-back is not exact", async () => {
    const fixture = await createFixture({
      initiallyMounted: true,
      readBackMismatch: true,
    });

    await expect(fixture.create()).resolves.toMatchObject({
      status: "partial_created_unverified",
      catalogMounted: true,
      reconciledAfterUnknownResponse: false,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0 });
  });
});

interface FixtureOptions {
  postTimesOut?: boolean;
  createBeforeTimeout?: boolean;
  initiallyMounted: boolean;
  enableMount?: boolean;
  mountFails?: boolean;
  readBackMismatch?: boolean;
}

async function createFixture(options: FixtureOptions): Promise<{
  create: () => Promise<unknown>;
  calls: () => { create: number; mount: number };
  mountBody: () => Record<string, unknown> | undefined;
}> {
  const slug = "0123456789abcdef";
  const title = "test_Node创建文档_契约门禁";
  const lake = '<!doctype lake><p data-lake-id="a">created body</p>';
  const html = "<!doctype html><p>created body</p>";
  let created = false;
  let mounted = options.initiallyMounted;
  let createCalls = 0;
  let mountCalls = 0;
  let observedMountBody: Record<string, unknown> | undefined;
  const createdDetail = {
    id: 30,
    title,
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
              ? [bookFixture(created ? 1 : 0)]
              : [],
        }),
      );
    }
    if (url.pathname === "/api/catalog_nodes" && request.method === "GET") {
      return response.end(
        JSON.stringify({ data: created && mounted ? [nodeFixture()] : [] }),
      );
    }
    if (url.pathname === "/api/catalog_nodes" && request.method === "PUT") {
      mountCalls += 1;
      void readJsonBody(request).then((body) => {
        observedMountBody = body;
        if (options.mountFails) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "mount failed" }));
          return;
        }
        mounted = true;
        response.end(JSON.stringify({ data: nodeFixture() }));
      });
      return;
    }
    if (url.pathname === "/api/docs" && request.method === "POST") {
      createCalls += 1;
      if (options.createBeforeTimeout ?? true) created = true;
      if (options.postTimesOut) return;
      return response.end(JSON.stringify({ data: createdDetail }));
    }
    if (url.pathname === `/api/docs/${slug}` && created) {
      return response.end(
        JSON.stringify({
          data: {
            ...createdDetail,
            content: options.readBackMismatch
              ? `${lake}<p>unexpected</p>`
              : lake,
          },
        }),
      );
    }
    if (url.pathname === `/api/docs/team/book/${slug}/text` && created) {
      return response.end(
        JSON.stringify({ data: { title, content: "created body" } }),
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
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "yuque-create-gate-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(
    contractPath,
    JSON.stringify(createContract(options.enableMount === true), undefined, 2),
  );
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
    testConfig(directory, contractPath, origin),
    await ContractRegistry.load(contractPath),
    sessions,
    { render: async () => html },
  );

  return {
    create: () =>
      client.createDoc("employee.a", {
        bookUrl: `${origin}/team/book`,
        title,
        slug,
        convertedLake: lake,
        expectedParentPath: "个人：Alice / 测试知识库",
      }),
    calls: () => ({ create: createCalls, mount: mountCalls }),
    mountBody: () => observedMountBody,
  };

  function nodeFixture(): Record<string, unknown> {
    return {
      type: "DOC",
      title,
      uuid: "created-node",
      parent_uuid: "",
      level: 0,
      visible: 1,
      doc_id: 30,
      url: slug,
    };
  }
}

function bookFixture(itemsCount: number): Record<string, unknown> {
  return {
    id: 1,
    slug: "book",
    name: "测试知识库",
    items_count: itemsCount,
    updated_at: "2026-08-15T00:00:00.000Z",
    user: { login: "team" },
  };
}

function createContract(enableMount: boolean): Record<string, unknown> {
  return {
    version: "personal-create-doc-gate-test",
    verifiedAt: "2026-08-15T00:00:00.000Z",
    sourceBundles: [],
    endpoints: [
      getEndpoint("list_personal_books", "/api/mine/personal_books", ["data"]),
      getEndpoint("get_toc", "/api/catalog_nodes", ["data"]),
      getEndpoint("get_doc", "/api/docs/{docSlug}", [
        "data.id",
        "data.title",
        "data.slug",
        "data.book_id",
        "data.content",
        "data.draft_version",
      ]),
      getEndpoint(
        "get_doc_text",
        "/api/docs/{groupSlug}/{bookSlug}/{docSlug}/text",
        ["data.title", "data.content"],
      ),
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
        verified: enableMount,
        verifiedHostTypes: enableMount ? ["personal"] : undefined,
        observedHostTypes: ["personal"],
        liveWriteEnabled: enableMount,
        method: "PUT",
        path: "/api/catalog_nodes",
        idempotent: false,
        requiredResponsePaths: [],
      },
    ],
  };
}

function getEndpoint(
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
  dataDir: string,
  contractPath: string,
  personalHost: string,
): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: "https://company.invalid",
    personalYuqueHost: personalHost,
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
    requestTimeoutMs: 30,
    allowUnverifiedContracts: false,
  };
}

async function readJsonBody(
  request: NodeJS.ReadableStream,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as Record<string, unknown>;
}
