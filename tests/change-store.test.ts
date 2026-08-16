import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/db.js";
import { CryptoBox, fingerprint } from "../src/crypto.js";
import { ChangeStore } from "../src/change-store.js";
import { decodeLakeSheetDraft } from "../src/sheet-codec.js";
import type { AppConfig } from "../src/config.js";
import type {
  NormalizedDoc,
  NormalizedSheetDocument,
  YuqueWebClient,
} from "../src/yuque-client.js";

const temporaryDirectories: string[] = [];
const DOC_URL = "https://example-team.yuque.com/team/book/doc";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("single-owner safe change store", () => {
  it("marks an interrupted executing change unknown on startup", async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    fixture.db.insertPendingChange({
      change_id: "interrupted-change",
      kind: "update_doc",
      encrypted_payload: "not-read-during-reconciliation",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: now,
      created_at: now,
      updated_at: now,
      state: "executing",
      diff_digest: "digest",
      has_deletions: 0,
      target_hash: "target",
      error_code: null,
    });
    new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      {} as YuqueWebClient,
    );
    expect(fixture.db.getPendingChange("interrupted-change")).toMatchObject({
      state: "unknown",
      error_code: "process_interrupted",
    });
    fixture.db.close();
  });

  it("previews and confirms a verified private personal knowledge base once", async () => {
    const fixture = await createFixture();
    let writes = 0;
    const client = {
      preparePersonalBookCreate: async (_owner: string, name: string) => ({
        name,
        ownerLogin: "alice",
        displayPath: `个人：Alice / ${name}`,
        dashboardUrl: "https://www.yuque.com/dashboard",
      }),
      createPersonalBook: async (
        _owner: string,
        input: { name: string; description?: string },
      ) => {
        writes += 1;
        return {
          status: "created" as const,
          id: "44",
          slug: "abc123",
          name: input.name,
          bookUrl: "https://www.yuque.com/alice/abc123",
          displayPath: `个人：Alice / ${input.name}`,
          private: true as const,
          reconciledAfterUnknownResponse: false,
        };
      },
    } as unknown as YuqueWebClient;
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );

    const preview = await changes.previewCreateBook("employee.a", {
      name: "yuque-web-mcp-e2e",
      description: "sandbox",
    });
    expect(preview.display_path).toBe("个人：Alice / yuque-web-mcp-e2e");
    expect(preview.target_url).toBe("https://www.yuque.com/dashboard");
    expect(preview.diff).toContain("visibility: private");
    expect(preview.requires_deletion_confirmation).toBe(false);
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({
      status: "created",
      bookUrl: "https://www.yuque.com/alice/abc123",
      private: true,
    });
    expect(writes).toBe(1);
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("succeeded");
    fixture.db.close();
  });

  it("keeps every remote Confirm previewed in strict mode", async () => {
    const fixture = await createFixture();
    fixture.config.writeConsistencyMode = "strict";
    const current = doc('<p data-lake-id="a">body</p>', "body");
    let writes = 0;
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      docClient(
        () => current,
        undefined,
        () => {
          writes += 1;
        },
      ),
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "rename",
      newTitle: "strict-preview-only",
    });

    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("strict write consistency mode");
    expect(writes).toBe(0);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "previewed",
    );
    fixture.db.close();
  });

  it("applies a native Lake append once and preserves untouched bytes", async () => {
    const fixture = await createFixture();
    const untouched = '<h2 data-lake-id="other">Other</h2><p>keep exact</p>';
    let current = doc(
      `<meta name="lake"/><h2 data-lake-id="target">Target</h2><p>old</p>${untouched}`,
      "Target\nold\nOther\nkeep exact",
    );
    let writes = 0;
    const client = docClient(
      () => current,
      (lake) => {
        writes += 1;
        current = doc(lake, "Target\nold\nOther\nkeep exact\nnew body", 2);
      },
    );
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );

    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "append",
      newMarkdown: "new body",
    });
    expect(preview.diff).toContain("+new body");
    await expect(
      changes.confirmChange(
        "employee.b",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("Owner mismatch");
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({ status: "updated" });
    expect(current.lakeContent).toContain(untouched);
    expect(writes).toBe(1);
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("succeeded");
    fixture.db.close();
  });

  it("rebases only when a colleague changed a non-target section", async () => {
    const fixture = await createFixture();
    let current = doc(
      '<h2 data-lake-id="a">Target</h2><p>old</p><h2 data-lake-id="b">Other</h2><p>keep</p>',
      "Target\nold\nOther\nkeep",
    );
    const client = docClient(() => current);
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "replace_section",
      sectionHeading: "Target",
      newMarkdown: "replacement",
    });
    current = doc(
      '<h2 data-lake-id="a">Target</h2><p>old</p><h2 data-lake-id="b">Other</h2><p>colleague edit</p>',
      "Target\nold\nOther\ncolleague edit",
      2,
    );
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({
      status: "repreview_required",
      preview: { display_path: "book / test" },
    });
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "conflict",
    );
    fixture.db.close();
  });

  it("blocks an overlapping section change and requires deletion confirmation", async () => {
    const fixture = await createFixture();
    let current = doc(
      '<h2 data-lake-id="a">Target</h2><p>keep</p><p>remove me</p>',
      "Target\nkeep\nremove me",
    );
    let writes = 0;
    const client = docClient(
      () => current,
      () => {
        writes += 1;
      },
    );
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "replace_section",
      sectionHeading: "Target",
      newMarkdown: "keep",
    });
    expect(preview.requires_deletion_confirmation).toBe(true);
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        false,
      ),
    ).rejects.toThrow("confirm_deletions=true");
    current = doc(
      '<h2 data-lake-id="a">Target</h2><p>colleague changed target</p>',
      "Target\ncolleague changed target",
      2,
    );
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("target title or content region changed");
    expect(writes).toBe(0);
    fixture.db.close();
  });

  it("previews an explicit plain-section deletion with mandatory confirmation", async () => {
    const fixture = await createFixture();
    const current = doc(
      '<h2 data-lake-id="a">Delete me</h2><p>old text</p><h2 data-lake-id="b">Keep</h2><p data-byte="exact">unchanged</p>',
      "Delete me\nold text\nKeep\nunchanged",
    );
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      docClient(() => current),
    );

    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "delete_section",
      sectionHeading: "Delete me",
    });
    expect(preview.diff).toContain("-Delete me");
    expect(preview.diff).toContain("-old text");
    expect(preview.requires_deletion_confirmation).toBe(true);
    expect(preview.warnings).toContain(
      "The complete named section, including its heading, will be removed.",
    );
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        false,
      ),
    ).rejects.toThrow("confirm_deletions=true");
    fixture.db.close();
  });

  it("supports verified title-only writes and encrypts native snapshots", async () => {
    const fixture = await createFixture();
    let current = doc(
      '<p data-lake-id="a">top secret body</p>',
      "top secret body",
    );
    const client = docClient(
      () => current,
      undefined,
      (title) => {
        current = {
          ...current,
          title,
          fingerprint: fingerprint({ title, lake: current.lakeContent }),
        };
      },
    );
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "rename",
      newTitle: "renamed",
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({ status: "updated" });
    const snapshots = changes.listSnapshots("employee.a", DOC_URL);
    expect(snapshots).toHaveLength(1);

    const reader = new Database(fixture.config.databasePath, {
      readonly: true,
    });
    const stored = reader
      .prepare("SELECT encrypted_payload FROM snapshots LIMIT 1")
      .get() as { encrypted_payload: string };
    const tables = (
      reader
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(stored.encrypted_payload).not.toContain("top secret body");
    expect(tables).not.toContain("employees");
    reader.close();
    fixture.db.close();
  });

  it("produces structured Sheet cell diffs while live writes stay gated", async () => {
    const fixture = await createFixture();
    const client = {
      getSheet: async (_owner: string, docUrl: string) => ({
        id: "sheet-1",
        slug: "sheet",
        title: "test_表格",
        format: "lakesheet",
        bookId: 1,
        bookUrl: "https://example-team.yuque.com/team/book",
        version: 5,
        url: "https://example-team.yuque.com/team/book/sheet",
        location: {
          path: ["test_表格"],
          fullPath: ["book", "test_表格"],
          displayPath: "book / test_表格",
          level: 0,
          order: 0,
        },
        workbook: {
          id: "sheet-1",
          title: "test_表格",
          revision: "5",
          worksheets: [
            {
              id: "ws-1",
              name: "Sheet1",
              rowCount: 200,
              columnCount: 26,
              cells: { A1: { value: "old" }, B1: { value: 1 } },
            },
            {
              id: "ws-2",
              name: "Empty",
              rowCount: 200,
              columnCount: 26,
              cells: {},
            },
          ],
          fingerprint: "sheet-base",
        },
        bodyDraft: "",
        unsupportedFeatures: [],
        chartSummaries: [],
      }),
    } as unknown as YuqueWebClient;
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdateSheet("employee.a", {
      docUrl: "https://example-team.yuque.com/team/book/sheet",
      operations: [
        {
          op: "set_range",
          worksheet_id: "ws-1",
          range: "A1:B1",
          cells: [[{ value: "new" }, { value: null }]],
        },
      ],
    });
    expect(preview.diff).toContain('"cell": "A1"');
    expect(preview.diff).toContain('"cell": "B1"');
    expect(preview.requires_deletion_confirmation).toBe(true);
    for (const structuralDeletion of [
      {
        operation: {
          op: "delete_rows",
          worksheet_id: "ws-2",
          start_row: 11,
          count: 1,
        },
        expectedStructure: "rows",
        expectedStart: 11,
      },
      {
        operation: {
          op: "delete_columns",
          worksheet_id: "ws-2",
          start_column: 11,
          count: 1,
        },
        expectedStructure: "columns",
        expectedStart: 11,
      },
      {
        operation: { op: "delete_worksheet", worksheet_id: "ws-2" },
        expectedStructure: "worksheet",
      },
    ]) {
      const structuralPreview = await changes.previewUpdateSheet("employee.a", {
        docUrl: "https://example-team.yuque.com/team/book/sheet",
        operations: [structuralDeletion.operation],
      });
      expect(structuralPreview.diff).toContain(
        `"structure": "${structuralDeletion.expectedStructure}"`,
      );
      if (structuralDeletion.expectedStart !== undefined) {
        expect(structuralPreview.diff).toContain(
          `"start": ${String(structuralDeletion.expectedStart)}`,
        );
      }
      expect(structuralPreview.requires_deletion_confirmation).toBe(true);
    }
    const renamePreview = await changes.previewUpdateSheet("employee.a", {
      docUrl: "https://example-team.yuque.com/team/book/sheet",
      operations: [
        {
          op: "rename_worksheet",
          worksheet_id: "ws-2",
          name: "Renamed",
        },
      ],
    });
    expect(renamePreview.diff).toContain('"structure": "worksheet_name"');
    expect(renamePreview.diff).toContain('"before": "Empty"');
    expect(renamePreview.diff).toContain('"after": "Renamed"');
    expect(renamePreview.requires_deletion_confirmation).toBe(false);
    fixture.db.close();
  });

  it("stores a personal chart Preview but blocks remote chart Confirm", async () => {
    const fixture = await createFixture();
    const bodyDraft = personalChartDraft();
    const decoded = decodeLakeSheetDraft({
      id: "sheet-chart",
      title: "test_创建表格",
      draftVersion: 86,
      bodyDraft,
    });
    let writes = 0;
    const client = {
      getSheet: async (_owner: string, docUrl: string) => ({
        id: "sheet-chart",
        slug: "sheet",
        title: "test_创建表格",
        format: "lakesheet",
        bookId: 1,
        bookUrl: "https://www.yuque.com/u/test",
        version: 86,
        url: docUrl,
        location: {
          path: ["test_创建表格"],
          fullPath: ["测试知识库", "test_创建表格"],
          displayPath: "个人：测试员工 / 测试知识库 / test_创建表格",
          level: 0,
          order: 0,
        },
        workbook: decoded.workbook,
        bodyDraft,
        unsupportedFeatures: decoded.unsupportedFeatures,
        chartSummaries: decoded.chartSummaries,
      }),
      updateSheetDraft: async () => {
        writes += 1;
        return {};
      },
    } as unknown as YuqueWebClient;
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdateSheet("employee.a", {
      docUrl: "https://www.yuque.com/u/test/sheet",
      operations: [
        {
          op: "set_chart_type",
          chart_id: "chart0",
          chart_type: "line",
        },
      ],
    });
    expect(preview.display_path).toContain("测试知识库");
    expect(preview.diff).toContain('"chart_id": "chart0"');
    expect(preview.diff).toContain('"before": "column"');
    expect(preview.diff).toContain('"after": "line"');
    expect(preview.requires_deletion_confirmation).toBe(false);
    expect(fixture.db.getPendingChange(preview.change_token)?.kind).toBe(
      "update_sheet_chart",
    );
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("Chart Confirm is disabled");
    expect(writes).toBe(0);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "previewed",
    );
    expect(changes.cancel("employee.a", preview.change_token)).toBe(true);
    const deletionPreview = await changes.previewUpdateSheet("employee.a", {
      docUrl: "https://www.yuque.com/u/test/sheet",
      operations: [{ op: "delete_chart", chart_id: "chart0" }],
    });
    expect(deletionPreview.diff).toContain('"action": "delete"');
    expect(deletionPreview.stats).toEqual({
      added_lines: 0,
      removed_lines: 1,
      has_deletions: true,
    });
    expect(deletionPreview.requires_deletion_confirmation).toBe(true);
    await expect(
      changes.confirmChange(
        "employee.a",
        deletionPreview.change_token,
        deletionPreview.diff_digest,
        false,
      ),
    ).rejects.toThrow("confirm_deletions=true");
    await expect(
      changes.confirmChange(
        "employee.a",
        deletionPreview.change_token,
        deletionPreview.diff_digest,
        true,
      ),
    ).rejects.toThrow("Chart Confirm is disabled");
    expect(
      fixture.db.getPendingChange(deletionPreview.change_token)?.state,
    ).toBe("previewed");
    expect(changes.cancel("employee.a", deletionPreview.change_token)).toBe(
      true,
    );
    expect(writes).toBe(0);
    await expect(
      changes.previewUpdateSheet("employee.a", {
        docUrl: "https://example-team.yuque.com/team/book/sheet",
        operations: [
          {
            op: "set_chart_type",
            chart_id: "chart0",
            chart_type: "line",
          },
        ],
      }),
    ).rejects.toThrow("verified only for the personal Yuque Host");
    fixture.db.close();
  });

  it("fails closed before writing when a remote lock or collaborator is present", async () => {
    const fixture = await createFixture();
    const current = doc('<p data-lake-id="a">body</p>', "body");
    let writes = 0;
    const client = docClient(
      () => current,
      () => {
        writes += 1;
      },
    );
    client.getResourceLockState = async () => ({
      draftVersion: current.version,
      lockerPresent: true,
      collaboratorCount: 1,
      ownedByClient: false,
    });
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "append",
      newMarkdown: "blocked",
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("locked or has active collaborators");
    expect(writes).toBe(0);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "conflict",
    );
    fixture.db.close();
  });

  it("rechecks the document baseline after acquiring the remote lock", async () => {
    const fixture = await createFixture();
    const baseline = doc('<p data-lake-id="a">body</p>', "body");
    const changed = {
      ...doc('<p data-lake-id="a">body</p>', "body", 2),
      title: "changed-by-peer",
    };
    changed.fingerprint = fingerprint({
      lakeContent: changed.lakeContent,
      version: changed.version,
      title: changed.title,
    });
    let reads = 0;
    let writes = 0;
    const client = docClient(
      () => {
        reads += 1;
        return reads >= 3 ? changed : baseline;
      },
      undefined,
      () => {
        writes += 1;
      },
    );
    client.getResourceLockState = async () => ({
      draftVersion: baseline.version,
      lockerPresent: false,
      collaboratorCount: 0,
    });
    client.acquireResourceLock = async () => ({
      draftVersion: baseline.version,
      lockerPresent: true,
      collaboratorCount: 0,
      ownedByClient: true,
    });
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "rename",
      newTitle: "proposed-title",
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("after lock acquisition");
    expect(writes).toBe(0);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "conflict",
    );
    fixture.db.close();
  });

  it("serializes concurrent confirms for the same target and writes only the first baseline", async () => {
    const fixture = await createFixture();
    let current = doc('<p data-lake-id="a">body</p>', "body");
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writes = 0;
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const client = docClient(() => current);
    client.updateDocLake = async (_owner, input) => {
      writes += 1;
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await writeGate;
      current = doc(input.lakeContent, "body\nnext", current.version + 1);
      activeWrites -= 1;
      return {
        response: {},
        bodyHtml: "<!doctype html><p>generated</p>",
        reconciledAfterUnknownResponse: false,
      };
    };
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const first = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "append",
      newMarkdown: "next",
    });
    const second = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "append",
      newMarkdown: "next",
    });
    const firstConfirm = changes.confirmChange(
      "employee.a",
      first.change_token,
      first.diff_digest,
      true,
    );
    const secondConfirm = changes.confirmChange(
      "employee.a",
      second.change_token,
      second.diff_digest,
      true,
    );
    await Promise.resolve();
    releaseWrite();
    await expect(firstConfirm).resolves.toMatchObject({ status: "updated" });
    await expect(secondConfirm).rejects.toThrow(
      "target title or content region changed after preview",
    );
    expect(writes).toBe(1);
    expect(maximumActiveWrites).toBe(1);
    expect(fixture.db.getPendingChange(second.change_token)?.state).toBe(
      "conflict",
    );
    fixture.db.close();
  });

  it("reconciles Doc publish and title timeouts by read-back without retrying writes", async () => {
    const fixture = await createFixture();
    let current = doc('<p data-lake-id="a">body</p>', "body");
    let publishAttempts = 0;
    let renameAttempts = 0;
    const client = docClient(
      () => current,
      (lake) => {
        current = doc(lake, "body\nnext", current.version + 1);
      },
      (title) => {
        renameAttempts += 1;
        current = { ...current, title };
        current.fingerprint = fingerprint({
          lakeContent: current.lakeContent,
          version: current.version,
          title,
        });
      },
    );
    client.publishDoc = async () => {
      publishAttempts += 1;
      throw new TypeError("fetch failed after publish");
    };
    client.renameDoc = async (_owner, input) => {
      renameAttempts += 1;
      current = { ...current, title: input.title };
      current.fingerprint = fingerprint({
        lakeContent: current.lakeContent,
        version: current.version,
        title: input.title,
      });
      throw new TypeError("fetch failed after rename");
    };
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "append",
      newMarkdown: "next",
      newTitle: "renamed-after-timeout",
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({
      status: "updated",
      reconciled_after_unknown_response: true,
    });
    expect(publishAttempts).toBe(1);
    expect(renameAttempts).toBe(1);
    fixture.db.close();
  });

  it("reconciles an uncertain Sheet save by semantic read-back", async () => {
    const fixture = await createFixture();
    const docUrl = "https://www.yuque.com/u/test/sheet";
    let current = sheetDocument(docUrl, personalChartDraft());
    let attempts = 0;
    const client = sheetClient(
      () => current,
      async (bodyDraft) => {
        attempts += 1;
        current = sheetDocument(docUrl, bodyDraft, current.version + 1);
        throw new TypeError("network timeout after Sheet save");
      },
    );
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdateSheet("employee.a", {
      docUrl,
      operations: [
        {
          op: "set_range",
          worksheet_id: "0",
          range: "C1:C1",
          cells: [[{ value: "timeout-probe" }]],
        },
      ],
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({
      status: "updated",
      reconciled_after_unknown_response: true,
    });
    expect(attempts).toBe(1);
    expect(current.workbook.worksheets[0]?.cells.C1?.value).toBe(
      "timeout-probe",
    );
    fixture.db.close();
  });

  it("restores an encrypted Sheet snapshot through the same lock and read-back path", async () => {
    const fixture = await createFixture();
    const docUrl = "https://www.yuque.com/u/test/sheet";
    const originalDraft = personalChartDraft();
    let current = sheetDocument(docUrl, originalDraft);
    let attempts = 0;
    const client = sheetClient(
      () => current,
      async (bodyDraft) => {
        attempts += 1;
        current = sheetDocument(docUrl, bodyDraft, current.version + 1);
      },
    );
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const update = await changes.previewUpdateSheet("employee.a", {
      docUrl,
      operations: [
        {
          op: "set_range",
          worksheet_id: "0",
          range: "C1:C1",
          cells: [[{ value: "restore-probe" }]],
        },
      ],
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        update.change_token,
        update.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({ status: "updated" });
    expect(current.workbook.worksheets[0]?.cells.C1?.value).toBe(
      "restore-probe",
    );
    const snapshots = changes.listSnapshots("employee.a", docUrl);
    expect(snapshots).toHaveLength(1);
    const restore = await changes.previewRestoreSnapshot(
      "employee.a",
      String(snapshots[0]?.snapshot_id),
    );
    expect(restore.diff).toContain("restore-probe");
    expect(restore.requires_deletion_confirmation).toBe(true);
    await expect(
      changes.confirmChange(
        "employee.a",
        restore.change_token,
        restore.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({ status: "restored" });
    expect(current.workbook.worksheets[0]?.cells.C1).toBeUndefined();
    expect(attempts).toBe(2);
    fixture.db.close();
  });

  it("restores a verified historical Doc version through the guarded content path", async () => {
    const fixture = await createFixture();
    let current = doc(
      '<meta name="lake"/><p data-lake-id="current">current body</p>',
      "current body",
      7,
    );
    const historicalLake =
      '<meta name="lake"/><p data-lake-id="history">historical body</p>';
    let writes = 0;
    const client = docClient(
      () => current,
      (lake) => {
        writes += 1;
        current = doc(lake, "historical body", current.version + 1);
      },
    );
    client.getDocVersion = async () => ({
      doc: {
        id: current.id,
        title: current.title,
        url: DOC_URL,
        bookUrl: current.bookUrl,
        location: current.location,
      },
      version: {
        id: "42",
        docId: current.id,
        title: current.title,
        createdAt: "2026-08-15T00:00:00.000Z",
        draft: false,
        authorLogin: "employee.a",
        docType: "Doc",
        format: "lake",
        slug: current.slug,
        content: historicalLake,
        contentHtml: "<p>historical body</p>",
        plainText: "historical body",
        fingerprint: "historical-version-fingerprint",
      },
    });
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewRestoreDocVersion("employee.a", {
      docUrl: DOC_URL,
      versionId: "42",
    });
    expect(preview.diff).toContain("historical body");
    expect(fixture.db.getPendingChange(preview.change_token)?.kind).toBe(
      "restore_doc_version",
    );
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).resolves.toMatchObject({ status: "restored" });
    expect(current.lakeContent).toBe(historicalLake);
    expect(writes).toBe(1);
    expect(changes.listSnapshots("employee.a", DOC_URL)).toHaveLength(1);
    fixture.db.close();
  });

  it("marks a known write partial when lock release cannot be reconciled", async () => {
    const fixture = await createFixture();
    let current = doc('<p data-lake-id="a">body</p>', "body");
    let writes = 0;
    const client = docClient(
      () => current,
      (lake) => {
        writes += 1;
        current = doc(lake, "body\nnext", current.version + 1);
      },
    );
    client.releaseResourceLock = async () => {
      throw new Error("release failed");
    };
    const changes = new ChangeStore(
      fixture.config,
      fixture.db,
      fixture.crypto,
      client,
    );
    const preview = await changes.previewUpdate("employee.a", {
      docUrl: DOC_URL,
      mode: "append",
      newMarkdown: "next",
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
      ),
    ).rejects.toThrow("content step succeeded");
    expect(writes).toBe(1);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "partial",
    );
    fixture.db.close();
  });
});

async function createFixture(): Promise<{
  config: AppConfig;
  db: AppDatabase;
  crypto: CryptoBox;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "yuque-change-test-"));
  temporaryDirectories.push(dataDir);
  const config = testConfig(dataDir);
  const crypto = new CryptoBox(config.encryptionKey);
  const db = new AppDatabase(config.databasePath);
  return { config, db, crypto };
}

function doc(
  lakeContent: string,
  markdown: string,
  version = 1,
): NormalizedDoc {
  return {
    id: "1",
    slug: "doc",
    title: "test",
    markdown,
    lakeContent,
    bookId: 1,
    bookUrl: "https://example-team.yuque.com/team/book",
    format: "lake",
    version,
    url: DOC_URL,
    location: {
      path: ["test"],
      fullPath: ["book", "test"],
      displayPath: "book / test",
      level: 0,
      order: 0,
    },
    raw: { content: lakeContent },
    fingerprint: fingerprint({ lakeContent, version }),
  };
}

function docClient(
  read: () => NormalizedDoc,
  writeLake?: (lake: string) => void,
  rename?: (title: string) => void,
): YuqueWebClient {
  return {
    getDoc: async () => read(),
    getResourceLockState: async () => ({
      draftVersion: read().version,
      lockerPresent: false,
      collaboratorCount: 0,
    }),
    acquireResourceLock: async () => ({
      draftVersion: read().version,
      lockerPresent: true,
      collaboratorCount: 0,
      ownedByClient: true,
    }),
    releaseResourceLock: async () => undefined,
    convertMarkdownToLake: async (_owner: string, markdown: string) =>
      `<meta name="lake"/><p data-lake-id="new">${markdown}</p>`,
    assertDocContentUpdateEnabled: () => undefined,
    assertDocRenameEnabled: () => undefined,
    updateDocLake: async (_owner: string, input: { lakeContent: string }) => {
      writeLake?.(input.lakeContent);
      return {
        response: {},
        bodyHtml: "<!doctype html><p>generated</p>",
      };
    },
    publishDoc: async () => ({}),
    getDocEditorDraft: async () => ({
      publishedAsl: read().lakeContent,
      draftAsl: read().lakeContent,
      publishedHtml: "<!doctype html><p>generated</p>",
      draftHtml: "<!doctype html><p>generated</p>",
    }),
    renameDoc: async (_owner: string, input: { title: string }) => {
      rename?.(input.title);
      return {};
    },
  } as unknown as YuqueWebClient;
}

function sheetDocument(
  docUrl: string,
  bodyDraft: string,
  version = 86,
): NormalizedSheetDocument {
  const decoded = decodeLakeSheetDraft({
    id: "sheet-test",
    title: "yuque-web-mcp-sheet",
    draftVersion: version,
    bodyDraft,
  });
  return {
    id: "sheet-test",
    slug: "sheet",
    title: "yuque-web-mcp-sheet",
    format: "lakesheet",
    bookId: 1,
    bookUrl: "https://www.yuque.com/u/test",
    version,
    url: docUrl,
    location: {
      path: ["yuque-web-mcp-sheet"],
      fullPath: ["yuque-web-mcp-e2e", "yuque-web-mcp-sheet"],
      displayPath: "个人：测试 / yuque-web-mcp-e2e / yuque-web-mcp-sheet",
      level: 0,
      order: 0,
    },
    workbook: decoded.workbook,
    bodyDraft,
    unsupportedFeatures: decoded.unsupportedFeatures,
    chartSummaries: decoded.chartSummaries,
  };
}

function sheetClient(
  read: () => NormalizedSheetDocument,
  write: (bodyDraft: string) => Promise<void>,
): YuqueWebClient {
  return {
    getSheet: async () => read(),
    assertSheetUpdateEnabled: () => undefined,
    getResourceLockState: async () => ({
      draftVersion: read().version,
      lockerPresent: false,
      collaboratorCount: 0,
    }),
    acquireResourceLock: async () => ({
      draftVersion: read().version,
      lockerPresent: true,
      collaboratorCount: 0,
      ownedByClient: true,
    }),
    releaseResourceLock: async () => undefined,
    updateSheetDraft: async (_owner: string, input: { bodyDraft: string }) => {
      await write(input.bodyDraft);
      return {};
    },
  } as unknown as YuqueWebClient;
}

function testConfig(dataDir: string): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: "https://example-team.yuque.com",
    personalYuqueHost: "https://www.yuque.com",
    organization: "example-team",
    dataDir,
    databasePath: join(dataDir, "state.db"),
    contractPath: "unused",
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey: randomBytes(32),
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 1_000,
    writeConsistencyMode: "best_effort",
    allowUnverifiedContracts: false,
  };
}

function personalChartDraft(): string {
  const worksheet = {
    id: "0",
    name: "Sheet1",
    rowCount: 200,
    colCount: 26,
    index: 0,
    data: {
      0: { 0: { v: "项目" }, 1: { v: "数量" } },
      1: { 0: { v: "测试A" }, 1: { v: 4 } },
      2: { 0: { v: "测试B" }, 1: { v: 5 } },
    },
    selections: {},
    rows: {},
    columns: {},
    filter: {},
    mergeCells: {},
    vStore: {
      style: [],
      style_backColor: [],
      style_color: [],
      type: [],
    },
  };
  return JSON.stringify({
    format: "lakesheet",
    version: "3.5.5",
    larkJson: true,
    sheet: deflateSync(JSON.stringify([worksheet])).toString("latin1"),
    calcChain: [],
    vessels: {
      chart0: {
        type: "chart",
        id: "chart0",
        selections: {
          row: 0,
          col: 0,
          rowCount: 3,
          colCount: 2,
          activeRow: 0,
          activeCol: 0,
        },
        bbox: {
          left: 306.29999999999995,
          top: 142.36666666666665,
          width: 408.40000000000003,
          height: 282.2666666666667,
        },
        chartConfigs: { chartType: "column" },
        sheet: 0,
        dataSheet: 0,
        dataType: { name: "number" },
      },
    },
    customColors: [],
    formulaCalclated: true,
    useIndex: true,
    useUTC: true,
    versionId: "chartfixture0001",
    meta: { sort: 0, shareFilter: 0 },
  });
}
