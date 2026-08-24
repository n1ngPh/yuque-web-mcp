import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createApplication } from "./app.js";
import {
  createRuntimeBackup,
  restoreRuntimeBackup,
  rotateBearerToken,
  rotateEncryptionKey,
} from "./maintenance.js";

async function main(): Promise<void> {
  const [command = "status", ...values] = process.argv.slice(2);
  const options = parseOptions(values);
  const config = loadConfig();
  const ownerId = optionalOption(options, "owner") ?? config.ownerId;
  if (config.users && !config.users.some((user) => user.ownerId === ownerId)) {
    throw new Error(`Unknown owner: ${ownerId}`);
  }

  if (command === "restore") {
    print(
      await restoreRuntimeBackup(
        config,
        requiredOption(options, "from"),
        requiredOption(options, "confirmation"),
      ),
    );
    assertNoOptions(options);
    return;
  }
  if (command === "rotate-token") {
    assertNoOptions(options);
    print(await rotateBearerToken(config));
    return;
  }
  if (command === "rotate-key") {
    assertNoOptions(options);
    print(await rotateEncryptionKey(config));
    return;
  }

  const app = await createApplication(config);
  try {
    switch (command) {
      case "reset-session":
        assertNoOptions(options);
        await app.login.cancelEmployee(ownerId);
        await app.sessions.remove(ownerId);
        print({ owner_id: ownerId, status: "session_cleared" });
        break;
      case "status": {
        assertNoOptions(options);
        const session = await app.sessions.load(ownerId);
        print({
          owner_id: ownerId,
          connected: Boolean(session),
          ...(session?.account.login
            ? { yuque_login: session.account.login }
            : {}),
          database_path: databasePathFor(config.dataDir, ownerId),
          bearer_source: process.env.MCP_BEARER_TOKEN_FILE
            ? "MCP_BEARER_TOKEN_FILE"
            : "MCP_BEARER_TOKEN secret",
        });
        break;
      }
      case "doctor": {
        assertNoOptions(options);
        const readiness = app.readiness();
        const session = await app.sessions.load(ownerId);
        print({
          status:
            readiness.ready && readiness.database.unknownChanges === 0
              ? "ok"
              : "attention_required",
          owner_id: ownerId,
          database_quick_check: readiness.database.quickCheck,
          executing_changes: readiness.database.executingChanges,
          unknown_changes: readiness.database.unknownChanges,
          contract_version: readiness.contractVersion,
          contract_endpoints: app.contracts.manifest.endpoints.length,
          session_encrypted_at_rest: await hasPrivateMode(
            sessionFileFor(config.dataDir, ownerId),
          ),
          database_private_mode: await hasPrivateMode(
            databasePathFor(config.dataDir, ownerId),
          ),
          connected: Boolean(session),
          write_consistency_mode: app.config.writeConsistencyMode,
          write_kill_switch: app.config.writeKillSwitch === true,
          object_deletion_enabled: app.config.allowObjectDeletion === true,
          permission_changes_enabled:
            app.config.allowPermissionChanges === true,
          public_transport: new URL(app.config.publicBaseUrl).protocol,
          insecure_http_explicitly_accepted:
            app.config.allowInsecureHttp === true,
          tls_verification_disabled: false,
        });
        break;
      }
      case "backup": {
        const output = requiredOption(options, "output");
        assertNoOptions(options);
        print(
          await createRuntimeBackup(config, app.getTenant(ownerId).db, output),
        );
        break;
      }
      default:
        throw new Error(usage());
    }
  } finally {
    await app.close();
  }
}

function parseOptions(values: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(usage());
    }
    const name = key.slice(2);
    if (options.has(name)) throw new Error(`Duplicate option: --${name}`);
    options.set(name, value);
  }
  return options;
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  options.delete(name);
  return value;
}

function optionalOption(
  options: Map<string, string>,
  name: string,
): string | undefined {
  const value = options.get(name);
  options.delete(name);
  return value;
}

function assertNoOptions(options: Map<string, string>): void {
  if (options.size > 0) {
    throw new Error(`Unknown option: --${options.keys().next().value}`);
  }
}

function sessionFileFor(dataDir: string, ownerId: string): string {
  const digest = createHash("sha256").update(ownerId).digest("hex");
  return join(dataDir, "sessions", `${digest}.enc`);
}

function databasePathFor(dataDir: string, ownerId: string): string {
  const digest = createHash("sha256").update(ownerId).digest("hex");
  return join(dataDir, "db", `${digest}.db`);
}

async function hasPrivateMode(path: string): Promise<boolean | "missing"> {
  try {
    return ((await stat(path)).mode & 0o077) === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function usage(): string {
  return [
    "Usage:",
    "  admin status|doctor|reset-session [--owner <owner-id>]",
    "  admin backup --output <absolute-directory> [--owner <owner-id>]",
    "  admin restore --from <absolute-directory> --confirmation RESTORE:<owner-id>",
    "  admin rotate-token",
    "  admin rotate-key",
  ].join("\n");
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Admin command failed"}\n`,
  );
  process.exit(1);
});
