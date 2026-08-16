import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/db.js";
import {
  InstanceManager,
  type CommandResult,
  type InstanceCommandRunner,
} from "../src/instance-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("single-owner instance manager", () => {
  it("creates opaque isolated instances without storing employee aliases", async () => {
    const root = await temporaryRoot();
    const manager = new InstanceManager({ root });
    const first = await manager.create("employee-alice", { port: 19081 });
    const second = await manager.create("employee-bob", {
      port: 19082,
      publicBaseUrl: "https://mcp.example.test/bob",
      image: "registry.example.test/yuque-web-mcp:0.6.0",
    });
    expect(first.instance_id).toMatch(/^i-[0-9a-f]{20}$/);
    expect(second.instance_id).toMatch(/^i-[0-9a-f]{20}$/);
    expect(second.instance_id).not.toBe(first.instance_id);
    expect(String(first.directory)).not.toContain("alice");
    expect(String(second.directory)).not.toContain("bob");

    const firstEnvPath = join(String(first.directory), "service.env");
    const secondEnvPath = join(String(second.directory), "service.env");
    const firstEnv = parseEnvironment(await readFile(firstEnvPath, "utf8"));
    const secondEnv = parseEnvironment(await readFile(secondEnvPath, "utf8"));
    expect(firstEnv.MCP_OWNER_ID).not.toBe(secondEnv.MCP_OWNER_ID);
    expect(firstEnv.MCP_BEARER_TOKEN).not.toBe(secondEnv.MCP_BEARER_TOKEN);
    expect(firstEnv.SESSION_ENCRYPTION_KEY).not.toBe(
      secondEnv.SESSION_ENCRYPTION_KEY,
    );
    expect(firstEnv.WRITE_CONSISTENCY_MODE).toBe("strict");
    expect(firstEnv.YUQUE_WRITE_BOOK_ALLOWLIST).toBe("");
    expect((await stat(firstEnvPath)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(String(first.directory), "data"))).mode & 0o777,
    ).toBe(0o700);
    const runtimeEnvironment = parseEnvironment(
      await readFile(join(String(first.directory), ".env"), "utf8"),
    );
    const expectedUid = process.getuid?.() === 0 ? 1000 : process.getuid?.();
    const expectedGid = process.getuid?.() === 0 ? 1000 : process.getgid?.();
    expect(runtimeEnvironment).toEqual({
      YWM_RUNTIME_UID: String(expectedUid),
      YWM_RUNTIME_GID: String(expectedGid),
    });
    const dataInfo = await stat(join(String(first.directory), "data"));
    expect(dataInfo.uid).toBe(expectedUid);
    expect(dataInfo.gid).toBe(expectedGid);
    expect(
      (await stat(join(String(first.directory), ".env"))).mode & 0o777,
    ).toBe(0o600);

    const indexText = await readFile(join(root, "index.json"), "utf8");
    expect(indexText).not.toContain("employee-alice");
    expect(indexText).not.toContain("employee-bob");
    const index = JSON.parse(indexText) as { instances: unknown[] };
    expect(index.instances).toHaveLength(2);
    expect(
      await readFile(join(String(second.directory), "compose.yaml"), "utf8"),
    ).toContain("registry.example.test/yuque-web-mcp:0.6.0");
    expect(
      await readFile(join(String(second.directory), "compose.yaml"), "utf8"),
    ).toContain('user: "${YWM_RUNTIME_UID}:${YWM_RUNTIME_GID}"');
    expect(
      await readFile(join(String(second.directory), "compose.yaml"), "utf8"),
    ).toContain("seccomp=./chromium-seccomp.json");
    const seccompPath = join(String(second.directory), "chromium-seccomp.json");
    expect((await stat(seccompPath)).mode & 0o777).toBe(0o644);
    const seccomp = JSON.parse(await readFile(seccompPath, "utf8")) as {
      defaultAction: string;
      syscalls: Array<{ action: string; names: string[] }>;
    };
    expect(seccomp.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(
      seccomp.syscalls.some(
        (rule) =>
          rule.action === "SCMP_ACT_ALLOW" &&
          ["chroot", "clone", "setns", "unshare"].every((name) =>
            rule.names.includes(name),
          ),
      ),
    ).toBe(true);
  });

  it("rejects duplicate aliases, ports, mutable images and unsafe roots", async () => {
    const root = await temporaryRoot();
    const manager = new InstanceManager({ root });
    await manager.create("employee-a", { port: 19101 });
    await expect(manager.create("employee-a", { port: 19102 })).rejects.toThrow(
      "already exists",
    );
    await expect(manager.create("employee-b", { port: 19101 })).rejects.toThrow(
      "already assigned",
    );
    await expect(
      manager.create("employee-c", {
        port: 19103,
        image: "yuque-web-mcp:latest",
      }),
    ).rejects.toThrow("latest");
    await expect(
      manager.create("employee-c", {
        port: 19103,
        image: "registry.example.test/yuque-web-mcp",
      }),
    ).rejects.toThrow("fixed tag or an exact sha256 digest");
    await expect(
      manager.create("employee-c", {
        port: 19103,
        image: "registry.example.test/yuque-web-mcp@sha256:not-a-digest",
      }),
    ).rejects.toThrow("exact sha256");
    await expect(
      manager.create("employee-c", {
        port: 19103,
        publicBaseUrl: "http://192.0.2.10:19103",
      }),
    ).rejects.toThrow("must use HTTPS");
    expect(() => new InstanceManager({ root: "relative/instances" })).toThrow(
      "absolute",
    );
  });

  it("fails closed when the Chromium sandbox profile is missing or unsafe", async () => {
    const root = await temporaryRoot();
    const missing = new InstanceManager({
      root,
      chromiumSeccompProfilePath: join(root, "missing.json"),
    });
    await expect(missing.create("employee-a", { port: 19105 })).rejects.toThrow(
      "Unable to load Chromium seccomp profile",
    );

    const unsafePath = join(root, "unsafe.json");
    await writeFile(
      unsafePath,
      JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [] }),
      { mode: 0o600 },
    );
    const unsafe = new InstanceManager({
      root,
      chromiumSeccompProfilePath: unsafePath,
    });
    await expect(unsafe.create("employee-b", { port: 19106 })).rejects.toThrow(
      "must default-deny",
    );
  });

  it("resolves the bundled Chromium profile independently of the caller cwd", async () => {
    const root = await temporaryRoot();
    const unrelatedDirectory = await temporaryRoot();
    const originalDirectory = process.cwd();
    try {
      process.chdir(unrelatedDirectory);
      const manager = new InstanceManager({ root });
      const created = await manager.create("employee-cwd", { port: 19107 });
      await expect(
        readFile(
          join(String(created.directory), "chromium-seccomp.json"),
          "utf8",
        ),
      ).resolves.toContain('"defaultAction": "SCMP_ACT_ERRNO"');
    } finally {
      process.chdir(originalDirectory);
    }
  });

  it("runs Docker Compose with an opaque project and redacts secret material", async () => {
    const root = await temporaryRoot();
    const calls: Array<{ executable: string; args: string[]; cwd: string }> =
      [];
    const runner: InstanceCommandRunner = async (executable, args, options) => {
      calls.push({ executable, args, cwd: options.cwd });
      return {
        stdout: args.includes("ps")
          ? JSON.stringify([{ State: "running", Health: "healthy" }])
          : "",
        stderr: "",
        exitCode: 0,
      };
    };
    const manager = new InstanceManager({ root, runner });
    const created = await manager.create("employee-a", { port: 19111 });
    await expect(manager.start("employee-a")).resolves.toMatchObject({
      status: "started",
      instance_id: created.instance_id,
    });
    await expect(manager.status("employee-a")).resolves.toMatchObject({
      compose_status: [{ State: "running", Health: "healthy" }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.executable).toBe("docker");
    expect(calls[0]?.args).toContain("up");
    expect(calls[0]?.args.join(" ")).not.toContain("employee-a");
    expect(calls[0]?.args.join(" ")).not.toContain("MCP_BEARER_TOKEN");
  });

  it("backs up SQLite consistently and keeps the secret bundle private", async () => {
    const root = await temporaryRoot();
    const manager = new InstanceManager({
      root,
      now: () => new Date("2026-08-16T01:02:03.000Z"),
    });
    const created = await manager.create("employee-a", { port: 19121 });
    const data = join(String(created.directory), "data");
    const database = new AppDatabase(join(data, "state.db"));
    database.close();
    await mkdir(join(data, "sessions"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(data, "sessions", "encrypted-session.json"),
      randomBytes(32),
      { mode: 0o600 },
    );
    const result = await manager.backup("employee-a");
    const backup = String(result.backup_directory);
    expect(result).toMatchObject({
      status: "backed_up",
      contains_secrets: true,
    });
    expect((await stat(join(backup, "service.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(backup, "data", "state.db"))).mode & 0o777).toBe(
      0o600,
    );
    const manifest = JSON.parse(
      await readFile(join(backup, "backup.json"), "utf8"),
    ) as { contains_secrets: boolean; files: Record<string, string> };
    expect(manifest.contains_secrets).toBe(true);
    expect(manifest.files).toHaveProperty("service.env");
    expect(manifest.files).toHaveProperty(".env");
    expect(manifest.files).toHaveProperty("chromium-seccomp.json");
    expect(manifest.files).toHaveProperty("data/state.db");
    expect(manifest.files).toHaveProperty(
      "data/sessions/encrypted-session.json",
    );
  });

  it("backs up before upgrade and restores the previous Compose file on failure", async () => {
    const root = await temporaryRoot();
    let failPull = false;
    const calls: string[][] = [];
    const runner: InstanceCommandRunner = async (_executable, args) => {
      calls.push(args);
      const failed = failPull && args.includes("pull");
      return commandResult(failed ? 1 : 0);
    };
    const manager = new InstanceManager({ root, runner });
    const created = await manager.create("employee-a", {
      port: 19131,
      image: "yuque-web-mcp:0.6.0",
    });
    await expect(
      manager.upgrade("employee-a", "yuque-web-mcp:0.6.1"),
    ).resolves.toMatchObject({
      status: "upgraded",
      previous_image: "yuque-web-mcp:0.6.0",
      image: "yuque-web-mcp:0.6.1",
    });
    const composePath = join(String(created.directory), "compose.yaml");
    expect(await readFile(composePath, "utf8")).toContain(
      "yuque-web-mcp:0.6.1",
    );

    failPull = true;
    await expect(
      manager.upgrade("employee-a", "yuque-web-mcp:0.6.2"),
    ).rejects.toThrow("docker compose pull failed");
    expect(await readFile(composePath, "utf8")).toContain(
      "yuque-web-mcp:0.6.1",
    );
    expect(calls.some((args) => args.includes("up"))).toBe(true);
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yuque-instances-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function parseEnvironment(serialized: string): Record<string, string> {
  return Object.fromEntries(
    serialized
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function commandResult(exitCode: number): CommandResult {
  return { stdout: "", stderr: "", exitCode };
}
