import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { CryptoBox } from "./crypto.js";
import { AppDatabase } from "./db.js";
import { AuthService } from "./auth.js";
import { SessionStore } from "./session-store.js";
import { ContractRegistry } from "./contracts.js";
import { YuqueWebClient } from "./yuque-client.js";
import { LoginManager } from "./login-manager.js";
import { ChangeStore } from "./change-store.js";

export interface TenantContext {
  ownerId: string;
  db: AppDatabase;
  client: YuqueWebClient;
  changes: ChangeStore;
}

export interface ReadinessResult {
  ready: boolean;
  database: {
    quickCheck: boolean;
    executingChanges: number;
    unknownChanges: number;
  };
  contractVersion: string;
}

export async function createApplication(config: AppConfig) {
  const crypto = new CryptoBox(config.encryptionKey);
  const users = config.users ?? [
    { ownerId: config.ownerId, bearerToken: config.mcpBearerToken },
  ];
  const auth = new AuthService(users);
  const sessions = new SessionStore(config.dataDir, crypto);
  const contracts = await ContractRegistry.load(
    config.contractPath,
    config.allowUnverifiedContracts,
  );
  const login = new LoginManager(config, sessions);

  const tenants = new Map<string, TenantContext>();

  function getTenant(ownerId: string): TenantContext {
    const existing = tenants.get(ownerId);
    if (existing) return existing;
    const db = new AppDatabase(databasePathFor(config.dataDir, ownerId));
    const client = new YuqueWebClient(config, contracts, sessions);
    const changes = new ChangeStore(config, db, crypto, client, ownerId);
    const tenant: TenantContext = { ownerId, db, client, changes };
    tenants.set(ownerId, tenant);
    return tenant;
  }

  const readiness = (): ReadinessResult => {
    const databases = [...tenants.values()].map((tenant) =>
      tenant.db.readiness(),
    );
    const database = {
      quickCheck: databases.every((entry) => entry.quickCheck),
      executingChanges: databases.reduce(
        (sum, entry) => sum + entry.executingChanges,
        0,
      ),
      unknownChanges: databases.reduce(
        (sum, entry) => sum + entry.unknownChanges,
        0,
      ),
    };
    return {
      ready:
        database.quickCheck &&
        database.executingChanges === 0 &&
        contracts.manifest.endpoints.length > 0,
      database,
      contractVersion: contracts.manifest.version,
    };
  };

  const activeWriteCount = (): number =>
    [...tenants.values()].reduce(
      (sum, tenant) => sum + tenant.changes.activeWriteCount(),
      0,
    );

  const beginShutdown = (): void => {
    for (const tenant of tenants.values()) tenant.changes.beginShutdown();
  };

  const waitForIdle = async (timeoutMs: number): Promise<boolean> => {
    const results = await Promise.all(
      [...tenants.values()].map((tenant) =>
        tenant.changes.waitForIdle(timeoutMs),
      ),
    );
    return results.every(Boolean);
  };

  const close = async (): Promise<void> => {
    for (const tenant of tenants.values()) {
      tenant.db.close();
      await tenant.client.close();
    }
    tenants.clear();
  };

  return {
    config,
    crypto,
    auth,
    sessions,
    contracts,
    login,
    tenants,
    getTenant,
    readiness,
    activeWriteCount,
    beginShutdown,
    waitForIdle,
    close,
  };
}

function databasePathFor(dataDir: string, ownerId: string): string {
  const digest = createHash("sha256").update(ownerId).digest("hex");
  return join(dataDir, "db", `${digest}.db`);
}

export type Application = Awaited<ReturnType<typeof createApplication>>;
