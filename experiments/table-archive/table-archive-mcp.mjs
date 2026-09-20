// Local, single-record experiment. This does not enable writes in the public MCP.
import { readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CookieJar } from "tough-cookie";
import { CryptoBox } from "../../dist/src/crypto.js";
import { SessionStore } from "../../dist/src/session-store.js";
import {
  parseTableSchema,
  parseTableRecords,
} from "../../dist/src/table-model.js";
import { ArchiveMove } from "./table-archive-core.mjs";
import {
  loadEnvironment,
  validatePlan,
  assertWriteEnabled,
  preparePrivateDirectory,
} from "./table-archive-config.mjs";
import { pathToFileURL } from "node:url";

export async function createArchiveRuntime(
  planPath,
  { enableWrites = false, fetchImpl = fetch } = {},
) {
  planPath = resolve(planPath);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const root = dirname(planPath);
  const env = await loadEnvironment(plan.envFile);
  validatePlan(plan, env, planPath);
  await preparePrivateDirectory(planPath);
  const checkWrites = async () => {
    const latest = await loadEnvironment(plan.envFile);
    // A live policy change may disable writes, but must never rebind this operation.
    for (const key of [
      "MCP_OWNER_ID",
      "YUQUE_HOST",
      "DATA_DIR",
      "SESSION_ENCRYPTION_KEY",
    ])
      assert.equal(
        latest[key],
        env[key],
        "Profile identity changed; stop and reconcile",
      );
    assertWriteEnabled(latest, plan, enableWrites);
  };
  const crypto = new CryptoBox(
    Buffer.from(env.SESSION_ENCRYPTION_KEY, "base64"),
  );
  const sessions = new SessionStore(env.DATA_DIR, crypto);
  const statePath = resolve(root, "archive-state.enc");
  const context = "single-table-archive:" + plan.sourceRecordId;
  const tableSpecs = { source: plan.source, target: plan.target };
  let requestSequence = 0;
  async function account() {
    const s = await sessions.load(env.MCP_OWNER_ID);
    assert(s, "Login required");
    assert.equal(String(s.account.id), plan.accountId);
    return s.account;
  }
  async function request(side, method, controller, action, payload = {}) {
    assert(["source", "target"].includes(side));
    const spec = tableSpecs[side];
    const origin = new URL(side === "source" ? plan.sourceUrl : plan.targetUrl)
      .origin;
    const path =
      controller === "docs"
        ? `/api/docs/${spec.slug}`
        : `/api/modules/table/doc/${controller}/${action}`;
    const allowed = new Set([
      "GET docs/detail",
      "GET TableRecordController/show",
      "POST TableRecordController/getContent",
      "POST TableRecordController/create",
      "PUT TableRecordValueController/bulkUpdate",
      "DELETE TableRecordController/remove",
    ]);
    assert(allowed.has(`${method} ${controller}/${action}`));
    if (action === "create" || action === "bulkUpdate" || action === "remove")
      await checkWrites();
    if (action === "create") {
      assert.equal(side, "target");
      assert.deepEqual(payload.data, [{ id: plan.targetRecordId }]);
    }
    if (action === "bulkUpdate") {
      assert.equal(side, "target");
      assert(
        payload.records.length === 2 &&
          payload.records.every((r) => r.recordId === plan.targetRecordId),
      );
    }
    if (action === "remove") {
      assert.equal(side, "source");
      assert.deepEqual(payload.recordIds, [plan.sourceRecordId]);
    }
    const s = await sessions.load(env.MCP_OWNER_ID);
    assert(s, "Login required");
    assert.equal(String(s.account.id), plan.accountId);
    const jar = CookieJar.deserializeSync(s.cookies);
    const url = new URL(path, origin);
    if (method === "GET")
      for (const [k, v] of Object.entries(payload))
        url.searchParams.set(k, String(v));
    const headers = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: side === "source" ? plan.sourceUrl : plan.targetUrl,
      Origin: origin,
      Cookie: await jar.getCookieString(url.href),
      "x-csrf-token": s.csrfToken,
      "x-login": s.account.login,
    };
    if (method !== "GET") headers["Content-Type"] = "application/json";
    // No retry on uncertain writes. Never print request headers/session material.
    const response = await fetchImpl(url, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw Error(`Non-JSON response (${response.status})`);
    }
    await writeFile(
      resolve(root, `response-${process.pid}-${++requestSequence}.enc`),
      crypto.encrypt(
        { side, method, path, status: response.status, body: json },
        context + ":response",
      ),
      { mode: 0o600 },
    );
    assert(response.ok, `Request failed (${response.status})`);
    assert(json.success !== false, "Upstream rejected request");
    if (json.meta?.code !== undefined)
      assert([0, 200].includes(json.meta.code), "Upstream error code");
    // This helper does not persist cookies, to avoid overwriting the live service's session.
    return json;
  }
  const params = (table) => ({
    sheetId: table.sheetId,
    type: table.view.type,
    viewId: table.view.id,
    docId: table.id,
    docType: "Doc",
  });
  async function read(side) {
    const spec = tableSpecs[side];
    const detail = (
      await request(side, "GET", "docs", "detail", {
        book_id: spec.bookId,
        mode: "edit",
        merge_dynamic_data: false,
      })
    ).data;
    assert.equal(detail.id, spec.id);
    assert.equal(detail.book_id, spec.bookId);
    assert.equal(detail.type, "Table");
    assert.equal(detail.format, "laketable");
    assert.equal(detail.slug, spec.slug);
    const sheet = parseTableSchema(detail.content).find(
      (s) => s.id === spec.sheetId,
    );
    assert(sheet);
    assert(sheet.views.length > 0);
    const raw = JSON.parse(detail.content).sheet.find(
      (s) => s.id === spec.sheetId,
    );
    const view =
      sheet.views.find((v) => v.id === (raw.activeView || raw.defaultView)) ||
      sheet.views.find((v) => v.type === "GRID");
    assert(view?.type === "GRID", "A GRID view is required");
    const page = await request(side, "GET", "TableRecordController", "show", {
      docId: spec.id,
      docType: "Doc",
      sheetId: spec.sheetId,
      limit: 5000,
      offset: 0,
    });
    parseTableRecords(page, sheet, String(spec.id), 5000);
    assert.equal(
      page.hasMore,
      false,
      "Single-test harness requires at most 5000 records",
    );
    return {
      url: side === "source" ? plan.sourceUrl : plan.targetUrl,
      id: spec.id,
      bookId: spec.bookId,
      sheetId: spec.sheetId,
      columns: sheet.columns,
      view,
      records: page.records,
      schema: JSON.parse(detail.content),
    };
  }
  const io = {
    assertWriteEnabled: checkWrites,
    account,
    read,
    load: async () => {
      try {
        return crypto.decrypt(await readFile(statePath, "utf8"), context);
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    save: async (state) => {
      const temp = statePath + ".tmp";
      await writeFile(temp, crypto.encrypt(state, context), { mode: 0o600 });
      await rename(temp, statePath);
    },
    content: async (side, id) => {
      const s = tableSpecs[side];
      const r = await request(
        side,
        "POST",
        "TableRecordController",
        "getContent",
        { docId: s.id, docType: "Doc", sheetId: s.sheetId, recordIds: [id] },
      );
      assert(
        r.content && Object.hasOwn(r.content, id),
        "Missing record description",
      );
      return r.content[id];
    },
    create: (table, id) =>
      request("target", "POST", "TableRecordController", "create", {
        ...params(table),
        data: [{ id }],
      }),
    populate: (table, values) =>
      request("target", "PUT", "TableRecordValueController", "bulkUpdate", {
        ...params(table),
        records: values,
      }),
    remove: (table, id) =>
      request("source", "DELETE", "TableRecordController", "remove", {
        ...params(table),
        recordIds: [id],
      }),
  };
  return { plan, io, root };
}

export function createArchiveServer({ plan, io, root }) {
  const move = new ArchiveMove(plan, io);
  const server = new Server(
    { name: "yuque-single-record-archive-test", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "table_archive_preview",
        description:
          "Preview the one local-plan-approved own test record move. No remote write.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      ...["stage", "finalize"].map((action) => ({
        name: "table_archive_" + action,
        description:
          action === "stage"
            ? "Create and verify the one archive copy. Retains source."
            : "Reverify archive and source; remove exactly the approved source row; compare all other rows.",
        inputSchema: {
          type: "object",
          properties: { diff_digest: { type: "string" } },
          required: ["diff_digest"],
          additionalProperties: false,
        },
      })),
      {
        name: "table_archive_status",
        description:
          "Read the durable operation status; never replay uncertain writes.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }));
  let busy = false;
  server.setRequestHandler(CallToolRequestSchema, async ({ params: p }) => {
    if (busy)
      return {
        isError: true,
        content: [
          { type: "text", text: "Another archive operation is running" },
        ],
      };
    busy = true;
    let lock;
    try {
      if (p.name !== "table_archive_status")
        lock = await open(resolve(root, "archive.lock"), "wx", 0o600);
      const args = p.arguments || {};
      const needsDigest = [
        "table_archive_stage",
        "table_archive_finalize",
      ].includes(p.name);
      assert(
        Object.keys(args).every((k) => needsDigest && k === "diff_digest"),
        "Unexpected tool arguments",
      );
      if (needsDigest)
        assert(
          typeof args.diff_digest === "string" &&
            /^[a-f0-9]{64}$/.test(args.diff_digest),
          "A valid preview diff_digest is required",
        );
      let result;
      if (p.name === "table_archive_preview") result = await move.preview();
      else if (p.name === "table_archive_stage")
        result = await move.stage(args.diff_digest);
      else if (p.name === "table_archive_finalize")
        result = await move.finalize(args.diff_digest);
      else if (p.name === "table_archive_status") {
        const s = await io.load();
        result = s
          ? {
              state: s.state,
              diff_digest: s.diff_digest,
              preview: s.preview,
              result: s.result,
            }
          : { state: "not_started" };
      } else throw Error("Unknown tool");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: e.message.split("\n")[0] }],
      };
    } finally {
      if (lock) {
        await lock.close();
        await unlink(resolve(root, "archive.lock"));
      }
      busy = false;
    }
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node experiments/table-archive/table-archive-mcp.mjs /absolute/DATA_DIR/archive-operation/plan.json [--enable-writes]",
    );
  } else {
    try {
      assert(
        process.argv[2] && !process.argv[2].startsWith("--"),
        "An absolute plan path is required (see --help)",
      );
      assert(
        process.argv.slice(3).every((arg) => arg === "--enable-writes"),
        "Unknown option",
      );
      const runtime = await createArchiveRuntime(process.argv[2], {
        enableWrites: process.argv.includes("--enable-writes"),
      });
      await createArchiveServer(runtime).connect(new StdioServerTransport());
    } catch (error) {
      console.error(error.message.split("\n")[0]);
      process.exitCode = 1;
    }
  }
}
