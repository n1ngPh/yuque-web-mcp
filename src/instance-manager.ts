import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  chown,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_IMAGE = "yuque-web-mcp:1.0.0";

export interface InstanceRecord {
  id: string;
  aliasHash: string;
  ownerId: string;
  port: number;
  publicBaseUrl: string;
  image: string;
  createdAt: string;
  updatedAt: string;
}

interface InstanceIndex {
  schemaVersion: 1;
  instances: InstanceRecord[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type InstanceCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string },
) => Promise<CommandResult>;

export interface InstanceManagerOptions {
  root: string;
  runner?: InstanceCommandRunner;
  now?: () => Date;
  chromiumSeccompProfilePath?: string;
}

export class InstanceManager {
  private readonly root: string;
  private readonly runner: InstanceCommandRunner;
  private readonly now: () => Date;
  private readonly chromiumSeccompProfilePath: string;

  constructor(options: InstanceManagerOptions) {
    if (!isAbsolute(options.root)) {
      throw new Error("Instance root must be an absolute path");
    }
    this.root = resolve(options.root);
    this.runner = options.runner ?? runCommand;
    this.now = options.now ?? (() => new Date());
    this.chromiumSeccompProfilePath = resolve(
      options.chromiumSeccompProfilePath ??
        process.env.YUQUE_MCP_CHROMIUM_SECCOMP_PROFILE ??
        bundledChromiumSeccompProfilePath(),
    );
  }

  async create(
    alias: string,
    input: {
      port: number;
      publicBaseUrl?: string;
      image?: string;
      bindAddress?: string;
    },
  ): Promise<Record<string, unknown>> {
    const normalizedAlias = validateAlias(alias);
    const port = validatePort(input.port);
    const bindAddress = validateBindAddress(input.bindAddress ?? "127.0.0.1");
    const publicBaseUrl = validatePublicBaseUrl(
      input.publicBaseUrl ?? `http://127.0.0.1:${String(port)}`,
    );
    const image = validateImage(input.image ?? DEFAULT_IMAGE);
    const chromiumSeccompProfile = await loadChromiumSeccompProfile(
      this.chromiumSeccompProfilePath,
    );
    await this.prepareRoot();

    return this.withIndexLock(async () => {
      const index = await this.loadIndex();
      const aliasHash = hashAlias(normalizedAlias);
      if (index.instances.some((entry) => entry.aliasHash === aliasHash)) {
        throw new Error("An instance already exists for this employee alias");
      }
      if (index.instances.some((entry) => entry.port === port)) {
        throw new Error("The requested instance port is already assigned");
      }
      const id = `i-${randomBytes(10).toString("hex")}`;
      const ownerId = `owner-${randomBytes(12).toString("base64url")}`;
      const createdAt = this.now().toISOString();
      const record: InstanceRecord = {
        id,
        aliasHash,
        ownerId,
        port,
        publicBaseUrl,
        image,
        createdAt,
        updatedAt: createdAt,
      };
      const temporaryDirectory = join(
        this.instancesDirectory(),
        `.creating-${randomUUID()}`,
      );
      const finalDirectory = this.instanceDirectory(id);
      const runtimeIdentity = deploymentRuntimeIdentity();
      try {
        const dataDirectory = join(temporaryDirectory, "data");
        await mkdir(dataDirectory, {
          recursive: true,
          mode: 0o700,
        });
        if (runtimeIdentity.requiresOwnershipChange) {
          await chown(dataDirectory, runtimeIdentity.uid, runtimeIdentity.gid);
        }
        await writeFile(
          join(temporaryDirectory, ".env"),
          composeEnvironment(runtimeIdentity.uid, runtimeIdentity.gid),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await writeFile(
          join(temporaryDirectory, "service.env"),
          serviceEnvironment(record),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await writeFile(
          join(temporaryDirectory, "compose.yaml"),
          composeFile(record, bindAddress),
          { encoding: "utf8", mode: 0o644, flag: "wx" },
        );
        await writeFile(
          join(temporaryDirectory, "chromium-seccomp.json"),
          chromiumSeccompProfile,
          { encoding: "utf8", mode: 0o644, flag: "wx" },
        );
        await writeFile(
          join(temporaryDirectory, "instance.json"),
          `${JSON.stringify(publicInstanceMetadata(record), null, 2)}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await rename(temporaryDirectory, finalDirectory);
        index.instances.push(record);
        await this.writeIndex(index);
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        await rm(finalDirectory, { recursive: true, force: true });
        throw error;
      }
      return {
        status: "created",
        instance_id: id,
        directory: finalDirectory,
        port,
        mcp_url: `${publicBaseUrl.replace(/\/$/, "")}/mcp`,
        secret_file: join(finalDirectory, "service.env"),
      };
    });
  }

  async start(alias: string): Promise<Record<string, unknown>> {
    const record = await this.resolveRecord(alias);
    const result = await this.compose(record, ["up", "-d"]);
    assertCommandSucceeded(result, "docker compose up");
    return {
      status: "started",
      instance_id: record.id,
      port: record.port,
      mcp_url: `${record.publicBaseUrl.replace(/\/$/, "")}/mcp`,
    };
  }

  async status(alias: string): Promise<Record<string, unknown>> {
    const record = await this.resolveRecord(alias);
    const result = await this.compose(record, ["ps", "--format", "json"]);
    assertCommandSucceeded(result, "docker compose ps");
    return {
      instance_id: record.id,
      port: record.port,
      public_base_url: record.publicBaseUrl,
      image: record.image,
      compose_status: parseComposeStatus(result.stdout),
    };
  }

  async backup(alias: string): Promise<Record<string, unknown>> {
    const record = await this.resolveRecord(alias);
    const source = this.instanceDirectory(record.id);
    const timestamp = this.now()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/Z$/, "Z");
    const finalDirectory = join(this.backupsDirectory(), record.id, timestamp);
    const temporaryDirectory = `${finalDirectory}.partial-${randomUUID()}`;
    await mkdir(join(temporaryDirectory, "data"), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await copyPrivateFile(
        join(source, ".env"),
        join(temporaryDirectory, ".env"),
      );
      await copyPrivateFile(
        join(source, "service.env"),
        join(temporaryDirectory, "service.env"),
      );
      await copyPrivateFile(
        join(source, "compose.yaml"),
        join(temporaryDirectory, "compose.yaml"),
      );
      await copyPrivateFile(
        join(source, "chromium-seccomp.json"),
        join(temporaryDirectory, "chromium-seccomp.json"),
      );
      await copyPrivateFile(
        join(source, "instance.json"),
        join(temporaryDirectory, "instance.json"),
      );
      await copyDataDirectory(
        join(source, "data"),
        join(temporaryDirectory, "data"),
      );
      const manifest = {
        schema_version: 1,
        instance_id: record.id,
        created_at: this.now().toISOString(),
        contains_secrets: true,
        restore_requires_private_storage: true,
        files: await backupFileDigests(temporaryDirectory),
      };
      await writeFile(
        join(temporaryDirectory, "backup.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await mkdir(dirname(finalDirectory), { recursive: true, mode: 0o700 });
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    return {
      status: "backed_up",
      instance_id: record.id,
      backup_directory: finalDirectory,
      contains_secrets: true,
    };
  }

  async upgrade(
    alias: string,
    image: string,
  ): Promise<Record<string, unknown>> {
    const nextImage = validateImage(image);
    const backup = await this.backup(alias);
    return this.withIndexLock(async () => {
      const index = await this.loadIndex();
      const record = exactRecord(index, hashAlias(validateAlias(alias)));
      if (record.image === nextImage) {
        throw new Error("The instance already uses the requested image");
      }
      const directory = this.instanceDirectory(record.id);
      const composePath = join(directory, "compose.yaml");
      const previousCompose = await readFile(composePath, "utf8");
      const previousImage = record.image;
      const bindAddress = parseComposeBindAddress(previousCompose);
      await atomicWrite(
        composePath,
        composeFile({ ...record, image: nextImage }, bindAddress),
        0o644,
      );
      try {
        const pull = await this.compose({ ...record, image: nextImage }, [
          "pull",
        ]);
        assertCommandSucceeded(pull, "docker compose pull");
        const up = await this.compose({ ...record, image: nextImage }, [
          "up",
          "-d",
        ]);
        assertCommandSucceeded(up, "docker compose up");
      } catch (error) {
        await atomicWrite(composePath, previousCompose, 0o644);
        await this.compose({ ...record, image: previousImage }, [
          "up",
          "-d",
        ]).catch(() => undefined);
        throw error;
      }
      record.image = nextImage;
      record.updatedAt = this.now().toISOString();
      await atomicWrite(
        join(directory, "instance.json"),
        `${JSON.stringify(publicInstanceMetadata(record), null, 2)}\n`,
        0o600,
      );
      await this.writeIndex(index);
      return {
        status: "upgraded",
        instance_id: record.id,
        previous_image: previousImage,
        image: nextImage,
        backup_directory: backup.backup_directory,
      };
    });
  }

  private async compose(
    record: InstanceRecord,
    command: string[],
  ): Promise<CommandResult> {
    const directory = this.instanceDirectory(record.id);
    return this.runner(
      "docker",
      [
        "compose",
        "--project-name",
        `ywm-${record.id}`,
        "--project-directory",
        directory,
        "--file",
        join(directory, "compose.yaml"),
        ...command,
      ],
      { cwd: directory },
    );
  }

  private async resolveRecord(alias: string): Promise<InstanceRecord> {
    await this.prepareRoot();
    const index = await this.loadIndex();
    return exactRecord(index, hashAlias(validateAlias(alias)));
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.instancesDirectory(), { recursive: true, mode: 0o700 });
    await mkdir(this.backupsDirectory(), { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await chmod(this.instancesDirectory(), 0o700);
    await chmod(this.backupsDirectory(), 0o700);
  }

  private async withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, ".index.lock");
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Another instance administration command is running");
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async loadIndex(): Promise<InstanceIndex> {
    const path = join(this.root, "index.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as InstanceIndex;
      if (
        parsed.schemaVersion !== INDEX_SCHEMA_VERSION ||
        !Array.isArray(parsed.instances)
      ) {
        throw new Error("Instance index schema is invalid");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: INDEX_SCHEMA_VERSION, instances: [] };
      }
      throw error;
    }
  }

  private async writeIndex(index: InstanceIndex): Promise<void> {
    await atomicWrite(
      join(this.root, "index.json"),
      `${JSON.stringify(index, null, 2)}\n`,
      0o600,
    );
  }

  private instancesDirectory(): string {
    return join(this.root, "instances");
  }

  private backupsDirectory(): string {
    return join(this.root, "backups");
  }

  private instanceDirectory(id: string): string {
    return join(this.instancesDirectory(), id);
  }
}

function serviceEnvironment(record: InstanceRecord): string {
  const publicHost = new URL(record.publicBaseUrl).host;
  return [
    "YUQUE_HOST=https://www.yuque.com",
    "YUQUE_PERSONAL_HOST=https://www.yuque.com",
    "YUQUE_ORGANIZATION=",
    "HOST=0.0.0.0",
    "PORT=3000",
    `PUBLIC_BASE_URL=${record.publicBaseUrl}`,
    `MCP_ALLOWED_HOSTS=${publicHost},127.0.0.1:3000,localhost:3000`,
    "MCP_ALLOWED_ORIGINS=",
    `MCP_OWNER_ID=${record.ownerId}`,
    `MCP_BEARER_TOKEN=${randomBytes(48).toString("base64url")}`,
    `SESSION_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "LOGIN_TTL_SECONDS=300",
    "CHANGE_TTL_SECONDS=600",
    "YUQUE_REQUEST_TIMEOUT_MS=15000",
    "WRITE_CONSISTENCY_MODE=strict",
    "WRITE_KILL_SWITCH=false",
    "ALLOW_UNVERIFIED_CONTRACTS=false",
    "ALLOW_OBJECT_DELETION=false",
    "ALLOW_PERMISSION_CHANGES=false",
    "YUQUE_WRITE_BOOK_ALLOWLIST=",
    "ALLOW_INSECURE_HTTP=false",
    "MAX_MCP_SESSIONS=32",
    "MAX_CONCURRENT_REQUESTS=16",
    "MAX_REQUESTS_PER_SESSION=4",
    "MCP_SESSION_IDLE_SECONDS=1800",
    "MAX_REQUEST_BODY_BYTES=1572864",
    "MAX_CONCURRENT_LOGINS=2",
    "GRACEFUL_SHUTDOWN_SECONDS=30",
    "METRICS_ENABLED=true",
    "YUQUE_HTTPS_PROXY=",
    "YUQUE_CA_FILE=",
    "",
  ].join("\n");
}

function composeFile(record: InstanceRecord, bindAddress: string): string {
  return `name: ywm-${record.id}

services:
  server:
    image: ${JSON.stringify(record.image)}
    user: "\${YWM_RUNTIME_UID}:\${YWM_RUNTIME_GID}"
    restart: unless-stopped
    stop_grace_period: 35s
    env_file:
      - ./service.env
    environment:
      DATA_DIR: /data
      CONTRACT_PATH: /app/contracts/yuque-web-2026-08-14.json
      CHROMIUM_EXECUTABLE: /usr/bin/chromium
    ports:
      - ${JSON.stringify(`${bindAddress}:${String(record.port)}:3000`)}
    volumes:
      - ./data:/data
    read_only: true
    tmpfs:
      - /tmp:size=512m,mode=1777
    shm_size: 512m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
      - seccomp=./chromium-seccomp.json
    init: true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/readyz',{headers:{Host:'127.0.0.1:3000'}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
`;
}

function composeEnvironment(uid: number, gid: number): string {
  return `YWM_RUNTIME_UID=${String(uid)}\nYWM_RUNTIME_GID=${String(gid)}\n`;
}

async function loadChromiumSeccompProfile(path: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to load Chromium seccomp profile: ${error instanceof Error ? error.message : "invalid file"}`,
    );
  }
  if (!isValidatedChromiumSeccompProfile(parsed)) {
    throw new Error(
      "Chromium seccomp profile must default-deny and explicitly allow chroot, clone, setns and unshare",
    );
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function isValidatedChromiumSeccompProfile(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const profile = value as {
    defaultAction?: unknown;
    syscalls?: unknown;
  };
  if (profile.defaultAction !== "SCMP_ACT_ERRNO") return false;
  if (!Array.isArray(profile.syscalls)) return false;
  return profile.syscalls.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const rule = entry as {
      action?: unknown;
      names?: unknown;
      includes?: unknown;
      excludes?: unknown;
    };
    if (rule.action !== "SCMP_ACT_ALLOW" || !Array.isArray(rule.names)) {
      return false;
    }
    const names = new Set(
      rule.names.filter((name): name is string => typeof name === "string"),
    );
    const includes = rule.includes;
    const excludes = rule.excludes;
    const unconditional =
      includes !== null &&
      typeof includes === "object" &&
      Object.keys(includes).length === 0 &&
      excludes !== null &&
      typeof excludes === "object" &&
      Object.keys(excludes).length === 0;
    return (
      unconditional &&
      ["chroot", "clone", "setns", "unshare"].every((name) => names.has(name))
    );
  });
}

function deploymentRuntimeIdentity(): {
  uid: number;
  gid: number;
  requiresOwnershipChange: boolean;
} {
  const currentUid = process.getuid?.();
  const currentGid = process.getgid?.();
  if (currentUid === 0) {
    return { uid: 1000, gid: 1000, requiresOwnershipChange: true };
  }
  if (
    currentUid === undefined ||
    currentGid === undefined ||
    !Number.isSafeInteger(currentUid) ||
    !Number.isSafeInteger(currentGid) ||
    currentUid <= 0 ||
    currentGid < 0
  ) {
    throw new Error("A non-root POSIX deployment identity is required");
  }
  return {
    uid: currentUid,
    gid: currentGid,
    requiresOwnershipChange: false,
  };
}

function bundledChromiumSeccompProfilePath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot =
    basename(dirname(moduleDirectory)) === "dist"
      ? resolve(moduleDirectory, "../..")
      : resolve(moduleDirectory, "..");
  return join(packageRoot, "deploy", "chromium-seccomp.json");
}

function publicInstanceMetadata(
  record: InstanceRecord,
): Record<string, unknown> {
  return {
    schema_version: 1,
    instance_id: record.id,
    owner_id: record.ownerId,
    port: record.port,
    public_base_url: record.publicBaseUrl,
    image: record.image,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function validateAlias(value: string): string {
  const alias = value.trim();
  if (
    !alias ||
    Buffer.byteLength(alias, "utf8") > 128 ||
    /[\r\n\0]/.test(alias)
  ) {
    throw new Error("Employee alias must contain 1-128 safe bytes");
  }
  return alias;
}

function hashAlias(alias: string): string {
  return createHash("sha256")
    .update(`yuque-web-mcp-instance-alias:v1:${alias}`)
    .digest("hex");
}

function validatePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Instance port must be an integer from 1024 to 65535");
  }
  return value;
}

function validateBindAddress(value: string): string {
  if (!/^(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(value)) {
    throw new Error("Bind address must be 127.0.0.1, [::1] or 0.0.0.0");
  }
  return value;
}

function validatePublicBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Public base URL must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Public base URL must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  ) {
    throw new Error(
      "Public base URL must use HTTPS unless it targets the local host",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function validateImage(value: string): string {
  const image = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/.test(image)) {
    throw new Error("Container image reference is invalid");
  }
  if (/:latest(?:@|$)/.test(image) || image.endsWith(":latest")) {
    throw new Error("The mutable latest image tag is forbidden");
  }
  const digestSeparator = image.indexOf("@");
  if (digestSeparator >= 0) {
    if (
      image.indexOf("@", digestSeparator + 1) >= 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(image.slice(digestSeparator + 1))
    ) {
      throw new Error("Container image digest must be an exact sha256 value");
    }
  } else {
    const lastSlash = image.lastIndexOf("/");
    const lastColon = image.lastIndexOf(":");
    if (lastColon <= lastSlash || !image.slice(lastColon + 1)) {
      throw new Error(
        "Container image must use a fixed tag or an exact sha256 digest",
      );
    }
  }
  return image;
}

function exactRecord(index: InstanceIndex, aliasHash: string): InstanceRecord {
  const matches = index.instances.filter(
    (entry) => entry.aliasHash === aliasHash,
  );
  if (matches.length !== 1) throw new Error("Instance was not found");
  return matches[0]!;
}

async function atomicWrite(
  path: string,
  value: string,
  mode: number,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, value, { encoding: "utf8", mode, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, mode);
}

async function copyPrivateFile(source: string, target: string): Promise<void> {
  await cp(source, target, { force: false });
  await chmod(target, 0o600);
}

async function copyDataDirectory(
  source: string,
  target: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (["state.db", "state.db-wal", "state.db-shm"].includes(entry.name)) {
      continue;
    }
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    await cp(sourcePath, targetPath, {
      recursive: entry.isDirectory(),
      force: false,
    });
  }
  const databasePath = join(source, "state.db");
  try {
    await stat(databasePath);
    const database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await database.backup(join(target, "state.db"));
    } finally {
      database.close();
    }
    await chmod(join(target, "state.db"), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function backupFileDigests(
  root: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const relative = path.slice(root.length + 1);
        result[relative] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  }
  await visit(root);
  return result;
}

function parseComposeStatus(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed.slice(0, 4096);
  }
}

function parseComposeBindAddress(compose: string): string {
  const match = compose.match(
    /- "(127\.0\.0\.1|0\.0\.0\.0|\[::1\]):[0-9]+:3000"/,
  );
  if (!match?.[1]) throw new Error("Existing Compose bind address is invalid");
  return match[1];
}

function assertCommandSucceeded(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${String(result.exitCode)}`,
    );
  }
}

async function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string },
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}
