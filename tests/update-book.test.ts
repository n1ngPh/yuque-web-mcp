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

describe("private personal knowledge-base update", () => {
  it("sends only changed fields and verifies list read-back", async () => {
    const fixture = await createFixture({});
    const preview = await fixture.prepare({
      name: "yuque-web-mcp-renamed",
      description: "updated description",
    });

    await expect(
      fixture.update({
        name: preview.name,
        description: preview.description,
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({
      status: "updated",
      name: "yuque-web-mcp-renamed",
      description: "updated description",
      reconciledAfterUnknownResponse: false,
    });
    expect(fixture.calls()).toBe(1);
    expect(fixture.body()).toEqual({
      description: "updated description",
      name: "yuque-web-mcp-renamed",
    });
  });

  it("rejects a stale Preview before sending a write", async () => {
    const fixture = await createFixture({});
    const preview = await fixture.prepare({ name: "yuque-web-mcp-renamed" });
    fixture.mutateOutsidePreview();

    await expect(
      fixture.update({
        name: preview.name,
        description: preview.description,
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).rejects.toThrow("changed after Preview");
    expect(fixture.calls()).toBe(0);
  });

  it("reconciles a dropped response without retrying PUT", async () => {
    const fixture = await createFixture({ dropUpdateResponse: true });
    const preview = await fixture.prepare({ description: "updated" });

    await expect(
      fixture.update({
        name: preview.name,
        description: preview.description,
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).resolves.toMatchObject({ reconciledAfterUnknownResponse: true });
    expect(fixture.calls()).toBe(1);
  });

  it("does not retry when a dropped request changed nothing", async () => {
    const fixture = await createFixture({
      dropUpdateResponse: true,
      doNotUpdate: true,
    });
    const preview = await fixture.prepare({ description: "updated" });

    await expect(
      fixture.update({
        name: preview.name,
        description: preview.description,
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).rejects.toThrow();
    expect(fixture.calls()).toBe(1);
  });
});

interface FixtureOptions {
  dropUpdateResponse?: boolean;
  doNotUpdate?: boolean;
}

async function createFixture(options: FixtureOptions): Promise<{
  prepare: (input: {
    name?: string;
    description?: string;
  }) => ReturnType<YuqueWebClient["preparePersonalBookUpdate"]>;
  update: (input: {
    name: string;
    description: string;
    baselineFingerprint: string;
  }) => ReturnType<YuqueWebClient["updatePersonalBook"]>;
  calls: () => number;
  body: () => Record<string, unknown> | undefined;
  mutateOutsidePreview: () => void;
}> {
  let book = bookFixture();
  let updateCalls = 0;
  let observedBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/mine/personal_books") {
      return response.end(JSON.stringify({ data: [book] }));
    }
    if (url.pathname === "/api/books/44" && request.method === "PUT") {
      updateCalls += 1;
      void readJsonBody(request).then((body) => {
        observedBody = body;
        if (!options.doNotUpdate) {
          book = {
            ...book,
            ...body,
            updated_at: "2026-08-16T00:01:00.000Z",
          };
        }
        if (options.dropUpdateResponse) {
          request.destroy();
          return;
        }
        response.end(JSON.stringify({ data: { ...book, user: undefined } }));
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
  const directory = await mkdtemp(join(tmpdir(), "yuque-update-book-test-"));
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
    prepare: (input) =>
      client.preparePersonalBookUpdate("employee.a", { bookUrl, ...input }),
    update: (input) =>
      client.updatePersonalBook("employee.a", { bookUrl, ...input }),
    calls: () => updateCalls,
    body: () => observedBody,
    mutateOutsidePreview: () => {
      book = {
        ...book,
        description: "external update",
        updated_at: "2026-08-16T00:00:30.000Z",
      };
    },
  };
}

function bookFixture(): Record<string, unknown> {
  return {
    id: 44,
    name: "yuque-web-mcp-e2e",
    description: "baseline",
    slug: "abc123",
    type: "Book",
    public: 0,
    extend_private: 0,
    organization_id: 0,
    user_id: 7,
    items_count: 0,
    updated_at: "2026-08-16T00:00:00.000Z",
    user: { login: "alice", type: "User" },
  };
}

function contractFixture(): Record<string, unknown> {
  return {
    version: "update-book-test",
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
        capability: "update_book",
        verified: true,
        verifiedHostTypes: ["personal"],
        method: "PUT",
        path: "/api/books/{bookId}",
        idempotent: false,
        liveWriteEnabled: true,
        requiredResponsePaths: [
          "data.id",
          "data.name",
          "data.description",
          "data.slug",
          "data.public",
          "data.user_id",
          "data.organization_id",
        ],
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
    requestTimeoutMs: 100,
    writeConsistencyMode: "best_effort",
    allowUnverifiedContracts: false,
    writeBookAllowlist: [bookUrl],
  };
}

async function readJsonBody(
  request: NodeJS.ReadableStream,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as Record<string, unknown>;
}
