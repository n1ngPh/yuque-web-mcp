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

describe("personal knowledge-base creation", () => {
  it("creates only a private personal Book and verifies list read-back", async () => {
    const fixture = await createFixture({});

    await expect(fixture.create()).resolves.toMatchObject({
      status: "created",
      name: "yuque-web-mcp-e2e",
      bookUrl: expect.stringContaining("/alice/abc123"),
      displayPath: "个人：Alice / yuque-web-mcp-e2e",
      private: true,
      reconciledAfterUnknownResponse: false,
    });
    expect(fixture.calls()).toEqual({ create: 1, quickLink: 0 });
    expect(fixture.body()).toEqual({
      description: "sandbox",
      extend_private: 0,
      name: "yuque-web-mcp-e2e",
      public: 0,
      type: "Book",
      user_id: 7,
    });
  });

  it("reconciles a dropped response without retrying the POST", async () => {
    const fixture = await createFixture({ dropCreateResponse: true });

    await expect(fixture.create()).resolves.toMatchObject({
      status: "created",
      reconciledAfterUnknownResponse: true,
    });
    expect(fixture.calls()).toEqual({ create: 1, quickLink: 0 });
  });

  it("marks a dropped request that created nothing unknown and never retries", async () => {
    const fixture = await createFixture({
      dropCreateResponse: true,
      doNotCreate: true,
    });

    await expect(fixture.create()).rejects.toMatchObject({
      name: "CreateResultUnknownError",
      message: expect.stringContaining("do not retry"),
    });
    expect(fixture.calls()).toEqual({ create: 1, quickLink: 0 });
  });

  it("rejects a duplicate name before any write request", async () => {
    const fixture = await createFixture({ initiallyCreated: true });

    await expect(fixture.create()).rejects.toThrow("same name already exists");
    expect(fixture.calls()).toEqual({ create: 0, quickLink: 0 });
  });
});

interface FixtureOptions {
  dropCreateResponse?: boolean;
  doNotCreate?: boolean;
  initiallyCreated?: boolean;
}

async function createFixture(options: FixtureOptions): Promise<{
  create: () => Promise<unknown>;
  calls: () => { create: number; quickLink: number };
  body: () => Record<string, unknown> | undefined;
}> {
  let created = options.initiallyCreated === true;
  let createCalls = 0;
  let quickLinkCalls = 0;
  let observedBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/mine/personal_books") {
      return response.end(
        JSON.stringify({ data: created ? [bookFixture()] : [] }),
      );
    }
    if (url.pathname === "/api/books" && request.method === "POST") {
      createCalls += 1;
      void readJsonBody(request).then((body) => {
        observedBody = body;
        if (!options.doNotCreate) created = true;
        if (options.dropCreateResponse) {
          request.destroy();
          return;
        }
        response.end(JSON.stringify({ data: createdBookResponse() }));
      });
      return;
    }
    if (url.pathname === "/api/quick_links") quickLinkCalls += 1;
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
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "yuque-create-book-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(
    contractPath,
    JSON.stringify(contractFixture(), undefined, 2),
  );
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
    testConfig(directory, contractPath, origin),
    await ContractRegistry.load(contractPath),
    sessions,
  );
  return {
    create: () =>
      client.createPersonalBook("employee.a", {
        name: "yuque-web-mcp-e2e",
        description: "sandbox",
      }),
    calls: () => ({ create: createCalls, quickLink: quickLinkCalls }),
    body: () => observedBody,
  };
}

function createdBookResponse(): Record<string, unknown> {
  return {
    id: 44,
    name: "yuque-web-mcp-e2e",
    slug: "abc123",
    type: "Book",
    public: 0,
    extend_private: 0,
    organization_id: 0,
    user_id: 7,
  };
}

function bookFixture(): Record<string, unknown> {
  return {
    ...createdBookResponse(),
    items_count: 0,
    updated_at: "2026-08-16T00:00:00.000Z",
    user: { login: "alice", type: "User" },
  };
}

function contractFixture(): Record<string, unknown> {
  return {
    version: "create-book-test",
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
        capability: "create_book",
        verified: true,
        verifiedHostTypes: ["personal"],
        method: "POST",
        path: "/api/books",
        idempotent: false,
        liveWriteEnabled: true,
        requiredResponsePaths: [
          "data.id",
          "data.name",
          "data.slug",
          "data.type",
          "data.public",
          "data.extend_private",
          "data.organization_id",
          "data.user_id",
        ],
      },
    ],
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
    requestTimeoutMs: 100,
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
