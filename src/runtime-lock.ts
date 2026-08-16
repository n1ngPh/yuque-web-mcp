import { hostname } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";

interface RuntimeLockRecord {
  pid: number;
  hostname: string;
  startedAt: string;
}

const activeLocks = new Set<string>();

export interface RuntimeLock {
  path: string;
  release(): Promise<void>;
}

export async function acquireRuntimeLock(
  dataDir: string,
): Promise<RuntimeLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "service.lock");
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await runtimeAppearsActive(path)) {
      throw new Error(
        "Another yuque-web-mcp process is using this data directory",
      );
    }
    await unlink(path);
    handle = await open(path, "wx", 0o600);
  }
  const record: RuntimeLockRecord = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  };
  await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  activeLocks.add(path);
  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      activeLocks.delete(path);
      await handle.close();
      await unlink(path).catch(() => undefined);
    },
  };
}

export async function assertRuntimeStopped(dataDir: string): Promise<void> {
  const path = join(dataDir, "service.lock");
  if (await runtimeAppearsActive(path)) {
    throw new Error("Stop the yuque-web-mcp service before this operation");
  }
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function runtimeAppearsActive(path: string): Promise<boolean> {
  if (activeLocks.has(path)) return true;
  let record: RuntimeLockRecord;
  try {
    record = JSON.parse(await readFile(path, "utf8")) as RuntimeLockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  if (record.hostname !== hostname() || !Number.isSafeInteger(record.pid)) {
    return true;
  }
  if (record.pid === process.pid) return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
