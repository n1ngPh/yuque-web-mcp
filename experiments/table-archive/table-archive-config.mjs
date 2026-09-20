import assert from "node:assert/strict";
import { readFile, mkdir, chmod } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function parseEnvironment(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    assert(index > 0, "Expected KEY=value in env file");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

export async function loadEnvironment(path) {
  assert(isAbsolute(path), "envFile must be an absolute path");
  const env = parseEnvironment(await readFile(path, "utf8"));
  assert.equal(
    env.HOST,
    "127.0.0.1",
    "Only a local single-owner profile is supported",
  );
  assert(
    !env.MCP_USERS_FILE,
    "Multi-user env files are not supported by this experiment",
  );
  for (const key of [
    "DATA_DIR",
    "SESSION_ENCRYPTION_KEY",
    "MCP_OWNER_ID",
    "YUQUE_HOST",
  ])
    assert(env[key], `Missing ${key}`);
  assert(isAbsolute(env.DATA_DIR), "DATA_DIR must be absolute");
  const host = new URL(env.YUQUE_HOST);
  assert.equal(host.protocol, "https:");
  assert(
    host.hostname.endsWith(".yuque.com") && host.hostname !== "www.yuque.com",
    "An organization Yuque Host is required",
  );
  assert.equal(
    host.origin,
    env.YUQUE_HOST,
    "YUQUE_HOST must be an origin without a trailing slash",
  );
  assert(
    !env.YUQUE_HTTPS_PROXY && !env.YUQUE_CA_FILE,
    "Proxy/custom CA profiles are not supported by the archive experiment",
  );
  return env;
}

export function parseTableUrl(value, host) {
  const url = new URL(value);
  assert.equal(
    url.origin,
    host,
    "Table URL must use the configured organization Host",
  );
  assert(
    !url.username && !url.password && !url.search && !url.hash,
    "Use a canonical document URL without credentials, query or fragment",
  );
  const parts = url.pathname.split("/").filter(Boolean);
  assert(
    parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)),
    "Expected /group/book/document URL",
  );
  return { slug: parts[2], bookUrl: `${url.origin}/${parts[0]}/${parts[1]}` };
}

export function assertPrivatePlanPath(path, dataDir) {
  assert(isAbsolute(path), "Plan path must be absolute");
  const rel = relative(resolve(dataDir), resolve(path));
  assert(
    rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`),
    "Store the plan inside the profile DATA_DIR",
  );
  assert.notEqual(
    dirname(resolve(path)),
    resolve(dataDir),
    "Use a dedicated subdirectory for each archive operation",
  );
}

export function validatePlan(plan, env, path) {
  assertPrivatePlanPath(path, env.DATA_DIR);
  assert.equal(
    plan.schemaVersion,
    1,
    "Unsupported archive plan version; generate a new plan",
  );
  const source = parseTableUrl(plan.sourceUrl, env.YUQUE_HOST);
  const target = parseTableUrl(plan.targetUrl, env.YUQUE_HOST);
  assert.equal(
    source.bookUrl,
    target.bookUrl,
    "Only same-book archives are supported",
  );
  assert.notEqual(plan.sourceUrl, plan.targetUrl);
  for (const side of ["source", "target"]) {
    const spec = plan[side];
    assert(spec && Number.isSafeInteger(spec.id) && spec.id > 0);
    assert(Number.isSafeInteger(spec.bookId) && spec.bookId > 0);
    assert(
      typeof spec.sheetId === "string" && /^[A-Za-z0-9_-]+$/.test(spec.sheetId),
    );
    assert.equal(spec.slug, side === "source" ? source.slug : target.slug);
  }
  assert.equal(plan.source.bookId, plan.target.bookId);
  assert.notEqual(plan.source.id, plan.target.id);
  for (const key of ["sourceRecordId", "targetRecordId"])
    assert(
      typeof plan[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(plan[key]),
    );
  assert.notEqual(plan.sourceRecordId, plan.targetRecordId);
  assert(typeof plan.accountId === "string" && /^\d+$/.test(plan.accountId));
  for (const key of [
    "accountName",
    "expectedText",
    "textFieldName",
    "ownerFieldName",
  ])
    assert(
      typeof plan[key] === "string" &&
        plan[key].trim() &&
        plan[key].length <= 10000,
      `Missing/invalid ${key}`,
    );
  assert.notEqual(plan.textFieldName, plan.ownerFieldName);
  return plan;
}

export function assertWriteEnabled(env, plan, enabled) {
  assert(enabled, "Archive writes require the explicit --enable-writes option");
  assert.equal(
    env.WRITE_KILL_SWITCH,
    "false",
    "WRITE_KILL_SWITCH must explicitly be false",
  );
  assert.equal(
    env.WRITE_CONSISTENCY_MODE,
    "best_effort",
    "Archive writes require best_effort; strict is preview-only",
  );
  const allowlist = (env.YUQUE_WRITE_BOOK_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim());
  for (const url of [plan.sourceUrl, plan.targetUrl])
    assert(
      allowlist.includes(parseTableUrl(url, env.YUQUE_HOST).bookUrl),
      "An exact knowledge-base write allowlist is required",
    );
}

export async function preparePrivateDirectory(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
}
