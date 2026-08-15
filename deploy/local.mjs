import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseRuntimeDir = join(projectRoot, "runtime");
const localProfile = parseLocalProfile(process.env.LOCAL_PROFILE);
const runtimeDir = localProfile
  ? join(baseRuntimeDir, "profiles", localProfile)
  : baseRuntimeDir;
const envPath = join(runtimeDir, "local.env");
const command = process.argv[2] || "serve";
const commandArgs = process.argv.slice(3);

const localEnvironment = await loadOrCreateEnvironment();
const entries = {
  serve: "dist/src/index.js",
  admin: "dist/src/admin.js",
};
const entry = entries[command];
if (!entry) {
  throw new Error("Usage: local.mjs serve|admin [arguments]");
}

const child = spawn(
  process.execPath,
  [join(projectRoot, entry), ...commandArgs],
  {
    cwd: projectRoot,
    env: { ...process.env, ...localEnvironment },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

async function loadOrCreateEnvironment() {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  let serialized;
  try {
    serialized = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (localProfile && !process.env.LOCAL_PORT) {
      throw new Error(
        "LOCAL_PORT is required when creating a non-default LOCAL_PROFILE",
      );
    }
    const port = positivePort(process.env.LOCAL_PORT || "18080");
    const browser = await findBrowser();
    serialized = [
      "YUQUE_HOST=https://www.yuque.com",
      "YUQUE_PERSONAL_HOST=https://www.yuque.com",
      "YUQUE_ORGANIZATION=",
      "HOST=127.0.0.1",
      `PORT=${port}`,
      `PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
      `MCP_ALLOWED_HOSTS=127.0.0.1:${port},localhost:${port}`,
      "MCP_ALLOWED_ORIGINS=",
      `DATA_DIR=${runtimeDir}`,
      `CONTRACT_PATH=${join(projectRoot, "contracts/yuque-web-2026-08-14.json")}`,
      `MCP_OWNER_ID=${localProfile ? `local-${localProfile}` : "local-owner"}`,
      `MCP_BEARER_TOKEN=${randomBytes(32).toString("base64url")}`,
      `SESSION_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
      `CHROMIUM_EXECUTABLE=${browser}`,
      "LOGIN_TTL_SECONDS=300",
      "CHANGE_TTL_SECONDS=600",
      "YUQUE_REQUEST_TIMEOUT_MS=15000",
      "ALLOW_UNVERIFIED_CONTRACTS=false",
      "ALLOW_OBJECT_DELETION=false",
      "ALLOW_PERMISSION_CHANGES=false",
      "YUQUE_WRITE_BOOK_ALLOWLIST=",
      "",
    ].join("\n");
    await writeFile(envPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    process.stdout.write(`Created private local configuration: ${envPath}\n`);
  }
  let parsed = parseEnvironment(serialized);
  const additions = [];
  if (!parsed.MCP_OWNER_ID) {
    additions.push(`MCP_OWNER_ID=${await inferLegacyOwner()}`);
  }
  if (!parsed.MCP_BEARER_TOKEN) {
    additions.push(`MCP_BEARER_TOKEN=${randomBytes(32).toString("base64url")}`);
  }
  if (additions.length > 0) {
    serialized = `${serialized.trimEnd()}\n${additions.join("\n")}\n`;
    await writeFile(envPath, serialized, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(
      "Upgraded private local configuration for single-owner mode.\n",
    );
    parsed = parseEnvironment(serialized);
  }
  await chmod(envPath, 0o600);
  for (const required of [
    "MCP_OWNER_ID",
    "MCP_BEARER_TOKEN",
    "SESSION_ENCRYPTION_KEY",
    "DATA_DIR",
    "CONTRACT_PATH",
  ]) {
    if (!parsed[required]) throw new Error(`Missing ${required} in ${envPath}`);
  }
  return parsed;
}

async function inferLegacyOwner() {
  if (localProfile) return `local-${localProfile}`;
  const legacyPath = join(baseRuntimeDir, "metadata.db");
  try {
    const imported = await import("better-sqlite3");
    const Database = imported.default;
    const database = new Database(legacyPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = database
        .prepare(
          `SELECT employee_id FROM employees
           WHERE yuque_account_encrypted IS NOT NULL
           ORDER BY updated_at DESC`,
        )
        .all();
      if (rows.length === 1 && typeof rows[0]?.employee_id === "string") {
        return rows[0].employee_id;
      }
    } finally {
      database.close();
    }
  } catch {
    // No compatible legacy database; a fresh login will bind local-owner.
  }
  return "local-owner";
}

function parseEnvironment(serialized) {
  const values = {};
  for (const line of serialized.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function positivePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("LOCAL_PORT must be between 1 and 65535");
  }
  return port;
}

function parseLocalProfile(value) {
  const profile = value?.trim().toLowerCase();
  if (!profile || profile === "default") return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error(
      "LOCAL_PROFILE must be 1-64 lowercase letters, digits, dot, underscore or hyphen",
    );
  }
  return profile;
}

async function findBrowser() {
  const candidates = [
    process.env.CHROMIUM_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next supported local browser path.
    }
  }
  throw new Error(
    "No Chromium-compatible browser found; set CHROMIUM_EXECUTABLE before first local start",
  );
}
