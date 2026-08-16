import { loadConfig } from "./config.js";
import { createApplication } from "./app.js";
import { startHttpServer } from "./http-server.js";
import { logger } from "./logger.js";
import { acquireRuntimeLock } from "./runtime-lock.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtimeLock = await acquireRuntimeLock(config.dataDir);
  let app;
  try {
    app = await createApplication(config);
  } catch (error) {
    await runtimeLock.release();
    throw error;
  }
  let runtime;
  try {
    runtime = startHttpServer(app);
  } catch (error) {
    app.db.close();
    await app.client.close();
    await runtimeLock.release();
    throw error;
  }
  const { shutdown } = runtime;

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.log("info", "shutdown_requested", { signal });
    const result = await shutdown();
    app.db.close();
    await runtimeLock.release();
    process.exitCode = result.writesDrained ? 0 : 1;
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.log("error", "startup_failed", {
    error_class: error instanceof Error ? error.name : "UnknownError",
  });
  process.exit(1);
});
