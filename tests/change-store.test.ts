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
import type { NormalizedDoc, YuqueWebClient } from "../src/yuque-client.js";

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
