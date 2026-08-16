import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Application } from "./app.js";
import { createMcpServer } from "./mcp.js";
import { parseLoginProvider } from "./login-manager.js";
import { logger } from "./logger.js";
import { ServiceMetrics } from "./metrics.js";

interface ActiveSession {
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
  inFlight: number;
}

export function startHttpServer(app: Application) {
  const sessions = new Map<string, ActiveSession>();
  const metrics = new ServiceMetrics();
  let draining = false;
  let shutdownPromise: Promise<{ writesDrained: boolean }> | undefined;
  const allowedHosts = new Set([
    ...app.config.allowedHosts,
    `127.0.0.1:${app.config.port}`,
    `localhost:${app.config.port}`,
    `[::1]:${app.config.port}`,
  ]);
  const allowedOrigins = new Set(app.config.allowedOrigins);

  const server = createServer((request, response) => {
    const requestId = safeRequestId(request) ?? randomUUID();
    const startedAt = Date.now();
    response.setHeader("X-Request-Id", requestId);
    metrics.requestsTotal += 1;
    metrics.activeRequests += 1;
    response.once("finish", () => {
      metrics.activeRequests -= 1;
      if (response.statusCode >= 500) metrics.requestErrorsTotal += 1;
      logger.log(
        response.statusCode >= 500 ? "error" : "info",
        "http_request",
        {
          request_id: requestId,
          method: request.method ?? "UNKNOWN",
          path: safeLogPath(requestPath(request)),
          status: response.statusCode,
          duration_ms: Date.now() - startedAt,
        },
      );
    });
    handleRequest(request, response).catch((error: unknown) => {
      logger.log("error", "request_failed", {
        request_id: requestId,
        error_class: error instanceof Error ? error.name : "UnknownError",
      });
      if (!response.headersSent)
        sendJson(response, 500, { error: "Internal Server Error" });
      else response.end();
    });
  });

  const cleanupTimer = setInterval(() => {
    void expireIdleSessions();
  }, 60_000);
  cleanupTimer.unref();

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = requestPath(request);
    if (!passesHostGuard(request, response, allowedHosts)) return;

    if (path === "/healthz") {
      if (request.method !== "GET")
        return sendJson(response, 405, { error: "Method Not Allowed" });
      return sendJson(response, 200, { status: "ok" });
    }

    if (path === "/readyz") {
      if (request.method !== "GET")
        return sendJson(response, 405, { error: "Method Not Allowed" });
      const readiness = app.readiness();
      return sendJson(response, !draining && readiness.ready ? 200 : 503, {
        status: !draining && readiness.ready ? "ready" : "not_ready",
      });
    }

    if (path === "/metrics") {
      if (request.method !== "GET")
        return sendJson(response, 405, { error: "Method Not Allowed" });
      if (app.config.metricsEnabled === false)
        return sendJson(response, 404, { error: "Not Found" });
      const owner = authenticateRequest(request, app);
      if (!owner) {
        metrics.authenticationFailuresTotal += 1;
        return sendUnauthorized(response);
      }
      const readiness = app.readiness();
      return sendMetrics(
        response,
        metrics.render({
          activeSessions: sessions.size,
          activeLogins: app.login.activeCount(),
          activeWrites: app.changes.activeWriteCount(),
          ready: !draining && readiness.ready,
        }),
      );
    }

    if (draining) {
      return sendJson(response, 503, { error: "Service is shutting down" });
    }

    if (metrics.activeRequests > (app.config.maxConcurrentRequests ?? 16)) {
      metrics.rateLimitedTotal += 1;
      response.setHeader("Retry-After", "1");
      return sendJson(response, 503, { error: "Too many concurrent requests" });
    }

    if (path.startsWith("/login/")) {
      return handleLoginRoute(path, request, response, app);
    }

    if (path !== "/mcp") return sendJson(response, 404, { error: "Not Found" });
    if (!passesOriginGuard(request, response, allowedOrigins)) return;

    const owner = authenticateRequest(request, app);
    if (!owner) {
      metrics.authenticationFailuresTotal += 1;
      return sendUnauthorized(response);
    }

    const sessionId = firstHeader(request.headers["mcp-session-id"]);
    if (sessionId) {
      const active = sessions.get(sessionId);
      if (!active)
        return sendMcpError(response, 404, -32001, "Session not found");
      if (active.inFlight >= (app.config.maxRequestsPerSession ?? 4)) {
        metrics.rateLimitedTotal += 1;
        response.setHeader("Retry-After", "1");
        return sendMcpError(
          response,
          429,
          -32002,
          "Too many concurrent requests for this session",
        );
      }
      active.inFlight += 1;
      active.lastUsedAt = Date.now();
      try {
        await active.transport.handleRequest(request, response);
        return;
      } finally {
        active.inFlight -= 1;
        active.lastUsedAt = Date.now();
      }
    }

    if (request.method !== "POST") {
      return sendMcpError(
        response,
        400,
        -32000,
        "Mcp-Session-Id header is required",
      );
    }
    if (sessions.size >= (app.config.maxMcpSessions ?? 32)) {
      await expireIdleSessions();
      if (sessions.size >= (app.config.maxMcpSessions ?? 32)) {
        metrics.rateLimitedTotal += 1;
        response.setHeader("Retry-After", "5");
        return sendMcpError(response, 503, -32003, "MCP session limit reached");
      }
    }
    let body: unknown;
    try {
      body = await readJsonBody(
        request,
        app.config.maxRequestBodyBytes ?? 1536 * 1024,
      );
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return sendMcpError(response, error.status, -32700, error.message);
      }
      throw error;
    }
    if (!isInitializeRequest(body)) {
      return sendMcpError(
        response,
        400,
        -32000,
        "Expected an initialize request",
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastUsedAt: Date.now(), inFlight: 0 });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const mcpServer = createMcpServer(owner.ownerId, app);
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  server.listen(app.config.port, app.config.host, () => {
    logger.log("info", "server_listening", {
      host: app.config.host,
      port: app.config.port,
      write_mode: app.config.writeConsistencyMode,
      write_kill_switch: app.config.writeKillSwitch === true,
    });
  });

  async function expireIdleSessions(): Promise<void> {
    const cutoff =
      Date.now() - (app.config.mcpSessionIdleSeconds ?? 1_800) * 1_000;
    const expired = [...sessions.entries()].filter(
      ([, active]) => active.inFlight === 0 && active.lastUsedAt <= cutoff,
    );
    await Promise.all(
      expired.map(async ([id, active]) => {
        sessions.delete(id);
        await active.transport.close().catch(() => undefined);
      }),
    );
  }

  function shutdown(): Promise<{ writesDrained: boolean }> {
    shutdownPromise ??= (async () => {
      draining = true;
      clearInterval(cleanupTimer);
      app.changes.beginShutdown();
      const timeoutMs = (app.config.gracefulShutdownSeconds ?? 30) * 1_000;
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await app.login.shutdown();
      const writesDrained = await app.changes.waitForIdle(timeoutMs);
      await Promise.all(
        [...sessions.values()].map((active) =>
          active.transport.close().catch(() => undefined),
        ),
      );
      sessions.clear();
      server.closeIdleConnections();
      if (!writesDrained) server.closeAllConnections();
      let closeTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          serverClosed,
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
      await app.client.close();
      logger.log(writesDrained ? "info" : "error", "server_shutdown", {
        writes_drained: writesDrained,
      });
      return { writesDrained };
    })();
    return shutdownPromise;
  }

  return { server, sessions, metrics, shutdown };
}

function authenticateRequest(request: IncomingMessage, app: Application) {
  const authorization = firstHeader(request.headers.authorization);
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return app.auth.authenticate(authorization.slice("Bearer ".length));
}

function handleLoginRoute(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  app: Application,
): Promise<void> | void {
  const parts = path.split("/").filter(Boolean);
  const code = parts[1];
  const suffix = parts[2];
  if (!code || parts.length > 3)
    return sendJson(response, 404, { error: "Not Found" });

  if (!suffix) {
    if (request.method !== "GET")
      return sendJson(response, 405, { error: "Method Not Allowed" });
    const html = app.login.pageByPublicCode(code);
    if (!html) return sendExpiredLoginPage(response);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(html);
    return;
  }
  if (suffix === "image") {
    if (request.method !== "GET")
      return sendJson(response, 405, { error: "Method Not Allowed" });
    const image = app.login.screenshotByPublicCode(code);
    if (!image)
      return sendJson(response, 404, { error: "Login image not ready" });
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(image);
    return;
  }
  if (suffix === "status") {
    if (request.method !== "GET")
      return sendJson(response, 405, { error: "Method Not Allowed" });
    const status = app.login.statusByPublicCode(code);
    if (!status)
      return sendJson(response, 404, { error: "Login link not found" });
    return sendJson(
      response,
      200,
      status as unknown as Record<string, unknown>,
    );
  }
  if (suffix === "provider") {
    if (request.method !== "POST")
      return sendJson(response, 405, { error: "Method Not Allowed" });
    if (!passesLoginOriginGuard(request, response, app.config.publicBaseUrl))
      return;
    const contentType = firstHeader(request.headers["content-type"]);
    if (!contentType?.toLowerCase().startsWith("application/json"))
      return sendJson(response, 415, { error: "Unsupported Media Type" });
    return handleLoginProvider(code, request, response, app);
  }
  if (suffix === "refresh") {
    if (request.method !== "POST")
      return sendJson(response, 405, { error: "Method Not Allowed" });
    if (!passesLoginOriginGuard(request, response, app.config.publicBaseUrl))
      return;
    return handleLoginRefresh(code, response, app);
  }
  return sendJson(response, 404, { error: "Not Found" });
}

async function handleLoginProvider(
  code: string,
  request: IncomingMessage,
  response: ServerResponse,
  app: Application,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request, 256);
  } catch {
    return sendJson(response, 400, { error: "Invalid login provider" });
  }
  const provider =
    body && typeof body === "object" && !Array.isArray(body)
      ? parseLoginProvider((body as Record<string, unknown>).provider)
      : undefined;
  if (
    !provider ||
    Object.keys(body as Record<string, unknown>).some(
      (key) => key !== "provider",
    )
  )
    return sendJson(response, 400, { error: "Invalid login provider" });
  const result = await app.login.selectProviderByPublicCode(code, provider);
  if (result === "not_found")
    return sendJson(response, 404, { error: "Login link not found" });
  if (result === "not_ready")
    return sendJson(response, 409, { error: "Login page is not ready" });
  return sendJson(response, 200, { status: "accepted" });
}

async function handleLoginRefresh(
  code: string,
  response: ServerResponse,
  app: Application,
): Promise<void> {
  const result = await app.login.refreshByPublicCode(code);
  if (result === "not_found")
    return sendJson(response, 410, { error: "Login link expired" });
  if (result === "not_ready")
    return sendJson(response, 409, { error: "Login QR is not ready" });
  return sendJson(response, 200, { status: "refreshed" });
}

function passesHostGuard(
  request: IncomingMessage,
  response: ServerResponse,
  allowedHosts: Set<string>,
): boolean {
  const host = firstHeader(request.headers.host);
  if (!host || !allowedHosts.has(host)) {
    sendJson(response, 403, { error: "Forbidden" });
    return false;
  }
  return true;
}

function passesOriginGuard(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: Set<string>,
): boolean {
  const origin = firstHeader(request.headers.origin);
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, { error: "Forbidden" });
    return false;
  }
  return true;
}

function passesLoginOriginGuard(
  request: IncomingMessage,
  response: ServerResponse,
  publicBaseUrl: string,
): boolean {
  const origin = firstHeader(request.headers.origin);
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(publicBaseUrl).origin;
  } catch {
    sendJson(response, 403, { error: "Forbidden" });
    return false;
  }
  if (origin !== expectedOrigin) {
    sendJson(response, 403, { error: "Forbidden" });
    return false;
  }
  return true;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBytes)
      throw new RequestBodyError(413, "Request body exceeds limit");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    throw new RequestBodyError(400, "Invalid JSON request body");
  }
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Bearer realm="yuque-web-mcp"',
  });
  response.end(JSON.stringify({ error: "Unauthorized" }));
}

function sendMetrics(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function safeRequestId(request: IncomingMessage): string | undefined {
  const candidate = firstHeader(request.headers["x-request-id"]);
  return candidate && /^[A-Za-z0-9._-]{8,128}$/.test(candidate)
    ? candidate
    : undefined;
}

function safeLogPath(path: string): string {
  if (!path.startsWith("/login/")) return path;
  const parts = path.split("/").filter(Boolean);
  return `/login/:code${parts[2] ? `/${parts[2]}` : ""}`;
}

function sendExpiredLoginPage(response: ServerResponse): void {
  response.writeHead(410, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>登录链接已失效</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f5f7fb;color:#182230}
    main{width:min(32rem,calc(100% - 3rem));box-sizing:border-box;padding:2rem;border:1px solid #dfe4ec;border-radius:1rem;background:#fff;box-shadow:0 1rem 3rem rgba(18,32,56,.08)}
    h1{margin:0 0 .75rem;font-size:1.5rem}p{margin:.5rem 0;line-height:1.7;color:#526071}.hint{margin-top:1.25rem;padding:.8rem 1rem;border-radius:.65rem;background:#f0f4fa;color:#334155}
    @media(prefers-color-scheme:dark){body{background:#111827;color:#f8fafc}main{background:#1f2937;border-color:#374151}p{color:#cbd5e1}.hint{background:#273449;color:#e2e8f0}}
  </style>
</head>
<body>
  <main>
    <h1>登录链接已失效</h1>
    <p>这是一次性扫码登录链接，默认有效期为5分钟，过期后不会继续保留二维码或登录页面。</p>
    <p class="hint">请返回智能体重新调用 yuque_login_begin，获取新的扫码登录链接。</p>
  </main>
</body>
</html>`);
}

function sendMcpError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  sendJson(response, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}
