import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "../src/config.js";
import { CryptoBox } from "../src/crypto.js";
import { AppDatabase, type PendingChangeRow } from "../src/db.js";
import {
  createRuntimeBackup,
  restoreRuntimeBackup,
  rotateBearerToken,
  rotateEncryptionKey,
} from "../src/maintenance.js";
import { SessionStore } from "../src/session-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("offline maintenance", () => {
  it("creates a verified backup and restores database and session state", async () => {
    const root = await temporaryRoot();
    const config = await fixtureConfig(root);
    const crypto = new CryptoBox(config.encryptionKey);
    const database = new AppDatabase(config.databasePath);
    database.insertPendingChange(pendingRow("change-before", crypto, config));
    const sessions = new SessionStore(config.dataDir, crypto, config.ownerId);
    await sessions.save(config.ownerId, fixtureSession("before"));
    const backup = join(root, "backup");
    await createRuntimeBackup(config, database, backup);
    database.close();

    const changed = new AppDatabase(config.databasePath);
    changed.insertPendingChange(pendingRow("change-after", crypto, config));
    changed.close();
    await sessions.save(config.ownerId, fixtureSession("after"));

    const restored = await restoreRuntimeBackup(
      config,
      backup,
      `RESTORE:${config.ownerId}`,
    );
    expect(restored).toMatchObject({
      status: "restored",
      restart_required: true,
    });
    const verified = new AppDatabase(config.databasePath);
    expect(verified.getPendingChange("change-before")).toBeTruthy();
    expect(verified.getPendingChange("change-after")).toBeUndefined();
    verified.close();
    expect((await sessions.load(config.ownerId))?.account.login).toBe("before");
  });

  it("rotates token and encryption key while preserving encrypted state", async () => {
    const root = await temporaryRoot();
    const config = await fixtureConfig(root);
    const oldCrypto = new CryptoBox(config.encryptionKey);
    const database = new AppDatabase(config.databasePath);
    database.insertPendingChange(
      pendingRow("change-rotate", oldCrypto, config),
    );
    database.close();
    const sessions = new SessionStore(
      config.dataDir,
      oldCrypto,
      config.ownerId,
    );
    await sessions.save(config.ownerId, fixtureSession("rotate-user"));

    const token = await rotateBearerToken(config);
    expect(token.bearer_token).toHaveLength(64);
    expect(await readEnvironmentValue(config, "MCP_BEARER_TOKEN")).toBe(
      token.bearer_token,
    );

    const result = await rotateEncryptionKey(config);
    expect(result).toMatchObject({
      status: "encryption_key_rotated",
      re_encrypted_pending_changes: 1,
      session_re_encrypted: true,
    });
    const nextKey = Buffer.from(
      await readEnvironmentValue(config, "SESSION_ENCRYPTION_KEY"),
      "base64",
    );
    expect(nextKey).not.toEqual(config.encryptionKey);
    const nextCrypto = new CryptoBox(nextKey);
    const rotatedDatabase = new AppDatabase(config.databasePath);
    const row = rotatedDatabase.getPendingChange("change-rotate")!;
    expect(
      nextCrypto.decrypt(
        row.encrypted_payload,
        `yuque-change:${config.ownerId}:change-rotate`,
      ),
    ).toEqual({ value: "change-rotate" });
    rotatedDatabase.close();
    const rotatedSessions = new SessionStore(
      config.dataDir,
      nextCrypto,
      config.ownerId,
    );
    expect((await rotatedSessions.load(config.ownerId))?.account.login).toBe(
      "rotate-user",
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "yuque-maintenance-"));
  temporaryDirectories.push(path);
  return path;
}

async function fixtureConfig(root: string): Promise<AppConfig> {
  const dataDir = join(root, "data");
  const envPath = join(root, "service.env");
  const encryptionKey = randomBytes(32);
  await writeFile(
    envPath,
    [
      `MCP_BEARER_TOKEN=${"a".repeat(48)}`,
      `SESSION_ENCRYPTION_KEY=${encryptionKey.toString("base64")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  vi.stubEnv("YUQUE_MCP_ENV_FILE", envPath);
  return {
    ownerId: "employee.a",
    mcpBearerToken: "a".repeat(48),
    host: "127.0.0.1",
    port: 18080,
    publicBaseUrl: "http://127.0.0.1:18080",
    yuqueHost: "https://www.yuque.com",
    personalYuqueHost: "https://www.yuque.com",
    organization: "",
    dataDir,
    databasePath: join(dataDir, "state.db"),
    contractPath: resolve("contracts/yuque-web-2026-08-14.json"),
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey,
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 1_000,
    writeConsistencyMode: "strict",
    allowUnverifiedContracts: false,
  };
}

function pendingRow(
  id: string,
  crypto: CryptoBox,
  config: AppConfig,
): PendingChangeRow {
  const now = new Date().toISOString();
  return {
    change_id: id,
    kind: "update_doc",
    encrypted_payload: crypto.encrypt(
      { value: id },
      `yuque-change:${config.ownerId}:${id}`,
    ),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    created_at: now,
    updated_at: now,
    state: "previewed",
    diff_digest: "digest",
    has_deletions: 0,
    target_hash: "target",
    error_code: null,
  };
}

function fixtureSession(login: string) {
  return {
    cookies: { cookies: [] },
    csrfToken: "csrf",
    account: { id: "1", login },
    savedAt: new Date().toISOString(),
  };
}

async function readEnvironmentValue(
  config: AppConfig,
  name: string,
): Promise<string> {
  void config;
  const serialized = await readFile(process.env.YUQUE_MCP_ENV_FILE!, "utf8");
  const line = serialized
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found`);
  return line.slice(name.length + 1);
}
