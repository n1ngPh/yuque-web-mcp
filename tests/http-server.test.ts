import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createApplication } from "../src/app.js";
import { startHttpServer } from "../src/http-server.js";
import type { AppConfig } from "../src/config.js";

describe("Streamable HTTP single-owner boundary", () => {
  it("authenticates every request and preserves independent MCP sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yuque-http-test-"));
    const port = await availablePort();
    const config = testConfig(dataDir, port);
    const app = await createApplication(config);
    const { server } = startHttpServer(app);

    try {
      await once(server, "listening");
      const mcpUrl = `http://127.0.0.1:${port}/mcp`;
      const unauthorized = await fetch(mcpUrl, {
        method: "POST",
        headers: mcpHeaders("invalid"),
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      const initializedA = await initialize(mcpUrl, config.mcpBearerToken, 1);
      const sessionA = initializedA.sessionId;
      expect(initializedA.payload.result?.instructions).toContain(
        "不要试图一次读取所有文档正文",
      );
      expect(initializedA.payload.result?.instructions).toContain(
        "yuque_list_all_docs",
      );
      const tools = await rpc(mcpUrl, config.mcpBearerToken, sessionA, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect(tools.response.status).toBe(200);
      expect(tools.payload.result?.tools).toHaveLength(30);

      const invalidSessionToken = await rpc(mcpUrl, "invalid", sessionA, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      });
      expect(invalidSessionToken.response.status).toBe(401);

      const initializedB = await initialize(mcpUrl, config.mcpBearerToken, 4);
      expect(initializedB.sessionId).not.toBe(sessionA);

      const localUser = await rpc(mcpUrl, config.mcpBearerToken, sessionA, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "yuque_get_user", arguments: {} },
      });
      expect(localUser.payload.result?.isError).not.toBe(true);
      expect(
        JSON.parse(localUser.payload.result?.content?.[0]?.text),
      ).toMatchObject({
        owner_id: "employee.a",
        connected: false,
        source: "verified_login_binding",
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      app.db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("restricts QR provider switching to the same origin and allow-list", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yuque-login-http-test-"));
    const port = await availablePort();
    const config = testConfig(dataDir, port);
    const app = await createApplication(config);
    vi.spyOn(app.login, "pageByPublicCode").mockImplementation((code) =>
      code === "test-code"
        ? "<!doctype html><title>语雀登录</title>"
        : undefined,
    );
    const interact = vi
      .spyOn(app.login, "selectProviderByPublicCode")
      .mockResolvedValue("accepted");
    const refresh = vi
      .spyOn(app.login, "refreshByPublicCode")
      .mockResolvedValue("accepted");
    const { server } = startHttpServer(app);

    try {
      await once(server, "listening");
      const url = `http://127.0.0.1:${port}/login/test-code`;
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("permissions-policy")).toContain("camera=()");
      expect(await page.text()).toContain("语雀登录");

      const expired = await fetch(
        `http://127.0.0.1:${port}/login/expired-code`,
      );
      expect(expired.status).toBe(410);
      expect(expired.headers.get("content-type")).toContain("text/html");
      expect(expired.headers.get("cache-control")).toBe("no-store");
      expect(expired.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      expect(await expired.text()).toContain("登录链接已失效");

      const missingOrigin = await postLoginProvider(url, undefined, {
        provider: "dingtalk",
      });
      expect(missingOrigin.status).toBe(403);

      const wrongOrigin = await postLoginProvider(
        url,
        "http://attacker.invalid",
        {
          provider: "dingtalk",
        },
      );
      expect(wrongOrigin.status).toBe(403);

      const unsupportedProvider = await postLoginProvider(
        url,
        config.publicBaseUrl,
        {
          provider: "password",
        },
      );
      expect(unsupportedProvider.status).toBe(400);

      const accepted = await postLoginProvider(url, config.publicBaseUrl, {
        provider: "wechat",
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ status: "accepted" });
      expect(interact).toHaveBeenCalledTimes(1);
      expect(interact).toHaveBeenCalledWith("test-code", "wechat");

      const refreshed = await postLoginRefresh(url, config.publicBaseUrl);
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toEqual({ status: "refreshed" });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith("test-code");

      const refreshWrongOrigin = await postLoginRefresh(
        url,
        "http://attacker.invalid",
      );
      expect(refreshWrongOrigin.status).toBe(403);

      const extraPath = await postLoginProvider(
        `${url}/extra`,
        config.publicBaseUrl,
        { provider: "alipay" },
      );
      expect(extraPath.status).toBe(404);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      app.db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

function postLoginProvider(
  loginUrl: string,
  origin: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${loginUrl}/provider`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

function postLoginRefresh(
  loginUrl: string,
  origin: string | undefined,
): Promise<Response> {
  return fetch(`${loginUrl}/refresh`, {
    method: "POST",
    headers: origin ? { Origin: origin } : {},
  });
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function initialize(
  url: string,
  token: string,
  id: number,
): Promise<{
  sessionId: string;
  payload: Record<string, any>;
}> {
  const response = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  const raw = await response.text();
  const data = raw
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  return { sessionId: sessionId!, payload: JSON.parse(data || raw) };
}

async function rpc(
  url: string,
  token: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{
  response: Response;
  payload: Record<string, any>;
}> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...mcpHeaders(token), "Mcp-Session-Id": sessionId },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: Record<string, any> = {};
  if (raw) {
    const data = raw
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    payload = JSON.parse(data || raw) as Record<string, any>;
  }
  return { response, payload };
}

function mcpHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
}

function testConfig(dataDir: string, port: number): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: randomBytes(32).toString("base64url"),
    host: "127.0.0.1",
    port,
    publicBaseUrl: `http://127.0.0.1:${port}`,
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
    writeConsistencyMode: "strict",
    allowUnverifiedContracts: false,
  };
}
