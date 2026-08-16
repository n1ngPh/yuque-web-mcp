import type { AppConfig } from "./config.js";
import { CryptoBox } from "./crypto.js";
import { AppDatabase } from "./db.js";
import { AuthService } from "./auth.js";
import { SessionStore } from "./session-store.js";
import { ContractRegistry } from "./contracts.js";
import { YuqueWebClient } from "./yuque-client.js";
import { LoginManager } from "./login-manager.js";
import { ChangeStore } from "./change-store.js";

export async function createApplication(config: AppConfig) {
  const crypto = new CryptoBox(config.encryptionKey);
  const db = new AppDatabase(config.databasePath);
  const auth = new AuthService(config.ownerId, config.mcpBearerToken);
  const sessions = new SessionStore(config.dataDir, crypto, config.ownerId);
  const contracts = await ContractRegistry.load(
    config.contractPath,
    config.allowUnverifiedContracts,
  );
  const client = new YuqueWebClient(config, contracts, sessions);
  const login = new LoginManager(config, sessions);
  const changes = new ChangeStore(config, db, crypto, client);

  const readiness = () => {
    const database = db.readiness();
    return {
      ready:
        database.quickCheck &&
        database.executingChanges === 0 &&
        contracts.manifest.endpoints.length > 0,
      database,
      contractVersion: contracts.manifest.version,
    };
  };

  return {
    config,
    db,
    crypto,
    auth,
    sessions,
    contracts,
    client,
    login,
    changes,
    readiness,
  };
}

export type Application = Awaited<ReturnType<typeof createApplication>>;
