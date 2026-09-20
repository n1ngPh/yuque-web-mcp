import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CookieJar } from "tough-cookie";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { YuqueWebClient } from "../src/yuque-client.js";
import { ChangeStore } from "../src/change-store.js";
import { AppDatabase } from "../src/db.js";
import { callTool, type McpDependencies } from "../src/mcp.js";
import type { AppConfig } from "../src/config.js";
import type { PendingChangePayload } from "../src/types.js";
import { archiveFixture } from "./helpers/archive-fixture.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("main MCP Table archive with synthetic HTTP upstream", () => {
  it("previews, confirms through the existing tool, persists encrypted phases and reconciles read-only", async () => {
    const f = await fixture(),
      preview = await f.preview();
    expect(preview.requires_deletion_confirmation).toBe(true);
    expect(f.writes).toEqual([]);
    expect(
      f.db.getPendingChange(preview.change_token)!.encrypted_payload,
    ).not.toContain("Exact text");
    const result = await f.confirm(preview);
    expect(result).toMatchObject({
      state: "succeeded",
      source_record_id: "source-row",
      target_record_id: preview.target_record_id,
    });
    expect(f.writes.map((w) => [w.method, w.path.split("/").at(-1)])).toEqual([
      ["POST", "create"],
      ["PUT", "bulkUpdate"],
      ["DELETE", "remove"],
    ]);
    expect(f.writes[0]!.body).toEqual({
      docId: "13",
      docType: "Doc",
      sheetId: "sheet-a",
      viewId: "grid",
      type: "GRID",
      data: [{ id: preview.target_record_id }],
    });
    expect(f.writes[1]!.body.records).toHaveLength(7);
    expect(f.writes[2]!.body.recordIds).toEqual(["source-row"]);
    const row = f.db.getPendingChange(preview.change_token)!;
    const payload = f.crypto.decrypt<PendingChangePayload>(
      row.encrypted_payload,
      `yuque-change:${f.config.ownerId}:${preview.change_token}`,
    );
    expect(payload.tableArchive?.phase).toBe("completed");
    expect(payload.tableArchive?.sourceRecord.uuid).toBe("source-row");
    await expect(f.status(preview, true)).resolves.toMatchObject({
      state: "succeeded",
      phase: "completed",
      reconciliation: {
        observed_complete: true,
        automatic_retry_allowed: false,
      },
    });
    await expect(f.confirm(preview)).rejects.toThrow(/succeeded/);
    await expect(
      f.changes.getTableArchiveStatus("employee.b", preview.change_token),
    ).rejects.toThrow(/Owner mismatch/);
    expect(f.writes).toHaveLength(3);
    expect(f.unexpected).toEqual([]);
  });

  it.each(["strict", "kill", "organization-open", "digest", "deletion"])(
    "keeps a blocked %s confirmation unconsumed",
    async (mode) => {
      const f = await fixture(),
        preview = await f.preview();
      if (mode === "strict") f.config.writeConsistencyMode = "strict";
      if (mode === "kill") f.config.writeKillSwitch = true;
      if (mode === "organization-open")
        f.config.writeOrganizationOpen = false;
      await expect(
        f.changes.confirmChange(
          "employee.a",
          preview.change_token,
          mode === "digest" ? "wrong" : preview.diff_digest,
          mode !== "deletion",
        ),
      ).rejects.toThrow();
      expect(f.db.getPendingChange(preview.change_token)?.state).toBe(
        "previewed",
      );
      expect(f.writes).toEqual([]);
    },
  );

  it("rejects expired previews without writes", async () => {
    const f = await fixture();
    f.config.changeTtlSeconds = -1;
    const p = await f.preview();
    await expect(f.confirm(p)).rejects.toThrow(/expired/);
    expect(f.writes).toEqual([]);
  });

  it.each(["bad-copy", "remove-timeout", "create-timeout"])(
    "journals %s and permits only read-only reconciliation",
    async (mode) => {
      const f = await fixture();
      f.behavior.mode = mode;
      const p = await f.preview();
      await expect(f.confirm(p)).resolves.toMatchObject({
        state: mode === "bad-copy" ? "partial" : "unknown",
        needs_reconciliation: true,
        automatic_retry_allowed: false,
      });
      const count = f.writes.length;
      await expect(f.status(p, true)).resolves.toMatchObject({
        reconciliation: {
          observed_complete: mode === "remove-timeout",
          source_present: mode !== "remove-timeout",
        },
      });
      await expect(f.confirm(p)).rejects.toThrow(/partial|unknown/);
      expect(f.writes).toHaveLength(count);
    },
  );

  it("retains a durable checkpoint after restart marks an interrupted execution unknown", async () => {
    const f = await fixture(),
      p = await f.preview();
    const row = f.db.getPendingChange(p.change_token)!;
    const context = `yuque-change:${f.config.ownerId}:${p.change_token}`;
    const payload = f.crypto.decrypt<PendingChangePayload>(
      row.encrypted_payload,
      context,
    );
    payload.tableArchive!.phase = "writing_target";
    f.db.transitionPendingChange(p.change_token, ["previewed"], "executing");
    f.db.updateExecutingPayload(
      p.change_token,
      f.crypto.encrypt(payload, context),
    );
    const restarted = new ChangeStore(f.config, f.db, f.crypto, f.client);
    await expect(
      restarted.getTableArchiveStatus("employee.a", p.change_token),
    ).resolves.toMatchObject({
      state: "unknown",
      phase: "writing_target",
      target_record_id: p.target_record_id,
      needs_reconciliation: true,
    });
    expect(() =>
      f.db.updateExecutingPayload(p.change_token, "invalid"),
    ).toThrow();
    expect(f.writes).toEqual([]);
  });

  it("serializes overlapping source/target archives so the second cannot duplicate a row", async () => {
    const f = await fixture(),
      a = await f.preview(),
      b = await f.preview();
    const results = await Promise.all([f.confirm(a), f.confirm(b)]);
    expect(results.map((r) => r.state).sort()).toEqual([
      "conflict",
      "succeeded",
    ]);
    expect(f.writes).toHaveLength(3);
  });

  it("rejects nonempty row bodies, incomplete tables and invalid MCP status arguments", async () => {
    const f = await fixture();
    f.behavior.mode = "body";
    await expect(f.preview()).rejects.toThrow(/descriptions/);
    f.behavior.mode = "more";
    await expect(f.preview()).rejects.toThrow(/complete table/);
    await expect(
      callTool(
        "employee.a",
        "yuque_get_table_archive_status",
        { change_token: "x", reconcile: "true" },
        f.deps,
      ),
    ).rejects.toThrow(/boolean/);
    expect(f.writes).toEqual([]);
  });
});

async function fixture() {
  const model = archiveFixture(),
    behavior = { mode: "normal" };
  const writes: Array<{
      method: string;
      path: string;
      body: Record<string, any>;
    }> = [],
    unexpected: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    res.setHeader("Content-Type", "application/json");
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (url.pathname === "/api/mine/books")
      return send({
        data: [
          {
            id: 11,
            slug: "book",
            name: "Book",
            items_count: 2,
            user: { login: "team" },
          },
        ],
      });
    if (url.pathname.startsWith("/api/docs/")) {
      const table = url.pathname.endsWith("source")
        ? model.source
        : model.target;
      return send({
        data: {
          id: Number(table.id),
          title: table.id === "12" ? "Source" : "Target",
          slug: table.id === "12" ? "source" : "target",
          book_id: 11,
          type: "Table",
          format: "laketable",
          draft_version: 1,
          updated_at: "2026-09-18T00:00:00Z",
          content: JSON.stringify({
            format: "laketable",
            type: "Table",
            sheet: [
              {
                id: table.sheetId,
                columns: table.columns,
                views: {
                  grid: { id: "grid", name: "Grid", type: "GRID", data: {} },
                },
              },
            ],
          }),
        },
      });
    }
    if (url.pathname === "/api/catalog_nodes")
      return send({
        data: [
          {
            type: "DOC",
            title: "Source",
            uuid: "node-s",
            parent_uuid: "",
            level: 0,
            visible: 1,
            doc_id: 12,
            url: "source",
          },
          {
            type: "DOC",
            title: "Target",
            uuid: "node-t",
            parent_uuid: "",
            level: 0,
            visible: 1,
            doc_id: 13,
            url: "target",
          },
        ],
      });
    const table =
      String(body.docId ?? url.searchParams.get("docId")) === "12"
        ? model.source
        : model.target;
    const rows = () =>
      table.records.map((r) => ({
        ...r,
        doc_id: Number(table.id),
        doc_type: "Doc",
        sheet_id: table.sheetId,
        data: JSON.stringify(r.data),
      }));
    const operation = url.pathname.split("/").at(-1);
    if (operation === "show")
      return send({
        records: rows(),
        users: [],
        hasMore: behavior.mode === "more",
      });
    if (operation === "getContent")
      return send({
        content: Object.fromEntries(
          body.recordIds.map((id: string) => [
            id,
            behavior.mode === "body" ? "description" : null,
          ]),
        ),
      });
    if (["create", "bulkUpdate", "remove"].includes(operation!)) {
      writes.push({ method: req.method!, path: url.pathname, body });
      if (operation === "create") {
        table.records.push({ uuid: body.data[0].id, data: {} });
        if (behavior.mode === "create-timeout") return req.socket.destroy();
        return send({ records: rows().slice(-1), users: [] });
      }
      if (operation === "bulkUpdate") {
        const id = body.records[0].recordId,
          row = table.records.find((r) => r.uuid === id)!;
        for (const field of body.records) row.data[field.fieldId] = field.data;
        if (behavior.mode === "bad-copy")
          row.data["target-text"] = { value: "truncated" };
        return send({ records: rows().filter((r) => r.uuid === id) });
      }
      table.records = table.records.filter(
        (r) => !body.recordIds.includes(r.uuid),
      );
      if (behavior.mode === "remove-timeout") return req.socket.destroy();
      return send({ success: true });
    }
    unexpected.push(`${req.method} ${url.pathname}`);
    res.statusCode = 404;
    send({});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const host = `http://127.0.0.1:${address.port}`;
  const dataDir = await mkdtemp(join(tmpdir(), "yuque-archive-test-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32),
    crypto = new CryptoBox(key),
    sessions = new SessionStore(dataDir, crypto);
  await sessions.save("employee.a", {
    cookies: new CookieJar().serializeSync(),
    csrfToken: "fixture-csrf",
    account: { id: "7", login: "alice" },
    savedAt: new Date().toISOString(),
  });
  const config: AppConfig = {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: host,
    personalYuqueHost: "https://www.yuque.com",
    organization: "test",
    dataDir,
    databasePath: join(dataDir, "state.db"),
    contractPath: "contracts/yuque-web-2026-08-14.json",
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey: key,
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 1000,
    writeConsistencyMode: "best_effort",
    writeKillSwitch: false,
    writeOrganizationOpen: true,
    allowUnverifiedContracts: false,
  };
  const client = new YuqueWebClient(
    config,
    await ContractRegistry.load(config.contractPath),
    sessions,
  );
  cleanups.push(() => client.close());
  const db = new AppDatabase(config.databasePath);
  cleanups.push(() => db.close());
  const changes = new ChangeStore(config, db, crypto, client),
    deps = { client, changes } as McpDependencies;
  const preview = () =>
    callTool(
      "employee.a",
      "yuque_preview_archive_table_record",
      {
        source_doc_url: `${host}/team/book/source`,
        target_doc_url: `${host}/team/book/target`,
        record_id: "source-row",
      },
      deps,
    ) as Promise<Awaited<ReturnType<ChangeStore["previewArchiveTableRecord"]>>>;
  const confirm = (p: { change_token: string; diff_digest: string }) =>
    callTool(
      "employee.a",
      "yuque_confirm_change",
      {
        change_token: p.change_token,
        diff_digest: p.diff_digest,
        confirm_deletions: true,
      },
      deps,
    ) as Promise<Record<string, unknown>>;
  const status = (p: { change_token: string }, reconcile = false) =>
    callTool(
      "employee.a",
      "yuque_get_table_archive_status",
      { change_token: p.change_token, reconcile },
      deps,
    );
  return {
    config,
    client,
    changes,
    db,
    crypto,
    deps,
    preview,
    confirm,
    status,
    writes,
    unexpected,
    behavior,
  };
}
