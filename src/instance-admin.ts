import { resolve } from "node:path";
import { InstanceManager } from "./instance-manager.js";

async function main(): Promise<void> {
  const [command = "status", alias, ...rest] = process.argv.slice(2);
  if (!alias) throw new Error(usage());
  const options = parseOptions(rest);
  const root = resolve(
    optionalStringOption(options, "root") ||
      process.env.YUQUE_MCP_INSTANCES_ROOT ||
      "instances",
  );
  const manager = new InstanceManager({
    root,
    chromiumSeccompProfilePath: process.env.YUQUE_MCP_CHROMIUM_SECCOMP_PROFILE,
  });
  let result: Record<string, unknown>;
  switch (command) {
    case "create":
      result = await manager.create(alias, {
        port: integerOption(options, "port"),
        publicBaseUrl: optionalStringOption(options, "public-base-url"),
        image: optionalStringOption(options, "image"),
        bindAddress: optionalStringOption(options, "bind-address"),
      });
      break;
    case "start":
      assertNoOptions(options);
      result = await manager.start(alias);
      break;
    case "status":
      assertNoOptions(options);
      result = await manager.status(alias);
      break;
    case "backup":
      assertNoOptions(options);
      result = await manager.backup(alias);
      break;
    case "upgrade":
      result = await manager.upgrade(alias, stringOption(options, "image"));
      break;
    default:
      throw new Error(usage());
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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

function integerOption(options: Map<string, string>, name: string): number {
  const value = Number.parseInt(stringOption(options, name), 10);
  if (!Number.isSafeInteger(value))
    throw new Error(`--${name} must be an integer`);
  options.delete(name);
  return value;
}

function stringOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  options.delete(name);
  return value;
}

function optionalStringOption(
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

function usage(): string {
  return [
    "Usage:",
    "  instance-admin create <employee-alias> --port <port> [--public-base-url <url>] [--image <fixed-image>] [--bind-address <address>] [--root <absolute-path>]",
    "  instance-admin start <employee-alias> [--root <absolute-path>]",
    "  instance-admin status <employee-alias> [--root <absolute-path>]",
    "  instance-admin backup <employee-alias> [--root <absolute-path>]",
    "  instance-admin upgrade <employee-alias> --image <fixed-image> [--root <absolute-path>]",
  ].join("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Instance administration failed"}\n`,
  );
  process.exit(1);
});
