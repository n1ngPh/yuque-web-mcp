import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CookieJar } from "tough-cookie";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CryptoBox } from "../../dist/src/crypto.js";
import { SessionStore } from "../../dist/src/session-store.js";
import { toolDefinitions } from "../../dist/src/mcp.js";
import { initializePlan } from "./init-plan.mjs";
import {
  parseEnvironment,
  validatePlan,
  assertWriteEnabled,
  assertPrivatePlanPath,
} from "./table-archive-config.mjs";
import {
  createArchiveRuntime,
  createArchiveServer,
} from "./table-archive-mcp.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "yuque-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32),
    crypto = new CryptoBox(key),
    envFile = join(dir, "local.env");
  const env = {
    HOST: "127.0.0.1",
    DATA_DIR: dir,
    YUQUE_HOST: "https://team.yuque.com",
    MCP_OWNER_ID: "test-owner",
    MCP_BEARER_TOKEN: "local-fixture-bearer",
    SESSION_ENCRYPTION_KEY: key.toString("base64"),
    PUBLIC_BASE_URL: "http://127.0.0.1:18080",
    WRITE_KILL_SWITCH: "false",
    WRITE_CONSISTENCY_MODE: "best_effort",
    YUQUE_WRITE_BOOK_ALLOWLIST: "https://team.yuque.com/group/book",
  };
  const saveEnv = async () =>
    writeFile(
      envFile,
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      { mode: 0o600 },
    );
  await saveEnv();
  const sessions = new SessionStore(dir, crypto);
  await sessions.save(env.MCP_OWNER_ID, {
    account: { id: "1", login: "fixture", name: "Example User" },
    csrfToken: "fixture-csrf",
    cookies: new CookieJar().serializeSync(),
    savedAt: new Date().toISOString(),
  });
  const columns = [
    { id: "text", name: "具体工作内容", type: "text" },
    { id: "owner", name: "负责人", type: "mention" },
  ];
  const body = {
    text: { value: "Archive experiment" },
    owner: { value: [{ id: 1, name: "Example User" }] },
  };
  const row = (uuid, id, sheet, data, user = 1) => ({
    uuid,
    doc_id: id,
    doc_type: "Doc",
    sheet_id: sheet,
    user_id: user,
    modifier_id: user,
    data: JSON.stringify(data),
  });
  const tables = {
    source: {
      id: 101,
      slug: "source",
      sheetId: "source-sheet",
      records: [
        row("source-record", 101, "source-sheet", body),
        row(
          "other-source",
          101,
          "source-sheet",
          { text: { value: "Unrelated" } },
          2,
        ),
      ],
    },
    archive: {
      id: 102,
      slug: "archive",
      sheetId: "archive-sheet",
      records: [
        row(
          "other-target",
          102,
          "archive-sheet",
          { text: { value: "Old record" } },
          2,
        ),
      ],
    },
  };
  const spec = (table) => ({
    id: table.id,
    bookId: 10,
    sheetId: table.sheetId,
    slug: table.slug,
  });
  const plan = {
    schemaVersion: 1,
    envFile,
    sourceUrl: env.YUQUE_HOST + "/group/book/source",
    targetUrl: env.YUQUE_HOST + "/group/book/archive",
    source: spec(tables.source),
    target: spec(tables.archive),
    sourceRecordId: "source-record",
    targetRecordId: "new-record",
    expectedText: "Archive experiment",
    accountId: "1",
    accountName: "Example User",
    textFieldName: "具体工作内容",
    ownerFieldName: "负责人",
  };
  const planPath = join(dir, "operation", "plan.json");
  await mkdir(join(dir, "operation"));
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const writes = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, env.YUQUE_HOST);
    assert.equal(options.redirect, "manual");
    const args =
      options.method === "GET"
        ? Object.fromEntries(url.searchParams)
        : JSON.parse(options.body);
    let table;
    if (url.pathname.startsWith("/api/docs/"))
      table = tables[url.pathname.split("/").pop()];
    else
      table = Object.values(tables).find(
        (t) => String(t.id) === String(args.docId),
      );
    assert(table, "Unexpected target");
    let result;
    if (url.pathname.startsWith("/api/docs/"))
      result = {
        data: {
          id: table.id,
          slug: table.slug,
          book_id: 10,
          type: "Table",
          format: "laketable",
          content: JSON.stringify({
            format: "laketable",
            sheet: [
              {
                id: table.sheetId,
                columns,
                activeView: "grid",
                views: { grid: { id: "grid", name: "View", type: "GRID" } },
              },
            ],
          }),
        },
      };
    else if (url.pathname.endsWith("/show")) {
      assert.equal(options.method, "GET");
      result = { records: table.records, users: [], hasMore: false };
    } else if (url.pathname.endsWith("/getContent")) {
      assert.equal(options.method, "POST");
      result = {
        content: Object.fromEntries(args.recordIds.map((id) => [id, null])),
      };
    } else if (url.pathname.endsWith("/create")) {
      assert.equal(options.method, "POST");
      assert.equal(table, tables.archive);
      assert.deepEqual(args.data, [{ id: plan.targetRecordId }]);
      writes.push("create");
      table.records.push(row(plan.targetRecordId, table.id, table.sheetId, {}));
      result = { records: [table.records.at(-1)], users: [] };
    } else if (url.pathname.endsWith("/bulkUpdate")) {
      assert.equal(options.method, "PUT");
      assert(args.records.every((r) => r.recordId === plan.targetRecordId));
      writes.push("populate");
      table.records.at(-1).data = JSON.stringify(
        Object.fromEntries(args.records.map((r) => [r.fieldId, r.data])),
      );
      result = { records: [table.records.at(-1)] };
    } else if (url.pathname.endsWith("/remove")) {
      assert.equal(options.method, "DELETE");
      assert.equal(table, tables.source);
      assert.deepEqual(args.recordIds, [plan.sourceRecordId]);
      writes.push("remove");
      table.records = table.records.filter(
        (r) => r.uuid !== plan.sourceRecordId,
      );
      result = { success: true };
    } else throw Error("Unexpected endpoint");
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    dir,
    env,
    saveEnv,
    plan,
    planPath,
    crypto,
    tables,
    columns,
    writes,
    fetchImpl,
  };
}
async function connect(t, runtime) {
  const server = createArchiveServer(runtime),
    client = new Client({ name: "archive-fixture", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    call: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      assert(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    },
  };
}

test("portable MCP adapter executes copy/readback/remove using only fixture network", async (t) => {
  const f = await fixture(t);
  const runtime = await createArchiveRuntime(f.planPath, {
    enableWrites: true,
    fetchImpl: f.fetchImpl,
  });
  const { client, call } = await connect(t, runtime);
  assert.equal((await client.listTools()).tools.length, 4);
  const p = await call("table_archive_preview");
  assert.deepEqual(f.writes, []);
  await call("table_archive_stage", { diff_digest: p.diff_digest });
  assert.equal(f.tables.source.records.length, 2);
  const result = await call("table_archive_finalize", {
    diff_digest: p.diff_digest,
  });
  assert.equal(result.state, "succeeded");
  assert.deepEqual(f.writes, ["create", "populate", "remove"]);
  const status = await call("table_archive_status");
  assert.equal(status.state, "succeeded");
  const files = await readdir(join(f.dir, "operation"));
  assert(files.some((n) => n.startsWith("response-") && n.endsWith(".enc")));
  assert(!files.some((n) => n.startsWith("response-") && n.endsWith(".json")));
  for (const name of files.filter((n) => n.endsWith(".enc"))) {
    const text = await readFile(join(f.dir, "operation", name), "utf8");
    assert(!text.includes("Archive experiment"));
    assert(!text.includes("fixture-csrf"));
  }
  assert.equal((await stat(join(f.dir, "operation"))).mode & 0o777, 0o700);
});
test("default stdio experiment is preview-only and leaves preview executable", async (t) => {
  const f = await fixture(t);
  const runtime = await createArchiveRuntime(f.planPath, {
    fetchImpl: f.fetchImpl,
  });
  const { client, call } = await connect(t, runtime);
  const p = await call("table_archive_preview");
  const blocked = await client.callTool({
    name: "table_archive_stage",
    arguments: { diff_digest: p.diff_digest },
  });
  assert(blocked.isError);
  assert.match(blocked.content[0].text, /enable-writes/);
  assert.equal((await call("table_archive_status")).state, "previewed");
  assert.deepEqual(f.writes, []);
});
test("disabling policy after stage preserves source and blocks finalization", async (t) => {
  const f = await fixture(t);
  const runtime = await createArchiveRuntime(f.planPath, {
    enableWrites: true,
    fetchImpl: f.fetchImpl,
  });
  const { client, call } = await connect(t, runtime);
  const p = await call("table_archive_preview");
  await call("table_archive_stage", { diff_digest: p.diff_digest });
  f.env.WRITE_KILL_SWITCH = "true";
  await f.saveEnv();
  const blocked = await client.callTool({
    name: "table_archive_finalize",
    arguments: { diff_digest: p.diff_digest },
  });
  assert(blocked.isError);
  assert.equal((await call("table_archive_status")).state, "staged");
  assert.deepEqual(f.writes, ["create", "populate"]);
});
test("plan/config validation blocks host drift and unsafe operation scope", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    parseEnvironment('# comment\nHOST="127.0.0.1"\nTOKEN=part=part\n'),
    { HOST: "127.0.0.1", TOKEN: "part=part" },
  );
  for (const patch of [
    { targetUrl: "https://other.yuque.com/group/book/archive" },
    { targetUrl: "https://team.yuque.com/group/other/archive" },
    { sourceRecordId: f.plan.targetRecordId },
    { schemaVersion: 2 },
  ])
    assert.throws(() =>
      validatePlan({ ...f.plan, ...patch }, f.env, f.planPath),
    );
  assert.throws(() =>
    assertPrivatePlanPath(resolve(f.dir, "..", "plan.json"), f.dir),
  );
  assert.throws(() => assertPrivatePlanPath(join(f.dir, "plan.json"), f.dir));
  for (const patch of [
    { WRITE_KILL_SWITCH: "true" },
    { WRITE_KILL_SWITCH: "" },
    { WRITE_CONSISTENCY_MODE: "strict" },
    { YUQUE_WRITE_BOOK_ALLOWLIST: "" },
  ])
    assert.throws(() =>
      assertWriteEnabled({ ...f.env, ...patch }, f.plan, true),
    );
});
test("status remains readable with a stale operation lock; writes stay blocked", async (t) => {
  const f = await fixture(t);
  const { client, call } = await connect(
    t,
    await createArchiveRuntime(f.planPath, { fetchImpl: f.fetchImpl }),
  );
  await writeFile(join(f.dir, "operation", "archive.lock"), "");
  assert.equal((await call("table_archive_status")).state, "not_started");
  const result = await client.callTool({
    name: "table_archive_preview",
    arguments: {},
  });
  assert(result.isError);
});
test("published stdio entrypoint lists tools from an unrelated working directory", async (t) => {
  const f = await fixture(t);
  const entry = fileURLToPath(
    new URL("./table-archive-mcp.mjs", import.meta.url),
  );
  const client = new Client({ name: "stdio-fixture", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, f.planPath],
    cwd: tmpdir(),
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 4);
    const r = await client.callTool({
      name: "table_archive_status",
      arguments: {},
    });
    assert(!r.isError);
    assert.equal(JSON.parse(r.content[0].text).state, "not_started");
  } finally {
    await client.close();
  }
});
test("init discovers real main tool names, writes private plan once, and never mutates remote data", async (t) => {
  const f = await fixture(t);
  const out = join(f.dir, "initialized", "plan.json");
  const calls = [];
  const mock = async (url, options) => {
    assert.equal(new URL(url).origin, f.env.PUBLIC_BASE_URL);
    const { tool, args } = JSON.parse(options.body);
    assert(toolDefinitions.some((t) => t.name === tool));
    calls.push(tool);
    let data;
    if (tool === "yuque_get_user")
      data = {
        owner_id: f.env.MCP_OWNER_ID,
        connected: true,
        yuque_account_id: "1",
        yuque_name: "Example User",
      };
    else {
      assert.equal(tool, "yuque_get_table");
      const table =
        args.doc_url === f.plan.sourceUrl ? f.tables.source : f.tables.archive;
      data = {
        id: String(table.id),
        book_id: 10,
        sheet_id: table.sheetId,
        url: args.doc_url,
        complete: true,
        columns: f.columns,
        records: table.records.map((r) => ({
          id: r.uuid,
          cells: Object.entries(JSON.parse(r.data)).map(([id, c]) => ({
            column_id: id,
            value: c.value,
          })),
        })),
      };
    }
    return new Response(JSON.stringify({ ok: true, data }));
  };
  const opts = {
    "env-file": f.plan.envFile,
    "source-url": f.plan.sourceUrl,
    "target-url": f.plan.targetUrl,
    "record-id": f.plan.sourceRecordId,
    "expected-text": f.plan.expectedText,
    out,
  };
  const result = await initializePlan(opts, mock);
  assert.equal(result.remote_writes, 0);
  assert.deepEqual(calls, [
    "yuque_get_user",
    "yuque_get_table",
    "yuque_get_table",
  ]);
  const plan = JSON.parse(await readFile(out, "utf8"));
  validatePlan(plan, f.env, out);
  assert.notEqual(plan.targetRecordId, f.plan.sourceRecordId);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  await assert.rejects(initializePlan(opts, mock), { code: "EEXIST" });
});
