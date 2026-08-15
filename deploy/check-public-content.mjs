import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const excludedDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "runtime",
]);
const textExtensions = new Set([
  "",
  ".css",
  ".dockerignore",
  ".example",
  ".gitignore",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const checks = [
  {
    name: "private IPv4 address",
    pattern:
      /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  },
  {
    name: "committed secret assignment",
    pattern:
      /\b(?:MCP_BEARER_TOKEN|SESSION_ENCRYPTION_KEY|YUQUE_TOKEN)=(?![<$]|$)[^\s]+/g,
  },
];
const privateDenylist = (process.env.PUBLIC_SCAN_DENYLIST || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const findings = [];
for await (const path of walk(projectRoot)) {
  const extension = extname(path).toLowerCase();
  if (!textExtensions.has(extension)) continue;
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const check of checks) {
      check.pattern.lastIndex = 0;
      if (check.pattern.test(lines[index])) {
        findings.push(
          `${relative(projectRoot, path)}:${index + 1}: ${check.name}`,
        );
      }
    }
    const normalized = lines[index].toLowerCase();
    if (privateDenylist.some((value) => normalized.includes(value))) {
      findings.push(
        `${relative(projectRoot, path)}:${index + 1}: deployment-specific denylist term`,
      );
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Public-content scan failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Public-content scan passed.\n");
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
