import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { AuthService } from "../src/auth.js";
import { createApplication } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("multi-tenant boundaries", () => {
  it("maps each Bearer token to its own owner", () => {
    const tokenA = "a".repeat(40);
    const tokenB = "b".repeat(40);
    const auth = new AuthService([
      { ownerId: "zhangsan", bearerToken: tokenA },
      { ownerId: "lisi", bearerToken: tokenB },
    ]);

    expect(auth.authenticate(tokenA)).toEqual({ ownerId: "zhangsan" });
    expect(auth.authenticate(tokenB)).toEqual({ ownerId: "lisi" });
    expect(auth.authenticate("c".repeat(40))).toBeUndefined();
    expect(auth.authenticate("")).toBeUndefined();
  });

  it("rejects a duplicate Bearer token across users", () => {
    const shared = "s".repeat(40);
    expect(
      () =>
        new AuthService([
          { ownerId: "zhangsan", bearerToken: shared },
          { ownerId: "lisi", bearerToken: shared },
        ]),
    ).toThrow("Duplicate bearer token");
  });

  it("isolates per-tenant databases, clients, and sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yuque-mt-test-"));
    temporaryDirectories.push(dataDir);
    const tokenA = "a".repeat(40);
    const tokenB = "b".repeat(40);
    const config: AppConfig = {
      ownerId: "zhangsan",
      mcpBearerToken: tokenA,
      users: [
        { ownerId: "zhangsan", bearerToken: tokenA },
        { ownerId: "lisi", bearerToken: tokenB },
      ],
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: "http://127.0.0.1:3000",
      yuqueHost: "https://example-team.yuque.com",
      personalYuqueHost: "https://www.yuque.com",
      organization: "example-team",
      dataDir,
      databasePath: join(dataDir, "state.db"),
      contractPath: resolve("contracts/yuque-web-2026-08-14.json"),
      allowedHosts: [],
      allowedOrigins: [],
      encryptionKey: randomBytes(32),
      chromiumExecutable: "/unused",
      loginTtlSeconds: 300,
      changeTtlSeconds: 600,
      requestTimeoutMs: 1_000,
      writeConsistencyMode: "best_effort",
      allowUnverifiedContracts: false,
    };

    const app = await createApplication(config);

    // 认证映射到不同 owner
    expect(app.auth.authenticate(tokenA)).toEqual({ ownerId: "zhangsan" });
    expect(app.auth.authenticate(tokenB)).toEqual({ ownerId: "lisi" });

    // getTenant 返回独立实例
    const tenantA = app.getTenant("zhangsan");
    const tenantB = app.getTenant("lisi");
    expect(tenantA.db).not.toBe(tenantB.db);
    expect(tenantA.client).not.toBe(tenantB.client);
    expect(tenantA.changes).not.toBe(tenantB.changes);
    expect(app.getTenant("zhangsan")).toBe(tenantA); // 缓存复用

    // 会话按 owner 隔离
    const now = new Date().toISOString();
    await app.sessions.save("zhangsan", {
      cookies: {}, csrfToken: "a",
      account: { id: "1", login: "zhangsan" }, savedAt: now,
    });
    await app.sessions.save("lisi", {
      cookies: {}, csrfToken: "b",
      account: { id: "2", login: "lisi" }, savedAt: now,
    });
    expect((await app.sessions.load("zhangsan"))?.account.login).toBe(
      "zhangsan",
    );
    expect((await app.sessions.load("lisi"))?.account.login).toBe("lisi");
    // 未登录的 owner 看不到他人会话
    expect(await app.sessions.load("unknown")).toBeUndefined();

    await app.close();
  });
});
