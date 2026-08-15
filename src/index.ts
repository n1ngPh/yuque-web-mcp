import { loadConfig } from "./config.js";
import { createApplication } from "./app.js";
import { startHttpServer } from "./http-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApplication(config);
  const { server } = startHttpServer(app);

  const shutdown = () => {
    server.close(() => {
      app.db.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
});
