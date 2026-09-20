import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  loadEnvironment,
  parseTableUrl,
  validatePlan,
  assertPrivatePlanPath,
  preparePrivateDirectory,
} from "./table-archive-config.mjs";

export async function initializePlan(options, fetchImpl = fetch) {
  for (const key of [
    "env-file",
    "source-url",
    "target-url",
    "record-id",
    "expected-text",
    "out",
  ])
    assert(options[key], `Missing --${key}`);
  const envFile = resolve(options["env-file"]);
  const env = await loadEnvironment(envFile);
  const sourceUrl = options["source-url"],
    targetUrl = options["target-url"];
  const sourceLocator = parseTableUrl(sourceUrl, env.YUQUE_HOST),
    targetLocator = parseTableUrl(targetUrl, env.YUQUE_HOST);
  assert.equal(sourceLocator.bookUrl, targetLocator.bookUrl);
  assert.notEqual(sourceUrl, targetUrl);
  assert(
    env.MCP_BEARER_TOKEN,
    "The local service bearer token must be present in the env file",
  );
  const baseUrl = new URL(env.PUBLIC_BASE_URL);
  assert.equal(baseUrl.protocol, "http:");
  assert.equal(
    baseUrl.hostname,
    "127.0.0.1",
    "Plan discovery calls only a loopback service",
  );
  assert(
    !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash,
  );
  const out = resolve(options.out);
  assertPrivatePlanPath(out, env.DATA_DIR);
  const call = async (tool, args) => {
    const response = await fetchImpl(new URL("/api/call", baseUrl), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
      headers: {
        Authorization: `Bearer ${env.MCP_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool, args }),
    });
    assert(response.ok, `Local service returned HTTP ${response.status}`);
    const body = await response.json();
    assert(body.ok, "Local tool failed; check service login and table access");
    return body.data;
  };
  const account = await call("yuque_get_user", {});
  assert(
    account.connected && account.yuque_account_id,
    "Log in through the main MCP first",
  );
  assert.equal(
    account.owner_id,
    env.MCP_OWNER_ID,
    "Bearer token is bound to another local owner",
  );
  const source = await call("yuque_get_table", {
    doc_url: sourceUrl,
    limit: 5000,
    ...(options["source-sheet-id"]
      ? { sheet_id: options["source-sheet-id"] }
      : {}),
  });
  const target = await call("yuque_get_table", {
    doc_url: targetUrl,
    limit: 5000,
    ...(options["target-sheet-id"]
      ? { sheet_id: options["target-sheet-id"] }
      : {}),
  });
  for (const table of [source, target])
    assert(
      table.complete && table.sheet_id,
      "Both tables must be complete, at most 5000 rows; supply a sheet ID if selection_required",
    );
  const row = source.records.find((r) => r.id === options["record-id"]);
  assert(row, "Source record not found");
  const textFieldName = options["text-field"] || "具体工作内容",
    ownerFieldName = options["owner-field"] || "负责人";
  const textCols = source.columns.filter((c) => c.name === textFieldName);
  const ownerCols = source.columns.filter((c) => c.name === ownerFieldName);
  assert(
    textCols.length === 1 && ownerCols.length === 1,
    "Expected unique text/owner field names",
  );
  assert.equal(
    row.cells.find((c) => c.column_id === textCols[0].id)?.value,
    options["expected-text"],
    "Expected text does not match the selected record",
  );
  const spec = (table) => ({
    id: Number(table.id),
    bookId: table.book_id,
    sheetId: table.sheet_id,
    slug: new URL(table.url).pathname.split("/").pop(),
  });
  const plan = {
    schemaVersion: 1,
    envFile,
    sourceUrl,
    targetUrl,
    source: spec(source),
    target: spec(target),
    sourceRecordId: options["record-id"],
    targetRecordId: randomBytes(16).toString("hex"),
    accountId: String(account.yuque_account_id),
    accountName: account.yuque_name || account.yuque_login,
    expectedText: options["expected-text"],
    textFieldName,
    ownerFieldName,
  };
  validatePlan(plan, env, out);
  await preparePrivateDirectory(out);
  await writeFile(out, JSON.stringify(plan, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return {
    plan_path: out,
    source_count: source.records.length,
    target_count: target.records.length,
    remote_writes: 0,
  };
}

const help = `Create a private one-record archive plan (read-only discovery).
Usage: node experiments/table-archive/init-plan.mjs \\
  --env-file /absolute/profile/local.env \\
  --source-url https://team.yuque.com/group/book/source \\
  --target-url https://team.yuque.com/group/book/archive \\
  --record-id RECORD_ID --expected-text 'Exact record text' \\
  --out /absolute/profile/archive-operation/plan.json
Optional: --text-field NAME --owner-field NAME --source-sheet-id ID --target-sheet-id ID
The output directory must be a dedicated subdirectory of the profile DATA_DIR.`;
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const names = [
      "env-file",
      "source-url",
      "target-url",
      "record-id",
      "expected-text",
      "out",
      "text-field",
      "owner-field",
      "source-sheet-id",
      "target-sheet-id",
    ];
    const { values } = parseArgs({
      options: {
        ...Object.fromEntries(names.map((n) => [n, { type: "string" }])),
        help: { type: "boolean" },
      },
      strict: true,
    });
    if (values.help) console.log(help);
    else console.log(JSON.stringify(await initializePlan(values), null, 2));
  } catch (error) {
    console.error(error.message.split("\n")[0]);
    process.exitCode = 1;
  }
}
