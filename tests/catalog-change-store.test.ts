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
  CatalogChangeInput,
  PreparedCatalogChange,
  YuqueWebClient,
} from "../src/yuque-client.js";

const BOOK_URL = "https://www.yuque.com/alice/yuque-web-mcp-e2e";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("catalog Preview and Confirm", () => {
  it("keeps a strict-mode Confirm previewed and sends no write", async () => {
    const fixture = await createFixture({ writeConsistencyMode: "strict" });
    let writes = 0;
    const changes = fixture.changes(
      catalogClient(createPrepared(), () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewCatalogChange("employee.a", {
      bookUrl: BOOK_URL,
      action: "create",
      title: "yuque-web-mcp-child",
      expectedParentPath: "个人：Alice / yuque-web-mcp-e2e",
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

  it("executes one best-effort directory change and consumes its token", async () => {
    const fixture = await createFixture();
    let writes = 0;
    const changes = fixture.changes(
      catalogClient(createPrepared(), () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewCatalogChange("employee.a", {
      bookUrl: BOOK_URL,
      action: "create",
      title: "yuque-web-mcp-child",
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

  it("classifies a changed catalog baseline as conflict before writing", async () => {
    const fixture = await createFixture();
    let reads = 0;
    let writes = 0;
    const changes = fixture.changes(
      catalogClient(
        () => createPrepared(reads++ === 0 ? "base-a" : "base-b"),
        () => {
          writes += 1;
        },
      ),
    );
    const preview = await changes.previewCatalogChange("employee.a", {
      bookUrl: BOOK_URL,
      action: "create",
      title: "yuque-web-mcp-child",
    });

    await expect(
      changes.confirmChange(
        "employee.a",
        preview.change_token,
        preview.diff_digest,
      ),
    ).rejects.toThrow("Catalog changed after Preview");
    expect(writes).toBe(0);
    expect(fixture.db.getPendingChange(preview.change_token)?.state).toBe(
      "conflict",
    );
    fixture.db.close();
  });

  it("requires deletion enablement, deletion consent and the exact path", async () => {
    const disabled = await createFixture({ allowObjectDeletion: false });
    await expect(
      disabled
        .changes(catalogClient(deletePrepared()))
        .previewCatalogChange("employee.a", {
          bookUrl: BOOK_URL,
          action: "delete",
          nodeUuid: "empty-node",
        }),
    ).rejects.toThrow("Directory deletion is disabled");
    disabled.db.close();

    const fixture = await createFixture({ allowObjectDeletion: true });
    let writes = 0;
    const prepared = deletePrepared();
    const changes = fixture.changes(
      catalogClient(prepared, () => {
        writes += 1;
      }),
    );
    const preview = await changes.previewCatalogChange("employee.a", {
      bookUrl: BOOK_URL,
      action: "delete",
      nodeUuid: "empty-node",
    });
    expect(preview.requires_deletion_confirmation).toBe(true);

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
    ).resolves.toMatchObject({ status: "deleted" });
    expect(writes).toBe(1);
    fixture.db.close();
  });
});

async function createFixture(overrides: Partial<AppConfig> = {}): Promise<{
  config: AppConfig;
  db: AppDatabase;
  changes: (client: YuqueWebClient) => ChangeStore;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "yuque-catalog-store-test-"));
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
    writeBookAllowlist: [BOOK_URL],
    ...overrides,
  };
  const db = new AppDatabase(config.databasePath);
  const crypto = new CryptoBox(config.encryptionKey);
  return {
    config,
    db,
    changes: (client) => new ChangeStore(config, db, crypto, client),
  };
}

function catalogClient(
  prepared:
    PreparedCatalogChange | (() => PreparedCatalogChange) = createPrepared(),
  onWrite: () => void = () => undefined,
): YuqueWebClient {
  const read = () => (typeof prepared === "function" ? prepared() : prepared);
  return {
    prepareCatalogChange: async () => read(),
    changeCatalog: async (_owner: string, input: CatalogChangeInput) => {
      onWrite();
      return {
        status: input.action === "delete" ? "deleted" : "created",
        display_path: read().targetDisplayPath,
      };
    },
  } as unknown as YuqueWebClient;
}

function createPrepared(
  baselineFingerprint = "catalog-base",
): PreparedCatalogChange {
  return {
    book: book(),
    action: "create",
    title: "yuque-web-mcp-child",
    baselineFingerprint,
    baselineNodeUuids: ["existing"],
    displayPath: "个人：Alice / yuque-web-mcp-e2e",
    targetDisplayPath: "个人：Alice / yuque-web-mcp-e2e / yuque-web-mcp-child",
  };
}

function deletePrepared(): PreparedCatalogChange {
  const displayPath = "个人：Alice / yuque-web-mcp-e2e / yuque-web-mcp-empty";
  return {
    book: book(),
    action: "delete",
    node: {
      type: "TITLE",
      title: "yuque-web-mcp-empty",
      uuid: "empty-node",
      level: 0,
      order: 0,
      visible: true,
      path: ["yuque-web-mcp-empty"],
      fullPath: ["个人：Alice", "yuque-web-mcp-e2e", "yuque-web-mcp-empty"],
      displayPath,
    },
    baselineFingerprint: "catalog-delete-base",
    baselineNodeUuids: ["empty-node"],
    displayPath,
    targetDisplayPath: displayPath,
  };
}

function book(): PreparedCatalogChange["book"] {
  return {
    id: 44,
    name: "yuque-web-mcp-e2e",
    description: "sandbox",
    slug: "yuque-web-mcp-e2e",
    groupLogin: "alice",
    url: BOOK_URL,
    itemsCount: 1,
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
