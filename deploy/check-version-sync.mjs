import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [
  packageText,
  lockText,
  sourceText,
  dockerText,
  composeText,
  instanceText,
] = await Promise.all(
  [
    "package.json",
    "package-lock.json",
    "src/version.ts",
    "Dockerfile",
    "compose.yaml",
    "src/instance-manager.ts",
  ].map((path) => readFile(new URL(path, root), "utf8")),
);

const packageManifest = JSON.parse(packageText);
const packageLock = JSON.parse(lockText);
const version = requiredVersion(packageManifest.version, "package.json");
const observed = new Map([
  ["package-lock.json version", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  [
    "src/version.ts",
    capture(sourceText, /SERVER_VERSION\s*=\s*"([^"]+)"/, "SERVER_VERSION"),
  ],
  ["Dockerfile", capture(dockerText, /^ARG VERSION=([^\s]+)$/m, "ARG VERSION")],
  [
    "compose.yaml",
    capture(composeText, /^\s*image:\s*yuque-web-mcp:([^\s]+)$/m, "image tag"),
  ],
  [
    "src/instance-manager.ts",
    capture(
      instanceText,
      /DEFAULT_IMAGE\s*=\s*"yuque-web-mcp:([^"]+)"/,
      "DEFAULT_IMAGE",
    ),
  ],
]);

const mismatches = [...observed].filter(([, value]) => value !== version);
if (mismatches.length > 0) {
  throw new Error(
    `Version ${version} is not synchronized: ${mismatches
      .map(([label, value]) => `${label}=${String(value)}`)
      .join(", ")}`,
  );
}

process.stdout.write(`Version synchronization passed (${version}).\n`);

function requiredVersion(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  ) {
    throw new Error(`${label} does not contain a valid semantic version`);
  }
  return value;
}

function capture(value, pattern, label) {
  const result = value.match(pattern)?.[1];
  if (!result) throw new Error(`Could not find ${label}`);
  return result;
}
