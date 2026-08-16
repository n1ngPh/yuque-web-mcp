import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import { ChangeStore } from "../src/change-store.js";
import { CryptoBox } from "../src/crypto.js";
import { AppDatabase } from "../src/db.js";
import type {
  PreparedBookDeletion,
  PreparedObjectDeletion,
  YuqueWebClient,
} from "../src/yuque-client.js";

const BOOK_URL = "https://www.yuque.com/alice/yuque-web-mcp-e2e";
const DOC_URL = `${BOOK_URL}/yuque-web-mcp-delete-doc`;
const SHEET_URL = `${BOOK_URL}/yuque-web-mcp-delete-sheet`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Doc and Sheet whole-object deletion", () => {
  it("fails closed when object deletion is disabled", async () => {
    const fixture = await createFixture({ allowObjectDeletion: false });
    await expect(
      fixture
        .changes(deletionClient(docPrepared()))
        .previewDeleteDoc("employee.a", { docUrl: DOC_URL }),
    ).rejects.toThrow("Whole-object deletion is disabled");
    fixture.db.close();
  });

  it("keeps strict mode Preview-only without taking a snapshot or writing", async () => {
    const fixture = await createFixture({ writeConsistencyMode: "strict" });
    let writes = 0;
    const changes = fixture.changes(
      deletionClient(docPrepared(), () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewDeleteDoc("employee.a", {
      docUrl: DOC_URL,
    });
    expect(preview.display_path).toBe(docPrepared().displayPath);
    expect(preview.requires_deletion_confirmation).toBe(true);
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
        preview.display_path,
      ),
    ).rejects.toThrow("strict write consistency mode");
    expect(writes).toBe(0);
    expect(fixture.db.listSnapshots()).toHaveLength(0);
    fixture.db.close();
  });

  it("requires deletion consent and exact full path, snapshots, and trashes one Doc", async () => {
    const fixture = await createFixture();
    let writes = 0;
    const prepared = docPrepared();
    const changes = fixture.changes(
      deletionClient(prepared, () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewDeleteDoc("employee.a", {
      docUrl: DOC_URL,
    });

    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
      ),
    ).rejects.toThrow("confirm_deletions=true");
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
        "wrong path",
      ),
    ).rejects.toThrow("confirmation_text must exactly match");
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
        prepared.displayPath,
      ),
    ).resolves.toMatchObject({
      status: "trashed",
      resource_type: "Doc",
      deleted_path: prepared.displayPath,
      recovery_semantics: "recreate_copy_only",
      snapshot_retention_days: 7,
    });
    expect(writes).toBe(1);
    expect(fixture.db.listSnapshots()).toHaveLength(1);
    expect(fixture.db.listSnapshots()[0]?.encrypted_payload).not.toContain(
      "private document body",
    );
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "succeeded",
    );
    fixture.db.close();
  });

  it("creates a typed Sheet snapshot before the same catalog transaction", async () => {
    const fixture = await createFixture();
    let writes = 0;
    const prepared = sheetPrepared();
    const changes = fixture.changes(
      deletionClient(prepared, () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewDeleteSheet("employee.a", {
      docUrl: SHEET_URL,
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
        prepared.displayPath,
      ),
    ).resolves.toMatchObject({
      status: "trashed",
      resource_type: "Sheet",
      object_url: SHEET_URL,
    });
    expect(writes).toBe(1);
    expect(fixture.db.listSnapshots()[0]?.resource_type).toBe("sheet");
    fixture.db.close();
  });

  it("marks a changed target as conflict and sends no deletion", async () => {
    const fixture = await createFixture();
    const baseline = docPrepared();
    let reads = 0;
    let writes = 0;
    const changes = fixture.changes(
      deletionClient(
        () => ({
          ...baseline,
          baseFingerprint: reads++ === 0 ? "doc-base" : "doc-changed",
        }),
        () => {
          writes += 1;
        },
      ),
    );
    const preview = await changes.previewDeleteDoc("employee.a", {
      docUrl: DOC_URL,
    });
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
        baseline.displayPath,
      ),
    ).rejects.toThrow("target object changed after Preview");
    expect(writes).toBe(0);
    expect(fixture.db.listSnapshots()).toHaveLength(0);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "conflict",
    );
    fixture.db.close();
  });

  it("irreversibly deletes one explicitly reviewed non-empty knowledge base without claiming a snapshot", async () => {
    const fixture = await createFixture();
    let writes = 0;
    const prepared = bookDeletePrepared();
    const changes = fixture.changes(
      bookDeletionClient(prepared, () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewDeleteBook("employee.a", {
      bookUrl: BOOK_URL,
      allowNonempty: true,
    });
    expect(preview.diff).toContain("catalog_nodes: 2");
    expect(preview.diff).toContain("yuque-web-mcp-delete-doc");
    expect(preview.requires_deletion_confirmation).toBe(true);
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
        true,
        prepared.displayPath,
      ),
    ).resolves.toMatchObject({
      status: "deleted",
      deletion_effect: "irreversible_book_removal",
      deleted_catalog_nodes: 2,
      snapshot_created: false,
      recovery_semantics: "irreversible_no_complete_local_snapshot",
    });
    expect(writes).toBe(1);
    expect(fixture.db.listSnapshots()).toHaveLength(0);
    fixture.db.close();
  });
});

async function createFixture(overrides: Partial<AppConfig> = {}): Promise<{
  db: AppDatabase;
  changes: (client: YuqueWebClient) => ChangeStore;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "yuque-object-delete-test-"));
  temporaryDirectories.push(dataDir);
  const config: AppConfig = {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: "https://www.yuque.com",
    personalYuqueHost: "https://www.yuque.com",
    organization: "",
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
    allowObjectDeletion: true,
    allowPermissionChanges: false,
    writeBookAllowlist: [BOOK_URL],
    ...overrides,
  };
  const db = new AppDatabase(config.databasePath);
  const crypto = new CryptoBox(config.encryptionKey);
  return {
    db,
    changes: (client) => new ChangeStore(config, db, crypto, client),
  };
}

function deletionClient(
  prepared: PreparedObjectDeletion | (() => PreparedObjectDeletion),
  onDelete: () => void = () => undefined,
): YuqueWebClient {
  const read = () => (typeof prepared === "function" ? prepared() : prepared);
  return {
    prepareObjectDeletion: async () => read(),
    deleteObject: async () => {
      onDelete();
      const current = read();
      return {
        status: "trashed",
        resource_type: current.resourceType,
        deleted_path: current.displayPath,
        object_url: current.targetUrl,
        doc_id: String(current.node.docId),
        catalog_absent: true,
        direct_read_rejected: true,
        reconciled_after_unknown_response: false,
      };
    },
  } as unknown as YuqueWebClient;
}

function bookDeletionClient(
  prepared: PreparedBookDeletion,
  onDelete: () => void = () => undefined,
): YuqueWebClient {
  return {
    prepareBookDeletion: async () => prepared,
    deleteBook: async () => {
      onDelete();
      return {
        status: "deleted",
        deletion_effect: "irreversible_book_removal",
        deleted_path: prepared.displayPath,
        book_url: prepared.book.url,
        book_id: String(prepared.book.id),
        deleted_catalog_nodes: prepared.catalog.length,
        list_absent: true,
        direct_read_rejected: true,
        reconciled_after_unknown_response: false,
      };
    },
  } as unknown as YuqueWebClient;
}

function bookDeletePrepared(): PreparedBookDeletion {
  return {
    book: book(),
    catalog: [docPrepared().node, sheetPrepared().node],
    displayPath: "个人：Alice / yuque-web-mcp-e2e",
    baseFingerprint: "book-delete-base",
    allowNonempty: true,
  };
}

function docPrepared(): PreparedObjectDeletion {
  const displayPath =
    "个人：Alice / yuque-web-mcp-e2e / yuque-web-mcp-delete-doc";
  return {
    resourceType: "Doc",
    book: book(),
    node: {
      type: "DOC",
      title: "yuque-web-mcp-delete-doc",
      uuid: "doc-node",
      level: 0,
      order: 0,
      visible: true,
      path: ["yuque-web-mcp-delete-doc"],
      fullPath: [
        "个人：Alice",
        "yuque-web-mcp-e2e",
        "yuque-web-mcp-delete-doc",
      ],
      displayPath,
      docId: 77,
      docSlug: "yuque-web-mcp-delete-doc",
      docUrl: DOC_URL,
    },
    targetUrl: DOC_URL,
    displayPath,
    baseFingerprint: "doc-base",
    version: 3,
    doc: {
      id: "77",
      slug: "yuque-web-mcp-delete-doc",
      title: "yuque-web-mcp-delete-doc",
      markdown: "private document body",
      lakeContent: "<!doctype lake><p>private document body</p>",
      bookId: 44,
      bookUrl: BOOK_URL,
      format: "lake",
      version: 3,
      url: DOC_URL,
      location: location("yuque-web-mcp-delete-doc", displayPath),
      raw: {},
      fingerprint: "doc-content",
    },
  };
}

function sheetPrepared(): PreparedObjectDeletion {
  const displayPath =
    "个人：Alice / yuque-web-mcp-e2e / yuque-web-mcp-delete-sheet";
  return {
    resourceType: "Sheet",
    book: book(),
    node: {
      type: "DOC",
      title: "yuque-web-mcp-delete-sheet",
      uuid: "sheet-node",
      level: 0,
      order: 1,
      visible: true,
      path: ["yuque-web-mcp-delete-sheet"],
      fullPath: [
        "个人：Alice",
        "yuque-web-mcp-e2e",
        "yuque-web-mcp-delete-sheet",
      ],
      displayPath,
      docId: 88,
      docSlug: "yuque-web-mcp-delete-sheet",
      docUrl: SHEET_URL,
    },
    targetUrl: SHEET_URL,
    displayPath,
    baseFingerprint: "sheet-base",
    version: 4,
    sheet: {
      id: "88",
      slug: "yuque-web-mcp-delete-sheet",
      title: "yuque-web-mcp-delete-sheet",
      format: "lakesheet",
      bookId: 44,
      bookUrl: BOOK_URL,
      version: 4,
      url: SHEET_URL,
      location: location("yuque-web-mcp-delete-sheet", displayPath),
      workbook: {
        id: "88",
        title: "yuque-web-mcp-delete-sheet",
        worksheets: [
          {
            id: "ws-1",
            name: "Sheet1",
            cells: { A1: { value: "private cell" } },
          },
        ],
        fingerprint: "sheet-content",
      },
      bodyDraft: "encrypted-sheet-draft-fixture",
      unsupportedFeatures: [],
      chartSummaries: [],
    },
  };
}

function location(title: string, displayPath: string) {
  return {
    path: [title],
    fullPath: ["个人：Alice", "yuque-web-mcp-e2e", title],
    displayPath,
    level: 0,
    order: 0,
  };
}

function book(): PreparedObjectDeletion["book"] {
  return {
    id: 44,
    name: "yuque-web-mcp-e2e",
    description: "sandbox",
    slug: "yuque-web-mcp-e2e",
    groupLogin: "alice",
    url: BOOK_URL,
    itemsCount: 2,
    scopeId: "personal",
    scopeType: "personal",
    scopeName: "Alice",
    scopeLabel: "个人：Alice",
    host: "https://www.yuque.com",
    ownerType: "User",
    ownerLogin: "alice",
    accessType: "owner",
    role: "owner",
    private: true,
  };
}
