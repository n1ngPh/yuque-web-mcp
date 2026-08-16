import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRuntimeLock,
  assertRuntimeStopped,
} from "../src/runtime-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runtime data lock", () => {
  it("prevents two services and blocks offline maintenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuque-runtime-lock-"));
    temporaryDirectories.push(root);
    const lock = await acquireRuntimeLock(root);
    await expect(acquireRuntimeLock(root)).rejects.toThrow("Another");
    await expect(assertRuntimeStopped(root)).rejects.toThrow("Stop the");
    await lock.release();
    await expect(assertRuntimeStopped(root)).resolves.toBeUndefined();
  });
});
