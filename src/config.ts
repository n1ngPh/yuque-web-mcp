import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function required(name: string): string {
  const value = secretValue(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boundedPositiveInt(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = positiveInt(name, fallback);
  if (value > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return value;
}

export interface AppConfig {
  ownerId: string;
  mcpBearerToken: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  yuqueHost: string;
  personalYuqueHost: string;
  organization: string;
  dataDir: string;
  databasePath: string;
  contractPath: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  encryptionKey: Buffer;
  chromiumExecutable: string;
  loginTtlSeconds: number;
  changeTtlSeconds: number;
  requestTimeoutMs: number;
  writeConsistencyMode: "strict" | "best_effort";
  allowUnverifiedContracts: boolean;
  allowObjectDeletion?: boolean;
  allowPermissionChanges?: boolean;
  writeBookAllowlist?: string[];
  writeKillSwitch?: boolean;
  maxMcpSessions?: number;
  maxConcurrentRequests?: number;
  maxRequestsPerSession?: number;
  mcpSessionIdleSeconds?: number;
  maxRequestBodyBytes?: number;
  maxConcurrentLogins?: number;
  gracefulShutdownSeconds?: number;
  metricsEnabled?: boolean;
  allowInsecureHttp?: boolean;
  yuqueHttpsProxy?: string;
  yuqueCaFile?: string;
  smsCaptchaEnabled?: boolean;
  captchaPythonPath?: string;
  captchaSolvePath?: string;
  captchaBrowserPath?: string;
}

function decode32ByteSecret(name: string): Buffer {
  const value = required(name);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32)
    throw new Error(`${name} must be base64 for exactly 32 bytes`);
  return decoded;
}

export function loadConfig(): AppConfig {
  loadEnvironmentFile();
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden; configure a trusted CA file instead",
    );
  }
  const ownerId = required("MCP_OWNER_ID");
  if (!/^[A-Za-z0-9._@-]{1,128}$/.test(ownerId)) {
    throw new Error(
      "MCP_OWNER_ID must be 1-128 characters from A-Z, a-z, 0-9, . _ @ -",
    );
  }
  const mcpBearerToken = required("MCP_BEARER_TOKEN");
  if (Buffer.byteLength(mcpBearerToken, "utf8") < 32) {
    throw new Error("MCP_BEARER_TOKEN must contain at least 32 bytes");
  }
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const port = positiveInt("PORT", 3000);
  const dataDir = resolve(process.env.DATA_DIR?.trim() || "./runtime");
  const contractPath = resolve(
    process.env.CONTRACT_PATH?.trim() ||
      "./contracts/yuque-web-2026-08-14.json",
  );
  const publicBaseUrl = validatePublicBaseUrl(
    process.env.PUBLIC_BASE_URL?.trim() || `http://${host}:${port}`,
  );
  const allowInsecureHttp = strictBoolean("ALLOW_INSECURE_HTTP", false);
  if (
    new URL(publicBaseUrl).protocol === "http:" &&
    !isLoopbackHostname(new URL(publicBaseUrl).hostname) &&
    !allowInsecureHttp
  ) {
    throw new Error(
      "Non-loopback PUBLIC_BASE_URL must use HTTPS; set ALLOW_INSECURE_HTTP=true only for an explicitly accepted private-network deployment",
    );
  }
  const allowedHosts = splitList(process.env.MCP_ALLOWED_HOSTS);
  const yuqueHost = normalizeYuqueHost(
    process.env.YUQUE_HOST?.trim() || "https://www.yuque.com",
    "YUQUE_HOST",
  );
  const personalYuqueHost = normalizeYuqueHost(
    process.env.YUQUE_PERSONAL_HOST?.trim() || "https://www.yuque.com",
    "YUQUE_PERSONAL_HOST",
  );
  const writeBookAllowlist = splitList(
    process.env.YUQUE_WRITE_BOOK_ALLOWLIST,
  ).map((value) => normalizeBookUrl(value, [yuqueHost, personalYuqueHost]));

  if (
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host !== "localhost" &&
    allowedHosts.length === 0
  ) {
    throw new Error(
      "MCP_ALLOWED_HOSTS is required when binding to a non-loopback address",
    );
  }

  const chromiumExecutable =
    process.env.CHROMIUM_EXECUTABLE?.trim() || "/usr/bin/chromium";
  const captchaSolvePath = resolve(
    process.env.CAPTCHA_SOLVE_PATH?.trim() || "./captcha/solve.py",
  );

  return {
    ownerId,
    mcpBearerToken,
    host,
    port,
    publicBaseUrl,
    yuqueHost,
    personalYuqueHost,
    organization: process.env.YUQUE_ORGANIZATION?.trim() || "",
    dataDir,
    databasePath: resolve(dataDir, "state.db"),
    contractPath,
    allowedHosts,
    allowedOrigins: splitList(process.env.MCP_ALLOWED_ORIGINS),
    encryptionKey: decode32ByteSecret("SESSION_ENCRYPTION_KEY"),
    chromiumExecutable,
    loginTtlSeconds: positiveInt("LOGIN_TTL_SECONDS", 300),
    changeTtlSeconds: positiveInt("CHANGE_TTL_SECONDS", 600),
    requestTimeoutMs: positiveInt("YUQUE_REQUEST_TIMEOUT_MS", 15000),
    writeConsistencyMode: writeConsistencyMode(),
    allowUnverifiedContracts: process.env.ALLOW_UNVERIFIED_CONTRACTS === "true",
    allowObjectDeletion: strictBoolean("ALLOW_OBJECT_DELETION", false),
    allowPermissionChanges: strictBoolean("ALLOW_PERMISSION_CHANGES", false),
    writeBookAllowlist,
    writeKillSwitch: strictBoolean("WRITE_KILL_SWITCH", false),
    maxMcpSessions: boundedPositiveInt("MAX_MCP_SESSIONS", 32, 10_000),
    maxConcurrentRequests: boundedPositiveInt(
      "MAX_CONCURRENT_REQUESTS",
      16,
      10_000,
    ),
    maxRequestsPerSession: boundedPositiveInt(
      "MAX_REQUESTS_PER_SESSION",
      4,
      1_000,
    ),
    mcpSessionIdleSeconds: boundedPositiveInt(
      "MCP_SESSION_IDLE_SECONDS",
      1_800,
      86_400,
    ),
    maxRequestBodyBytes: boundedPositiveInt(
      "MAX_REQUEST_BODY_BYTES",
      1_572_864,
      16 * 1024 * 1024,
    ),
    maxConcurrentLogins: boundedPositiveInt("MAX_CONCURRENT_LOGINS", 2, 32),
    gracefulShutdownSeconds: boundedPositiveInt(
      "GRACEFUL_SHUTDOWN_SECONDS",
      30,
      300,
    ),
    metricsEnabled: strictBoolean("METRICS_ENABLED", true),
    allowInsecureHttp,
    yuqueHttpsProxy: optionalProxyUrl(process.env.YUQUE_HTTPS_PROXY),
    yuqueCaFile: optionalCaFile(process.env.YUQUE_CA_FILE),
    smsCaptchaEnabled: strictBoolean("SMS_CAPTCHA_ENABLED", false),
    captchaPythonPath: process.env.CAPTCHA_PYTHON_PATH?.trim() || "python3",
    captchaSolvePath,
    captchaBrowserPath:
      process.env.CAPTCHA_BROWSER_PATH?.trim() || chromiumExecutable,
  };
}

export function loadEnvironmentFile(): void {
  const configured = process.env.YUQUE_MCP_ENV_FILE?.trim();
  if (!configured) return;
  const path = privateRegularFile(configured, "YUQUE_MCP_ENV_FILE");
  const serialized = readFileSync(path, "utf8");
  for (const [index, raw] of serialized.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new Error(
        `YUQUE_MCP_ENV_FILE contains an invalid line at ${String(index + 1)}`,
      );
    }
    const name = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(
        `YUQUE_MCP_ENV_FILE contains an invalid key at ${String(index + 1)}`,
      );
    }
    if (process.env[name] === undefined) {
      process.env[name] = line.slice(separator + 1);
    }
  }
}

function writeConsistencyMode(): "strict" | "best_effort" {
  const value = process.env.WRITE_CONSISTENCY_MODE?.trim().toLowerCase();
  if (!value || value === "strict") return "strict";
  if (value === "best_effort") return "best_effort";
  throw new Error("WRITE_CONSISTENCY_MODE must be strict or best_effort");
}

function strictBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeBookUrl(value: string, allowedHosts: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("YUQUE_WRITE_BOOK_ALLOWLIST must contain absolute URLs");
  }
  if (!allowedHosts.includes(url.origin)) {
    throw new Error(
      "YUQUE_WRITE_BOOK_ALLOWLIST URLs must use a configured Yuque Host",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "YUQUE_WRITE_BOOK_ALLOWLIST URLs cannot contain credentials, a query or fragment",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(
      "YUQUE_WRITE_BOOK_ALLOWLIST entries must identify one exact knowledge base",
    );
  }
  let normalizedParts: string[];
  try {
    normalizedParts = parts.map((part) =>
      encodeURIComponent(decodeURIComponent(part)),
    );
  } catch {
    throw new Error(
      "YUQUE_WRITE_BOOK_ALLOWLIST contains malformed URL encoding",
    );
  }
  return `${url.origin}/${normalizedParts.join("/")}`;
}

function normalizeYuqueHost(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      `${label} must be an HTTPS origin without credentials, path, query or fragment`,
    );
  }
  return url.origin;
}

function secretValue(name: string): string | undefined {
  const direct = process.env[name];
  const fileVariable = `${name}_FILE`;
  const file = process.env[fileVariable]?.trim();
  if (direct !== undefined && file) {
    throw new Error(`${name} and ${fileVariable} cannot both be configured`);
  }
  if (!file) return direct;
  const path = privateRegularFile(file, fileVariable);
  return readFileSync(path, "utf8").replace(/[\r\n]+$/, "");
}

function privateRegularFile(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const link = lstatSync(value);
  if (link.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  const path = realpathSync(value);
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`${label} must identify a regular file`);
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`${label} cannot be group- or world-writable`);
  }
  return path;
}

function validatePublicBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must use HTTP(S) without credentials, query or fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopbackHostname(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function optionalProxyUrl(value: string | undefined): string | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("YUQUE_HTTPS_PROXY must be an absolute HTTP(S) URL");
  }
  if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("YUQUE_HTTPS_PROXY must use HTTP or HTTPS");
  }
  return url.toString();
}

function optionalCaFile(value: string | undefined): string | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  return privateRegularFile(configured, "YUQUE_CA_FILE");
}
