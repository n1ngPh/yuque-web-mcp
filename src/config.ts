import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
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
  allowUnverifiedContracts: boolean;
  allowObjectDeletion?: boolean;
  allowPermissionChanges?: boolean;
  writeBookAllowlist?: string[];
}

function decode32ByteSecret(name: string): Buffer {
  const value = required(name);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32)
    throw new Error(`${name} must be base64 for exactly 32 bytes`);
  return decoded;
}

export function loadConfig(): AppConfig {
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
  const publicBaseUrl =
    process.env.PUBLIC_BASE_URL?.trim() || `http://${host}:${port}`;
  const allowedHosts = splitList(process.env.MCP_ALLOWED_HOSTS);
  const writeBookAllowlist = splitList(
    process.env.YUQUE_WRITE_BOOK_ALLOWLIST,
  ).map(normalizeBookUrl);

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

  return {
    ownerId,
    mcpBearerToken,
    host,
    port,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    yuqueHost: (
      process.env.YUQUE_HOST?.trim() || "https://www.yuque.com"
    ).replace(/\/$/, ""),
    personalYuqueHost: (
      process.env.YUQUE_PERSONAL_HOST?.trim() || "https://www.yuque.com"
    ).replace(/\/$/, ""),
    organization: process.env.YUQUE_ORGANIZATION?.trim() || "",
    dataDir,
    databasePath: resolve(dataDir, "state.db"),
    contractPath,
    allowedHosts,
    allowedOrigins: splitList(process.env.MCP_ALLOWED_ORIGINS),
    encryptionKey: decode32ByteSecret("SESSION_ENCRYPTION_KEY"),
    chromiumExecutable:
      process.env.CHROMIUM_EXECUTABLE?.trim() || "/usr/bin/chromium",
    loginTtlSeconds: positiveInt("LOGIN_TTL_SECONDS", 300),
    changeTtlSeconds: positiveInt("CHANGE_TTL_SECONDS", 600),
    requestTimeoutMs: positiveInt("YUQUE_REQUEST_TIMEOUT_MS", 15000),
    allowUnverifiedContracts: process.env.ALLOW_UNVERIFIED_CONTRACTS === "true",
    allowObjectDeletion: strictBoolean("ALLOW_OBJECT_DELETION", false),
    allowPermissionChanges: strictBoolean("ALLOW_PERMISSION_CHANGES", false),
    writeBookAllowlist,
  };
}

function strictBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeBookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("YUQUE_WRITE_BOOK_ALLOWLIST must contain absolute URLs");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("YUQUE_WRITE_BOOK_ALLOWLIST URLs must use HTTP or HTTPS");
  }
  if (url.search || url.hash) {
    throw new Error(
      "YUQUE_WRITE_BOOK_ALLOWLIST URLs cannot contain a query or fragment",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(
      "YUQUE_WRITE_BOOK_ALLOWLIST entries must identify one exact knowledge base",
    );
  }
  return `${url.origin}/${parts.map(encodeURIComponent).join("/")}`;
}
