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
  PreparedCommentChange,
  YuqueWebClient,
} from "../src/yuque-client.js";

const BOOK_URL = "https://www.yuque.com/alice/yuque-web-mcp-e2e";
const DOC_URL = `${BOOK_URL}/yuque-web-mcp-comment-doc`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("comment Preview and Confirm", () => {
  it("keeps strict mode Preview-only and sends no comment write", async () => {
    const fixture = await createFixture({ writeConsistencyMode: "strict" });
    let writes = 0;
    const changes = fixture.changes(
      commentClient(createPrepared(), () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewCommentChange("employee.a", {
      docUrl: DOC_URL,
      action: "create",
      body: "new comment",
    });

    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
      ),
    ).rejects.toThrow("strict write consistency mode");
    expect(writes).toBe(0);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "previewed",
    );
    fixture.db.close();
  });

  it("executes one best-effort comment creation and consumes the token", async () => {
    const fixture = await createFixture();
    let writes = 0;
    const changes = fixture.changes(
      commentClient(createPrepared(), () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewCommentChange("employee.a", {
      docUrl: DOC_URL,
      action: "create",
      body: "new comment",
    });

    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
      ),
    ).resolves.toMatchObject({ status: "created" });
    expect(writes).toBe(1);
    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
      ),
    ).rejects.toThrow("succeeded");
    expect(writes).toBe(1);
    fixture.db.close();
  });

  it("requires explicit deletion confirmation but not object-deletion enablement", async () => {
    const fixture = await createFixture({ allowObjectDeletion: false });
    let writes = 0;
    const changes = fixture.changes(
      commentClient(deletePrepared(), () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewCommentChange("employee.a", {
      docUrl: DOC_URL,
      action: "delete",
      commentId: "91",
    });
    expect(preview.requires_deletion_confirmation).toBe(true);
    expect(preview.stats.removed_lines).toBeGreaterThan(0);

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
      ),
    ).resolves.toMatchObject({ status: "deleted" });
    expect(writes).toBe(1);
    fixture.db.close();
  });
});

async function createFixture(overrides: Partial<AppConfig> = {}): Promise<{
  db: AppDatabase;
  changes: (client: YuqueWebClient) => ChangeStore;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "yuque-comment-store-test-"));
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
    allowObjectDeletion: false,
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

function commentClient(
  prepared: PreparedCommentChange,
  onWrite: () => void = () => undefined,
): YuqueWebClient {
  return {
    prepareCommentChange: async () => prepared,
    changeComment: async () => {
      onWrite();
      return {
        status: prepared.action === "delete" ? "deleted" : "created",
        comment_id: prepared.commentId ?? "92",
      };
    },
  } as unknown as YuqueWebClient;
}

function createPrepared(): PreparedCommentChange {
  return {
    doc: doc(),
    action: "create",
    body: "new comment",
    bodyAsl: "<!doctype lake><p>new comment</p>",
    bodyHtml: "<!doctype html><p>new comment</p>",
    baselineFingerprint: "comments-base",
    displayPath:
      "个人：Alice / yuque-web-mcp-e2e / comment doc / 评论 / 新评论",
  };
}

function deletePrepared(): PreparedCommentChange {
  return {
    doc: doc(),
    action: "delete",
    commentId: "91",
    current: {
      id: "91",
      authorLogin: "alice",
      body: "remove this comment",
      bodyAsl: "<!doctype lake><p>remove this comment</p>",
      format: "lake",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      fingerprint: "comment-91",
    },
    baselineFingerprint: "comments-delete-base",
    displayPath: "个人：Alice / yuque-web-mcp-e2e / comment doc / 评论 #91",
  };
}

function doc(): PreparedCommentChange["doc"] {
  return {
    id: "77",
    slug: "yuque-web-mcp-comment-doc",
    title: "comment doc",
    markdown: "body",
    lakeContent: "<!doctype lake><p>body</p>",
    bookId: 44,
    bookUrl: BOOK_URL,
    format: "lake",
    version: 1,
    url: DOC_URL,
    location: {
      path: ["comment doc"],
      fullPath: ["个人：Alice", "yuque-web-mcp-e2e", "comment doc"],
      displayPath: "个人：Alice / yuque-web-mcp-e2e / comment doc",
      level: 0,
      order: 0,
    },
    raw: {},
    fingerprint: "doc-base",
  };
}
