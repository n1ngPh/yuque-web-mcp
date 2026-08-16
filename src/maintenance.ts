import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { AppConfig } from "./config.js";
import { CryptoBox } from "./crypto.js";
import { AppDatabase } from "./db.js";
import { assertRuntimeStopped } from "./runtime-lock.js";
import { SessionStore } from "./session-store.js";

interface BackupManifest {
  schema_version: 1;
  owner_hash: string;
  created_at: string;
  contains_encryption_key: boolean;
  requires_matching_encryption_key: boolean;
  files: Record<string, string>;
}

export async function createRuntimeBackup(
  config: AppConfig,
  database: AppDatabase,
  destination: string,
  options: { includeEncryptionKey?: boolean } = {},
): Promise<Record<string, unknown>> {
  const target = validateBackupDestination(config.dataDir, destination);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  try {
    await database.backup(join(target, "state.db"));
    await chmod(join(target, "state.db"), 0o600);
    await copyOptionalPrivateFile(
      join(config.dataDir, "session.enc"),
      join(target, "session.enc"),
    );
    if (options.includeEncryptionKey) {
      await writeFile(
        join(target, "recovery-key"),
        `${config.encryptionKey.toString("base64")}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    }
    const files = await backupDigests(target);
    const manifest: BackupManifest = {
      schema_version: 1,
      owner_hash: ownerHash(config.ownerId),
      created_at: new Date().toISOString(),
      contains_encryption_key: options.includeEncryptionKey === true,
      requires_matching_encryption_key: options.includeEncryptionKey !== true,
      files,
    };
    await writeFile(
      join(target, "backup.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    return {
      status: "backed_up",
      backup_directory: target,
      contains_encryption_key: manifest.contains_encryption_key,
      requires_matching_encryption_key:
        manifest.requires_matching_encryption_key,
    };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreRuntimeBackup(
  config: AppConfig,
  source: string,
  confirmation: string,
): Promise<Record<string, unknown>> {
  if (confirmation !== `RESTORE:${config.ownerId}`) {
    throw new Error(
      "Restore confirmation must exactly equal RESTORE:<owner-id>",
    );
  }
  await assertRuntimeStopped(config.dataDir);
  const backup = await verifyBackup(config, source);
  const rollback = `${resolve(config.dataDir)}.pre-restore-${timestamp()}`;
  const currentDatabase = new AppDatabase(config.databasePath);
  try {
    await createRuntimeBackup(config, currentDatabase, rollback, {
      includeEncryptionKey: true,
    });
  } finally {
    currentDatabase.close();
  }
  try {
    await installBackupFiles(config, backup);
    const recoveryKeyPath = join(backup, "recovery-key");
    try {
      const encoded = (await readFile(recoveryKeyPath, "utf8")).trim();
      if (Buffer.from(encoded, "base64").length !== 32) {
        throw new Error("Backup recovery key is invalid");
      }
      await writeConfiguredSecret("SESSION_ENCRYPTION_KEY", `${encoded}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    const rollbackBackup = await verifyBackup(config, rollback);
    await installBackupFiles(config, rollbackBackup);
    throw error;
  }
  return {
    status: "restored",
    source: backup,
    rollback_directory: rollback,
    encryption_key_restored: await fileExists(join(backup, "recovery-key")),
    restart_required: true,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function rotateBearerToken(
  config: AppConfig,
): Promise<{ status: string; bearer_token: string; restart_required: true }> {
  await assertRuntimeStopped(config.dataDir);
  const token = randomBytes(48).toString("base64url");
  await writeConfiguredSecret("MCP_BEARER_TOKEN", `${token}\n`);
  return {
    status: "bearer_token_rotated",
    bearer_token: token,
    restart_required: true,
  };
}

export async function rotateEncryptionKey(
  config: AppConfig,
): Promise<Record<string, unknown>> {
  await assertRuntimeStopped(config.dataDir);
  const database = new AppDatabase(config.databasePath);
  const recovery = `${resolve(config.dataDir)}.pre-key-rotation-${timestamp()}`;
  await createRuntimeBackup(config, database, recovery, {
    includeEncryptionKey: true,
  });
  const oldCrypto = new CryptoBox(config.encryptionKey);
  const nextKey = randomBytes(32);
  const nextCrypto = new CryptoBox(nextKey);
  const oldSessions = new SessionStore(
    config.dataDir,
    oldCrypto,
    config.ownerId,
  );
  const nextSessions = new SessionStore(
    config.dataDir,
    nextCrypto,
    config.ownerId,
  );
  const session = await oldSessions.load(config.ownerId);
  try {
    const counts = database.rotateEncryptionKey(
      oldCrypto,
      nextCrypto,
      config.ownerId,
    );
    if (session) await nextSessions.save(config.ownerId, session);
    await writeConfiguredSecret(
      "SESSION_ENCRYPTION_KEY",
      `${nextKey.toString("base64")}\n`,
    );
    return {
      status: "encryption_key_rotated",
      re_encrypted_pending_changes: counts.pendingChanges,
      re_encrypted_snapshots: counts.snapshots,
      session_re_encrypted: Boolean(session),
      recovery_directory: recovery,
      restart_required: true,
    };
  } catch (error) {
    database.close();
    const rollback = await verifyBackup(config, recovery);
    await installBackupFiles(config, rollback);
    throw error;
  } finally {
    try {
      database.close();
    } catch {
      // The error path may already have closed the database.
    }
  }
}

async function installBackupFiles(
  config: AppConfig,
  backup: string,
): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const databaseSource = join(backup, "state.db");
  const temporaryDatabase = join(
    config.dataDir,
    `.state.db.restore-${randomUUID()}`,
  );
  await copyFile(databaseSource, temporaryDatabase);
  await chmod(temporaryDatabase, 0o600);
  const check = new Database(temporaryDatabase, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (check.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("Backup SQLite quick_check failed");
    }
  } finally {
    check.close();
  }
  await rm(join(config.dataDir, "state.db-wal"), { force: true });
  await rm(join(config.dataDir, "state.db-shm"), { force: true });
  await rename(temporaryDatabase, config.databasePath);
  const sessionSource = join(backup, "session.enc");
  try {
    const temporarySession = join(
      config.dataDir,
      `.session.enc.restore-${randomUUID()}`,
    );
    await copyFile(sessionSource, temporarySession);
    await chmod(temporarySession, 0o600);
    await rename(temporarySession, join(config.dataDir, "session.enc"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rm(join(config.dataDir, "session.enc"), { force: true });
  }
}

async function verifyBackup(
  config: AppConfig,
  source: string,
): Promise<string> {
  if (!isAbsolute(source)) throw new Error("Backup source must be absolute");
  const root = resolve(source);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Backup source must be a real directory");
  }
  const manifest = JSON.parse(
    await readFile(join(root, "backup.json"), "utf8"),
  ) as BackupManifest;
  if (
    manifest.schema_version !== 1 ||
    manifest.owner_hash !== ownerHash(config.ownerId) ||
    !manifest.files ||
    typeof manifest.files !== "object"
  ) {
    throw new Error("Backup manifest does not match this owner or schema");
  }
  if (!manifest.files["state.db"]) {
    throw new Error("Backup manifest is missing state.db");
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!/^(?:state\.db|session\.enc|recovery-key)$/.test(name)) {
      throw new Error("Backup manifest contains an unsupported file");
    }
    const path = join(root, name);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Backup contains a non-regular file");
    }
    if ((await sha256(path)) !== digest) {
      throw new Error(`Backup digest mismatch for ${name}`);
    }
  }
  return root;
}

async function writeConfiguredSecret(
  name: string,
  value: string,
): Promise<void> {
  const configuredFile = process.env[`${name}_FILE`]?.trim();
  if (configuredFile) {
    await atomicPrivateWrite(configuredFile, value);
    return;
  }
  const environmentFile = process.env.YUQUE_MCP_ENV_FILE?.trim();
  if (!environmentFile || !isAbsolute(environmentFile)) {
    throw new Error(
      `${name} rotation requires ${name}_FILE or YUQUE_MCP_ENV_FILE`,
    );
  }
  const serialized = await readFile(environmentFile, "utf8");
  const lines = serialized.split(/\r?\n/);
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith(`${name}=`));
  if (matches.length !== 1) {
    throw new Error(`${name} must appear exactly once in YUQUE_MCP_ENV_FILE`);
  }
  lines[matches[0]!.index] = `${name}=${value.trimEnd()}`;
  await atomicPrivateWrite(environmentFile, `${lines.join("\n").trimEnd()}\n`);
}

async function atomicPrivateWrite(path: string, value: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Secret file path must be absolute");
  const existing = await lstat(path);
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error("Secret target must be a real regular file");
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, value, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function copyOptionalPrivateFile(
  source: string,
  target: string,
): Promise<void> {
  try {
    await copyFile(source, target);
    await chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function backupDigests(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ["state.db", "session.enc", "recovery-key"]) {
    try {
      result[name] = await sha256(join(root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function validateBackupDestination(
  dataDir: string,
  destination: string,
): string {
  if (!isAbsolute(destination)) {
    throw new Error("Backup destination must be absolute");
  }
  const target = resolve(destination);
  const data = resolve(dataDir);
  const relation = relative(data, target);
  if (!relation || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("Backup destination cannot be inside DATA_DIR");
  }
  return target;
}

function ownerHash(ownerId: string): string {
  return createHash("sha256")
    .update(`yuque-web-mcp-backup-owner:v1:${ownerId}`)
    .digest("hex");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
