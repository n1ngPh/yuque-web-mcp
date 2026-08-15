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

interface ActiveSession {
  transport: StreamableHTTPServerTransport;
}

export function startHttpServer(app: Application) {
  const sessions = new Map<string, ActiveSession>();
  const allowedHosts = new Set([
    ...app.config.allowedHosts,
    `127.0.0.1:${app.config.port}`,
    `localhost:${app.config.port}`,
    `[::1]:${app.config.port}`,
  ]);
  const allowedOrigins = new Set(app.config.allowedOrigins);

  const server = createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      console.error("Request handling failed");
      if (!response.headersSent)
        sendJson(response, 500, { error: "Internal Server Error" });
      else response.end();
    });
  });

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

    if (path.startsWith("/login/")) {
      return handleLoginRoute(path, request, response, app);
    }

    if (path !== "/mcp") return sendJson(response, 404, { error: "Not Found" });
    if (!passesOriginGuard(request, response, allowedOrigins)) return;

    const owner = authenticateRequest(request, app);
    if (!owner) {
      response.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="yuque-web-mcp"',
      });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessionId = firstHeader(request.headers["mcp-session-id"]);
    if (sessionId) {
      const active = sessions.get(sessionId);
      if (!active)
        return sendMcpError(response, 404, -32001, "Session not found");
      await active.transport.handleRequest(request, response);
      return;
    }

    if (request.method !== "POST") {
      return sendMcpError(
        response,
        400,
        -32000,
        "Mcp-Session-Id header is required",
      );
    }
    const body = await readJsonBody(request, 1536 * 1024);
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
        sessions.set(id, { transport });
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
    console.log(
      `yuque-web-mcp listening on ${app.config.host}:${app.config.port}`,
    );
  });

  return { server, sessions };
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
    if (size > maxBytes) throw new Error("Request body exceeds limit");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : undefined;
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
