import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { YuqueWebClient } from "../src/yuque-client.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("personal knowledge-base collaboration", () => {
  it("merges owned and shared books with unambiguous paths and roles", async () => {
    const fixture = await createFixture({ includeShared: true });

    await expect(
      fixture.client.listAllBooks("employee.a", "personal"),
    ).resolves.toMatchObject([
      {
        name: "yuque-web-mcp-e2e",
        accessType: "owner",
        role: "owner",
        scopeLabel: "个人：Alice",
      },
      {
        name: "yuque-web-mcp-shared",
        ownerLogin: "bob",
        accessType: "collaborator",
        role: "reader",
        scopeLabel: "共享：bob",
      },
    ]);
  });

  it("invites, changes reader/editor role and removes with read-back", async () => {
    const fixture = await createFixture({});
    const invited = await fixture.client.prepareBookCollaboratorChange(
      "employee.a",
      {
        bookUrl: fixture.bookUrl,
        action: "invite",
        collaboratorLogin: "bob",
        role: "reader",
      },
    );
    await expect(
      fixture.client.changeBookCollaborator("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "invite",
        collaboratorLogin: "bob",
        role: "reader",
        baselineFingerprint: invited.baselineFingerprint,
      }),
    ).resolves.toMatchObject({
      status: "invited",
      collaborator_login: "bob",
      role: "reader",
    });

    const promoted = await fixture.client.prepareBookCollaboratorChange(
      "employee.a",
      {
        bookUrl: fixture.bookUrl,
        action: "change_role",
        collaboratorLogin: "bob",
        role: "editor",
      },
    );
    await expect(
      fixture.client.changeBookCollaborator("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "change_role",
        collaboratorLogin: "bob",
        role: "editor",
        baselineFingerprint: promoted.baselineFingerprint,
      }),
    ).resolves.toMatchObject({ status: "role_changed", role: "editor" });

    const removal = await fixture.client.prepareBookCollaboratorChange(
      "employee.a",
      {
        bookUrl: fixture.bookUrl,
        action: "remove",
        collaboratorLogin: "bob",
      },
    );
    await expect(
      fixture.client.changeBookCollaborator("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "remove",
        collaboratorLogin: "bob",
        baselineFingerprint: removal.baselineFingerprint,
      }),
    ).resolves.toMatchObject({ status: "removed" });
    expect(fixture.writeCalls()).toEqual({ invite: 1, role: 1, remove: 1 });
  });

  it("rejects a stale collaborator Preview before any write", async () => {
    const fixture = await createFixture({});
    const preview = await fixture.client.prepareBookCollaboratorChange(
      "employee.a",
      {
        bookUrl: fixture.bookUrl,
        action: "invite",
        collaboratorLogin: "bob",
        role: "reader",
      },
    );
    fixture.addUnrelatedCollaborator();

    await expect(
      fixture.client.changeBookCollaborator("employee.a", {
        bookUrl: fixture.bookUrl,
        action: "invite",
        collaboratorLogin: "bob",
        role: "reader",
        baselineFingerprint: preview.baselineFingerprint,
      }),
    ).rejects.toThrow("changed after Preview");
    expect(fixture.writeCalls()).toEqual({ invite: 0, role: 0, remove: 0 });
  });
});

async function createFixture(options: { includeShared?: boolean }): Promise<{
  client: YuqueWebClient;
  bookUrl: string;
  writeCalls: () => { invite: number; role: number; remove: number };
  addUnrelatedCollaborator: () => void;
}> {
  const ownerBook = bookFixture(44, "alice", "abc123", "yuque-web-mcp-e2e");
  const sharedBook = {
    ...bookFixture(99, "bob", "shared1", "yuque-web-mcp-shared"),
    role: 0,
    collaboration: { role: 0 },
  };
  let collaborators = [collaboration(1, "alice", 2)];
  const calls = { invite: 0, role: 0, remove: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/mine/personal_books") {
      return response.end(JSON.stringify({ data: [ownerBook] }));
    }
    if (url.pathname === "/api/mine/collaborate_books") {
      return response.end(
        JSON.stringify({ data: options.includeShared ? [sharedBook] : [] }),
      );
    }
    if (url.pathname === "/api/mine/collaborations") {
      return response.end(
        JSON.stringify({
          data: options.includeShared
            ? [
                {
                  id: 200,
                  role: 0,
                  status: 1,
                  target_id: 99,
                  target_type: "Book",
                },
              ]
            : [],
        }),
      );
    }
    if (url.pathname === "/api/collaborations" && request.method === "GET") {
      return response.end(
        JSON.stringify({
          data: collaborators,
          meta: { permission: 2, total: collaborators.length },
        }),
      );
    }
    if (url.pathname === "/api/users/complete" && request.method === "GET") {
      return response.end(
        JSON.stringify({
          data: [
            {
              id: 8,
              user_id: 8,
              login: "bob",
              name: "Bob",
              work_id: "",
            },
          ],
        }),
      );
    }
    if (url.pathname === "/api/collaborations" && request.method === "POST") {
      calls.invite += 1;
      void readJsonBody(request).then((body) => {
        collaborators = [
          ...collaborators,
          collaboration(55, "bob", Number(body.role)),
        ];
        response.end(JSON.stringify({ data: [collaborators.at(-1)] }));
      });
      return;
    }
    if (url.pathname === "/api/collaborations/55" && request.method === "PUT") {
      calls.role += 1;
      void readJsonBody(request).then((body) => {
        collaborators = collaborators.map((entry) =>
          entry.id === 55 ? { ...entry, role: Number(body.role) } : entry,
        );
        response.end(
          JSON.stringify({
            data: collaborators.find((entry) => entry.id === 55),
          }),
        );
      });
      return;
    }
    if (
      url.pathname === "/api/collaborations/55" &&
      request.method === "DELETE"
    ) {
      calls.remove += 1;
      const removed = collaborators.find((entry) => entry.id === 55);
      collaborators = collaborators.filter((entry) => entry.id !== 55);
      return response.end(JSON.stringify({ data: removed }));
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
  const directory = await mkdtemp(join(tmpdir(), "yuque-collaborator-test-"));
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
    writeCalls: () => ({ ...calls }),
    addUnrelatedCollaborator: () => {
      collaborators = [...collaborators, collaboration(77, "charlie", 0)];
    },
  };
}

function bookFixture(id: number, login: string, slug: string, name: string) {
  return {
    id,
    name,
    description: "sandbox",
    slug,
    type: "Book",
    public: 0,
    organization_id: 0,
    user_id: id,
    items_count: 0,
    updated_at: "2026-08-16T00:00:00.000Z",
    user: { login, type: "User" },
  };
}

function collaboration(id: number, login: string, role: number) {
  return {
    id,
    role,
    status: 1,
    owner: { login, name: login, type: "User" },
  };
}

function contractFixture(): Record<string, unknown> {
  const base = {
    verified: true,
    verifiedHostTypes: ["personal"],
  };
  return {
    version: "collaborator-test",
    verifiedAt: "2026-08-16T00:00:00.000Z",
    sourceBundles: [],
    endpoints: [
      endpoint(base, "list_personal_books", "GET", "/api/mine/personal_books"),
      endpoint(
        base,
        "list_collaborate_books",
        "GET",
        "/api/mine/collaborate_books",
      ),
      endpoint(
        base,
        "list_current_collaborations",
        "GET",
        "/api/mine/collaborations",
      ),
      endpoint(base, "list_book_collaborators", "GET", "/api/collaborations"),
      endpoint(base, "search_users", "GET", "/api/users/complete"),
      endpoint(
        base,
        "create_book_collaborator",
        "POST",
        "/api/collaborations",
        {
          liveWriteEnabled: true,
        },
      ),
      endpoint(
        base,
        "update_book_collaborator",
        "PUT",
        "/api/collaborations/{collaborationId}",
        { liveWriteEnabled: true },
      ),
      endpoint(
        base,
        "delete_book_collaborator",
        "DELETE",
        "/api/collaborations/{collaborationId}",
        {
          liveWriteEnabled: true,
          deletionEffect: "permission",
          targetResourceType: "Collaboration",
        },
      ),
    ],
  };
}

function endpoint(
  base: Record<string, unknown>,
  capability: string,
  method: string,
  path: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ...base,
    capability,
    method,
    path,
    idempotent: method === "GET",
    requiredResponsePaths: ["data"],
    ...extra,
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
    allowPermissionChanges: true,
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
