import { loadConfig } from "./config.js";
import { createApplication } from "./app.js";

async function main(): Promise<void> {
  const command = process.argv[2] || "status";
  const app = await createApplication(loadConfig());
  try {
    switch (command) {
      case "reset-session":
        await app.login.cancelEmployee(app.config.ownerId);
        await app.sessions.remove(app.config.ownerId);
        print({ owner_id: app.config.ownerId, status: "session_cleared" });
        break;
      case "status": {
        const session = await app.sessions.load(app.config.ownerId);
        print({
          owner_id: app.config.ownerId,
          connected: Boolean(session),
          ...(session?.account.login
            ? { yuque_login: session.account.login }
            : {}),
          database_path: app.config.databasePath,
          bearer_source: "MCP_BEARER_TOKEN secret",
        });
        break;
      }
      default:
        throw new Error("Usage: admin status|reset-session");
    }
  } finally {
    app.db.close();
  }
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
