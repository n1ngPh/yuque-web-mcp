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

describe("Sheet creation reconciliation", () => {
  it("creates one empty root Sheet with catalog insertion in the POST and reads it back", async () => {
    const fixture = await createFixture({ initiallyMounted: false });

    await expect(fixture.create()).resolves.toMatchObject({
      status: "created",
      displayPath: "个人：Alice / 测试知识库 / test_Node创建表格_契约门禁",
      worksheetCount: 0,
      catalogMounted: true,
      reconciledAfterUnknownResponse: false,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0, initialize: 0 });
    expect(fixture.createBody()).toEqual({
      action: "prependChild",
      body_draft_asl: null,
      book_id: 1,
      format: "lakesheet",
      insert_to_catalog: true,
      slug: "nodesheet2608150",
      status: 1,
      title: "test_Node创建表格_契约门禁",
      type: "Sheet",
    });
    expect(fixture.mountBody()).toBeUndefined();
  });

  it("reconciles a timed-out Sheet POST without retrying it", async () => {
    const fixture = await createFixture({
      initiallyMounted: true,
      postTimesOut: true,
      createBeforeTimeout: true,
    });

    await expect(fixture.create()).resolves.toMatchObject({
      status: "created",
      reconciledAfterUnknownResponse: true,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0, initialize: 0 });
  });

  it("marks a timed-out Sheet POST with no matching object as unknown", async () => {
    const fixture = await createFixture({
      initiallyMounted: false,
      postTimesOut: true,
      createBeforeTimeout: false,
    });

    await expect(fixture.create()).rejects.toMatchObject({
      name: "CreateResultUnknownError",
      message: expect.stringContaining("do not retry"),
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0, initialize: 0 });
  });

  it("creates and initializes exactly one native worksheet in separate writes", async () => {
    const fixture = await createFixture({ initiallyMounted: false });

    await expect(
      fixture.create([
        {
          op: "add_worksheet",
          name: "Sheet1",
          rows: [[{ value: "initialized" }, { value: 2 }]],
        },
      ]),
    ).resolves.toMatchObject({
      status: "created",
      version: 1,
      worksheetCount: 1,
      catalogMounted: true,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0, initialize: 1 });
  });

  it("returns partial success without retry or delete when initialization fails", async () => {
    const fixture = await createFixture({
      initiallyMounted: false,
      initializeFails: true,
    });

    await expect(
      fixture.create([
        { op: "add_worksheet", name: "Sheet1", rows: [[{ value: "x" }]] },
      ]),
    ).resolves.toMatchObject({
      status: "partial_created_uninitialized",
      catalogMounted: true,
      reconciledAfterUnknownResponse: false,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0, initialize: 1 });
  });

  it("reconciles a timed-out initialization read-back without retrying the PUT", async () => {
    const fixture = await createFixture({
      initiallyMounted: false,
      initializeTimesOut: true,
    });

    await expect(
      fixture.create([
        { op: "add_worksheet", name: "Sheet1", rows: [[{ value: "x" }]] },
      ]),
    ).resolves.toMatchObject({
      status: "created",
      worksheetCount: 1,
      reconciledAfterUnknownResponse: true,
    });
    expect(fixture.calls()).toEqual({ create: 1, mount: 0, initialize: 1 });
  });

  it("rejects multiple initial worksheets before creating an object", async () => {
    const fixture = await createFixture({ initiallyMounted: false });

    await expect(
      fixture.create([
        { op: "add_worksheet", name: "Sheet1" },
        { op: "add_worksheet", name: "Sheet2" },
      ]),
    ).rejects.toThrow("exactly one verified native worksheet");
    expect(fixture.calls()).toEqual({ create: 0, mount: 0, initialize: 0 });
  });
});

interface FixtureOptions {
  initiallyMounted: boolean;
  postTimesOut?: boolean;
  createBeforeTimeout?: boolean;
  initializeFails?: boolean;
  initializeTimesOut?: boolean;
}

async function createFixture(options: FixtureOptions): Promise<{
  create: (worksheets?: unknown[]) => Promise<unknown>;
  calls: () => { create: number; mount: number; initialize: number };
  createBody: () => Record<string, unknown> | undefined;
  mountBody: () => Record<string, unknown> | undefined;
}> {
  const slug = "nodesheet2608150";
  const title = "test_Node创建表格_契约门禁";
  let created = false;
  let mounted = options.initiallyMounted;
  let createCalls = 0;
  let mountCalls = 0;
  let initializeCalls = 0;
  let observedCreateBody: Record<string, unknown> | undefined;
  let observedMountBody: Record<string, unknown> | undefined;
  const detail = {
    id: 31,
    title,
    slug,
    type: "Sheet",
    book_id: 1,
    format: "lakesheet",
    content: "",
    body: "",
    body_asl: "",
    body_draft: "",
    body_draft_asl: "",
    draft_version: 0,
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
        mounted = true;
        response.end(JSON.stringify({ data: nodeFixture() }));
      });
      return;
    }
    if (url.pathname === "/api/docs" && request.method === "POST") {
      createCalls += 1;
      void readJsonBody(request).then((body) => {
        observedCreateBody = body;
        if (options.createBeforeTimeout ?? true) {
          created = true;
          if (
            body.insert_to_catalog === true &&
            body.action === "prependChild"
          ) {
            mounted = true;
          }
        }
        if (!options.postTimesOut) {
          response.end(JSON.stringify({ data: detail }));
        }
      });
      return;
    }
    if (url.pathname === "/api/docs/31/content" && request.method === "PUT") {
      initializeCalls += 1;
      void readJsonBody(request).then((body) => {
        if (options.initializeFails) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "initialization failed" }));
          return;
        }
        detail.body_draft = String(body.body_asl);
        detail.draft_version += 1;
        if (options.initializeTimesOut) return;
        response.end(JSON.stringify({ data: detail }));
      });
      return;
    }
    if (url.pathname === `/api/docs/${slug}` && created) {
      return response.end(JSON.stringify({ data: detail }));
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
  const directory = await mkdtemp(join(tmpdir(), "yuque-create-sheet-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(contractPath, JSON.stringify(createContract()), {
    mode: 0o600,
  });
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
  );

  return {
    create: (worksheets = []) =>
      client.createSheet("employee.a", {
        bookUrl: `${origin}/team/book`,
        title,
        slug,
        expectedParentPath: "个人：Alice / 测试知识库",
        worksheets,
      }),
    calls: () => ({
      create: createCalls,
      mount: mountCalls,
      initialize: initializeCalls,
    }),
    createBody: () => observedCreateBody,
    mountBody: () => observedMountBody,
  };

  function nodeFixture(): Record<string, unknown> {
    return {
      type: "DOC",
      title,
      uuid: "created-sheet-node",
      parent_uuid: "",
      level: 0,
      visible: 1,
      doc_id: 31,
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

function createContract(): Record<string, unknown> {
  return {
    version: "personal-create-sheet-gate-test",
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
      getEndpoint("get_sheet", "/api/docs/{docSlug}", [
        "data.id",
        "data.title",
        "data.slug",
        "data.book_id",
        "data.format",
        "data.type",
        "data.body_draft",
        "data.draft_version",
      ]),
      {
        capability: "create_sheet",
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
          "data.format",
          "data.type",
        ],
      },
      {
        capability: "mount_catalog_node",
        verified: true,
        verifiedHostTypes: ["personal"],
        liveWriteEnabled: true,
        method: "PUT",
        path: "/api/catalog_nodes",
        idempotent: false,
        requiredResponsePaths: [],
      },
      {
        capability: "save_sheet_content",
        verified: true,
        verifiedHostTypes: ["personal"],
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
    writeConsistencyMode: "best_effort",
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
