import { createTwoFilesPatch } from "diff";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { fingerprint, type CryptoBox } from "./crypto.js";
import type { AppDatabase, PendingChangeRow } from "./db.js";
import {
  lakeTargetFingerprint,
  planLakePatch,
  proprietaryBlockTypes,
  type LakePatchMode,
} from "./lake-document.js";
import {
  applyLakeSheetChartOperations,
  decodeLakeSheetDraft,
  encodeLakeSheetDraft,
  type SheetChartDiffEntry,
} from "./sheet-codec.js";
import { isSheetChartOperationName } from "./sheet-chart.js";
import {
  applySheetOperations,
  sheetOperationTargetFingerprint,
  sheetSemanticFingerprint,
  validateSheetOperations,
  type NormalizedWorkbook,
  type SheetDiffEntry,
} from "./sheet-model.js";
import type {
  ChangeState,
  PendingChangePayload,
  PendingChangeKind,
} from "./types.js";
import type {
  NormalizedDoc,
  NormalizedSheetDocument,
  YuqueWebClient,
} from "./yuque-client.js";

const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PreviewResult {
  change_token: string;
  expires_at: string;
  target_url: string;
  display_path: string;
  base_fingerprint?: string;
  base_version?: number;
  diff: string;
  diff_digest: string;
  stats: {
    added_lines: number;
    removed_lines: number;
    has_deletions: boolean;
  };
  requires_deletion_confirmation: boolean;
  warnings: string[];
}

interface SnapshotPayload {
  schemaVersion: 3;
  resourceType: "doc" | "sheet";
  targetUrl: string;
  displayPath: string;
  title: string;
  lakeContent?: string;
  plainText?: string;
  sheetDraft?: string;
  fingerprint: string;
  version: number;
  capturedAt: string;
}

interface ExecutionResult {
  state: "succeeded" | "conflict" | "partial";
  result: Record<string, unknown>;
}

export class ChangeStore {
  private readonly targetLocks = new Map<string, Promise<void>>();
  private acceptingConfirms = true;
  private activeConfirms = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly crypto: CryptoBox,
    private readonly client: YuqueWebClient,
  ) {
    this.db.purgeExpiredSnapshots();
    for (const row of this.db.markInterruptedChangesUnknown()) {
      this.audit(row, "unknown", "process_interrupted");
    }
  }

  async previewCreateBook(
    ownerId: string,
    input: { name: string; description?: string },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const name = input.name.trim();
    const description = input.description?.trim() || "";
    if (!name) throw new Error("Knowledge-base name is required");
    if (description.length > 2_000) {
      throw new Error(
        "Knowledge-base description must not exceed 2000 characters",
      );
    }
    const target = await this.client.preparePersonalBookCreate(ownerId, name);
    const proposal = [
      `name: ${name}`,
      `visibility: private`,
      `owner: ${target.ownerLogin}`,
      `description: ${description || "(empty)"}`,
    ].join("\n");
    const diff = createTwoFilesPatch(
      "/dev/null",
      name,
      "",
      proposal,
      "",
      "proposed",
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "create_book",
        targetUrl: target.dashboardUrl,
        displayPath: target.displayPath,
        bookName: name,
        bookDescription: description,
        bookVisibility: "private",
        ownerLogin: target.ownerLogin,
        resourceType: "KnowledgeBase",
      },
      diff,
      [
        "Yuque generates the final knowledge-base slug during Confirm; the final URL is returned only after write read-back succeeds.",
        "Only a private personal knowledge base is created; no organization scope or sidebar quick-link mutation is requested.",
      ],
    );
  }

  async previewUpdateBook(
    ownerId: string,
    input: { bookUrl: string; name?: string; description?: string },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const prepared = await this.client.preparePersonalBookUpdate(
      ownerId,
      input,
    );
    const before = [
      `name: ${prepared.book.name}`,
      `description: ${prepared.book.description || "(empty)"}`,
    ].join("\n");
    const after = [
      `name: ${prepared.name}`,
      `description: ${prepared.description || "(empty)"}`,
    ].join("\n");
    const changedFields =
      Number(prepared.name !== prepared.book.name) +
      Number(prepared.description !== prepared.book.description);
    const diff = createTwoFilesPatch(
      prepared.book.name,
      prepared.name,
      before,
      after,
      prepared.book.updatedAt || "baseline",
      "proposed",
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "update_book",
        targetUrl: prepared.book.url,
        displayPath: prepared.displayPath,
        bookId: prepared.book.id,
        bookName: prepared.name,
        bookDescription: prepared.description,
        bookVisibility: "private",
        ownerLogin: prepared.book.ownerLogin,
        baseFingerprint: prepared.baselineFingerprint,
        resourceType: "KnowledgeBase",
      },
      diff,
      [
        "Knowledge-base updates have no verified atomic CAS; strict mode remains Preview-only and best_effort must be enabled with an exact knowledge-base allowlist.",
        "Confirm sends only the changed name/description fields and intentionally omits cover upload and unrelated settings.",
      ],
      {
        added_lines: changedFields,
        removed_lines: changedFields,
        has_deletions: false,
      },
    );
  }

  async previewChangeBookCollaborator(
    ownerId: string,
    input: {
      bookUrl: string;
      action: "invite" | "change_role" | "remove";
      collaboratorLogin: string;
      role?: "reader" | "editor";
    },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    if (this.config.allowPermissionChanges !== true) {
      throw new Error(
        "Permission changes are disabled by configuration; set ALLOW_PERMISSION_CHANGES=true only for an exact write allowlist",
      );
    }
    const prepared = await this.client.prepareBookCollaboratorChange(
      ownerId,
      input,
    );
    const before = prepared.current
      ? `collaborator: ${prepared.current.login}\nrole: ${prepared.current.role}`
      : "(no collaborator)";
    const after =
      prepared.action === "remove"
        ? "(collaborator removed)"
        : `collaborator: ${prepared.collaboratorLogin}\nrole: ${prepared.role}`;
    const diff = createTwoFilesPatch(
      `${prepared.displayPath} / collaborators`,
      `${prepared.displayPath} / collaborators`,
      before,
      after,
      "baseline",
      "proposed",
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "change_book_collaborator",
        targetUrl: prepared.book.url,
        displayPath: prepared.displayPath,
        bookId: prepared.book.id,
        ownerLogin: prepared.book.ownerLogin,
        collaboratorId: prepared.current?.collaborationId,
        collaboratorLogin: prepared.collaboratorLogin,
        collaboratorRole: prepared.role,
        collaboratorAction: prepared.action,
        baseFingerprint: prepared.baselineFingerprint,
        resourceType: "KnowledgeBase",
      },
      diff,
      [
        "Permission changes have no atomic CAS; strict mode remains Preview-only and best_effort requires an exact knowledge-base allowlist.",
        prepared.action === "invite"
          ? "The recipient must explicitly join the invitation before shared access appears."
          : prepared.action === "remove"
            ? `Confirm removes ${prepared.collaboratorLogin} with current role ${prepared.current?.role}; the knowledge-base content is not deleted.`
            : `Confirm changes ${prepared.collaboratorLogin} from ${prepared.current?.role} to ${prepared.role}.`,
      ],
      {
        added_lines: prepared.action === "remove" ? 0 : 2,
        removed_lines: prepared.current ? 2 : 0,
        has_deletions: false,
      },
    );
  }

  async previewCatalogChange(
    ownerId: string,
    input: {
      bookUrl: string;
      action: "create" | "rename" | "move" | "delete";
      nodeUuid?: string;
      targetUuid?: string;
      position?: "into" | "after";
      title?: string;
      parentUuid?: string;
      expectedParentPath?: string;
    },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    if (input.action === "delete" && this.config.allowObjectDeletion !== true) {
      throw new Error(
        "Directory deletion is disabled by configuration; set ALLOW_OBJECT_DELETION=true only with an exact write allowlist",
      );
    }
    const prepared = await this.client.prepareCatalogChange(ownerId, input);
    const before =
      prepared.action === "create"
        ? "(directory does not exist)"
        : `path: ${prepared.displayPath}`;
    const after =
      prepared.action === "delete"
        ? "(empty directory deleted)"
        : `path: ${prepared.targetDisplayPath}`;
    const diff = createTwoFilesPatch(
      prepared.displayPath,
      prepared.targetDisplayPath,
      before,
      after,
      "baseline",
      "proposed",
    );
    const isDelete = prepared.action === "delete";
    const isDirectory =
      prepared.action === "create" || prepared.node?.type === "TITLE";
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "change_catalog",
        bookUrl: prepared.book.url,
        targetUrl: prepared.book.url,
        displayPath: prepared.targetDisplayPath,
        baseFingerprint: prepared.baselineFingerprint,
        catalogAction: prepared.action,
        catalogNodeUuid: prepared.node?.uuid,
        catalogTargetUuid: prepared.target?.uuid,
        catalogPosition: prepared.position,
        catalogTitle: prepared.title,
        parentUuid: prepared.parentUuid,
        catalogExpectedParentPath: prepared.expectedParentPath,
        resourceType: isDirectory ? "CatalogDirectory" : "CatalogDocument",
        ...(isDelete ? { confirmationText: prepared.displayPath } : {}),
      },
      diff,
      [
        "Catalog writes have no atomic CAS; strict mode remains Preview-only and best_effort requires an exact personal knowledge-base allowlist.",
        isDelete
          ? "Only a verified empty directory is deleted. Non-empty directory deletion and document deletion through this tool are blocked."
          : isDirectory
            ? "Confirm re-reads the complete catalog fingerprint before sending one verified request and then verifies the final directory path."
            : "Doc and Sheet directory moves use the verified catalog transaction. Confirm re-reads the complete catalog fingerprint, sends one request, verifies the unchanged document identity and returns the final full path.",
      ],
      {
        added_lines: isDelete ? 0 : 1,
        removed_lines: isDelete ? 1 : 0,
        has_deletions: isDelete,
      },
    );
  }

  async previewCommentChange(
    ownerId: string,
    input: {
      docUrl: string;
      action: "create" | "update" | "delete";
      commentId?: string;
      body?: string;
    },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const prepared = await this.client.prepareCommentChange(ownerId, input);
    const before = prepared.current?.body ?? "";
    const after = prepared.action === "delete" ? "" : (prepared.body ?? "");
    const diff = createTwoFilesPatch(
      prepared.action === "create" ? "/dev/null" : prepared.displayPath,
      prepared.action === "delete" ? "/dev/null" : prepared.displayPath,
      before,
      after,
      prepared.current?.updatedAt ?? "",
      "proposed",
    );
    const isDelete = prepared.action === "delete";
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "change_comment",
        docUrl: prepared.doc.url ?? input.docUrl,
        targetUrl: prepared.doc.url ?? input.docUrl,
        bookUrl: prepared.doc.bookUrl,
        displayPath: prepared.displayPath,
        baseFingerprint: prepared.baselineFingerprint,
        commentAction: prepared.action,
        commentId: prepared.commentId,
        commentText: isDelete ? prepared.current?.body : prepared.body,
        commentBodyAsl: isDelete ? prepared.current?.bodyAsl : prepared.bodyAsl,
        commentBodyHtml: prepared.bodyHtml,
        resourceType: "Comment",
      },
      diff,
      [
        "Comment writes have no atomic CAS; strict mode remains Preview-only and best_effort requires the exact personal knowledge-base allowlist.",
        isDelete
          ? "This removes one own comment, not the containing Doc. The encrypted pending change retains the removed Lake body for audit/recovery assistance."
          : "Confirm re-reads the complete comment collection fingerprint, sends one request and verifies the exact comment ID and Lake body.",
      ],
      {
        added_lines: after ? normalizeText(after).split("\n").length : 0,
        removed_lines: before ? normalizeText(before).split("\n").length : 0,
        has_deletions: isDelete,
      },
    );
  }

  async previewDeleteDoc(
    ownerId: string,
    input: { docUrl: string },
  ): Promise<PreviewResult> {
    return this.previewDeleteObject(ownerId, input.docUrl, "Doc");
  }

  async previewDeleteSheet(
    ownerId: string,
    input: { docUrl: string },
  ): Promise<PreviewResult> {
    return this.previewDeleteObject(ownerId, input.docUrl, "Sheet");
  }

  async previewDeleteBook(
    ownerId: string,
    input: { bookUrl: string; allowNonempty: boolean },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    if (this.config.allowObjectDeletion !== true) {
      throw new Error(
        "Knowledge-base deletion is disabled by configuration; set ALLOW_OBJECT_DELETION=true only with an exact write allowlist",
      );
    }
    const prepared = await this.client.prepareBookDeletion(ownerId, input);
    const catalogLines = prepared.catalog.map(
      (node) => `- ${node.displayPath} [${node.type}]`,
    );
    const before = [
      `resource_type: KnowledgeBase`,
      `name: ${prepared.book.name}`,
      `full_path: ${prepared.displayPath}`,
      `url: ${prepared.book.url}`,
      `catalog_nodes: ${String(prepared.catalog.length)}`,
      ...(catalogLines.length > 0 ? ["catalog:", ...catalogLines] : []),
    ].join("\n");
    const diff = createTwoFilesPatch(
      prepared.displayPath,
      "/dev/null",
      before,
      "",
      prepared.book.updatedAt ?? "baseline",
      "irreversibly-deleted",
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "delete_book",
        bookUrl: prepared.book.url,
        targetUrl: prepared.book.url,
        displayPath: prepared.displayPath,
        bookId: prepared.book.id,
        bookName: prepared.book.name,
        ownerLogin: prepared.book.ownerLogin,
        baseFingerprint: prepared.baseFingerprint,
        resourceType: "KnowledgeBase",
        confirmationText: prepared.displayPath,
        allowNonempty: prepared.allowNonempty,
      },
      diff,
      [
        "Knowledge-base deletion is irreversible in the verified Yuque UI and removes every object in the catalog.",
        "The local service cannot create a complete recoverable snapshot of an entire knowledge base; no original URL, ID, permissions or version history can be restored after Confirm.",
        "Confirm requires allow_nonempty=true for a non-empty catalog, confirm_deletions=true, the exact full path, best_effort mode, ALLOW_OBJECT_DELETION=true and the exact personal knowledge-base allowlist.",
      ],
      {
        added_lines: 0,
        removed_lines: before.split("\n").length,
        has_deletions: true,
      },
    );
  }

  private async previewDeleteObject(
    ownerId: string,
    docUrl: string,
    resourceType: "Doc" | "Sheet",
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    if (this.config.allowObjectDeletion !== true) {
      throw new Error(
        "Whole-object deletion is disabled by configuration; set ALLOW_OBJECT_DELETION=true only with an exact write allowlist",
      );
    }
    const prepared = await this.client.prepareObjectDeletion(ownerId, {
      docUrl,
      resourceType,
    });
    const contentSummary =
      resourceType === "Doc"
        ? [
            `content_lines: ${String(
              Math.max(1, (prepared.doc?.markdown ?? "").split("\n").length),
            )}`,
            `proprietary_blocks: ${String(
              proprietaryBlockTypes(prepared.doc?.lakeContent ?? "").length,
            )}`,
          ]
        : [
            `worksheets: ${String(prepared.sheet?.workbook.worksheets.length ?? 0)}`,
            `populated_cells: ${String(
              prepared.sheet?.workbook.worksheets.reduce(
                (total, worksheet) =>
                  total + Object.keys(worksheet.cells).length,
                0,
              ) ?? 0,
            )}`,
          ];
    const before = [
      `resource_type: ${resourceType}`,
      `title: ${
        resourceType === "Doc" ? prepared.doc?.title : prepared.sheet?.title
      }`,
      `full_path: ${prepared.displayPath}`,
      `version: ${String(prepared.version)}`,
      ...contentSummary,
    ].join("\n");
    const diff = createTwoFilesPatch(
      prepared.displayPath,
      "/dev/null",
      before,
      "",
      `version-${String(prepared.version)}`,
      "trashed",
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: resourceType === "Doc" ? "delete_doc" : "delete_sheet",
        bookUrl: prepared.book.url,
        docUrl: prepared.targetUrl,
        targetUrl: prepared.targetUrl,
        displayPath: prepared.displayPath,
        title:
          resourceType === "Doc" ? prepared.doc?.title : prepared.sheet?.title,
        baseFingerprint: prepared.baseFingerprint,
        baseVersion: prepared.version,
        catalogNodeUuid: prepared.node.uuid,
        resourceType,
        confirmationText: prepared.displayPath,
      },
      diff,
      [
        "Confirm moves the whole object out of the active catalog (trashed); it does not claim a permanent hard delete.",
        "Confirm saves a seven-day AES-256-GCM local snapshot first. Recreating from that snapshot produces a new object and cannot restore the original URL, ID or version history.",
        "Whole-object deletion has no atomic CAS; strict mode remains Preview-only and best_effort requires ALLOW_OBJECT_DELETION=true plus the exact personal knowledge-base allowlist.",
      ],
      {
        added_lines: 0,
        removed_lines: before.split("\n").length,
        has_deletions: true,
      },
    );
  }

  async previewCreate(
    ownerId: string,
    input: {
      bookUrl: string;
      parentUuid?: string;
      expectedParentPath?: string;
      title: string;
      markdown: string;
    },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    assertMarkdownSafe(input.markdown);
    assertNonEmptyDocument(input.markdown);
    const title = input.title.trim();
    if (!title) throw new Error("Document title is required");
    const slug = createYuqueSlug();
    const target = await this.client.prepareCreateTarget(ownerId, {
      bookUrl: input.bookUrl,
      title,
      slug,
      parentUuid: input.parentUuid,
      expectedParentPath: input.expectedParentPath,
    });
    const convertedLake = await this.client.convertMarkdownToLake(
      ownerId,
      input.markdown,
      input.bookUrl,
    );
    const diff = createTwoFilesPatch(
      "/dev/null",
      title,
      "",
      normalizeText(input.markdown),
      "",
      "proposed",
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "create_doc",
        bookUrl: input.bookUrl,
        parentUuid: target.parentUuid,
        expectedParentPath: target.parentPath,
        title,
        slug,
        markdown: normalizeText(input.markdown),
        convertedLake,
        targetUrl: target.targetUrl,
        displayPath: target.displayPath,
      },
      diff,
      [
        "Creation uses one non-idempotent POST, exact slug/path reconciliation and write read-back; unknown results must not be retried.",
      ],
    );
  }

  async previewUpdate(
    ownerId: string,
    input: {
      docUrl: string;
      newMarkdown?: string;
      mode?: "append" | "replace_section" | "delete_section" | "rename";
      sectionHeading?: string;
      newTitle?: string;
    },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const current = await this.client.getDoc(ownerId, input.docUrl);
    const mode = input.mode ?? "append";
    if (
      !(
        ["append", "replace_section", "delete_section", "rename"] as const
      ).includes(mode)
    ) {
      throw new Error(
        "mode must be append, replace_section, delete_section or rename",
      );
    }
    const nextTitle = input.newTitle?.trim() || current.title;
    if (mode === "rename" && nextTitle === current.title) {
      throw new Error("rename requires a different new_title");
    }
    if (mode === "delete_section" && input.newMarkdown?.trim()) {
      throw new Error("delete_section does not accept markdown content");
    }

    let convertedLake: string | undefined;
    let baseContentTarget: string | undefined;
    let beforeText = current.title;
    let afterText = nextTitle;
    const warnings: string[] = [];
    if (mode !== "rename") {
      if (mode !== "delete_section") {
        const supplied = input.newMarkdown ?? "";
        assertMarkdownSafe(supplied);
        assertNonEmptyFragment(supplied);
        convertedLake = await this.client.convertMarkdownToLake(
          ownerId,
          supplied,
          input.docUrl,
        );
      }
      const plan = planLakePatch({
        currentLake: current.lakeContent,
        convertedFragment: convertedLake ?? "",
        mode,
        sectionHeading: input.sectionHeading,
      });
      baseContentTarget = plan.baseTargetFingerprint;
      beforeText = plan.beforeText;
      afterText = plan.afterText;
      warnings.push(...plan.warnings);
      warnings.push(
        "Yuque ignores draft_version and If-Match as atomic preconditions. Strict mode remains Preview-only; best_effort uses a local target queue, verified temporary lock ownership, a second baseline read, encrypted snapshot, single write attempt, timeout reconciliation and native write-back verification.",
      );
    }

    const titleIsTarget = nextTitle !== current.title;
    const baseTargetFingerprint = fingerprint({
      mode,
      contentTarget: baseContentTarget ?? null,
      title: titleIsTarget ? current.title : null,
    });
    const diff = createTwoFilesPatch(
      current.title,
      nextTitle,
      normalizeText(beforeText),
      normalizeText(afterText),
      `version-${current.version}`,
      "proposed",
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "update_doc",
        docUrl: input.docUrl,
        targetUrl: input.docUrl,
        displayPath: current.location.displayPath,
        title: current.title,
        newTitle: nextTitle,
        ...(input.newMarkdown !== undefined
          ? { markdown: normalizeText(input.newMarkdown) }
          : {}),
        ...(convertedLake ? { convertedLake } : {}),
        baseFingerprint: current.fingerprint,
        baseTargetFingerprint,
        baseVersion: current.version,
        mode,
        sectionHeading: input.sectionHeading,
      },
      diff,
      warnings,
    );
  }

  async previewCreateSheet(
    ownerId: string,
    input: {
      bookUrl: string;
      parentUuid?: string;
      expectedParentPath?: string;
      title: string;
      worksheets: unknown[];
    },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const title = input.title.trim();
    if (!title) throw new Error("Sheet title is required");
    const slug = createYuqueSlug();
    const target = await this.client.prepareCreateTarget(ownerId, {
      bookUrl: input.bookUrl,
      title,
      slug,
      parentUuid: input.parentUuid,
      expectedParentPath: input.expectedParentPath,
    });
    const operations = initialWorksheetOperations(input.worksheets);
    if (operations.length !== 1) {
      throw new Error(
        "A new Sheet currently supports exactly one verified native worksheet",
      );
    }
    const empty = emptyWorkbook("new-sheet", title);
    const applied = applySheetOperations(empty, operations);
    if (applied.workbook.worksheets.length === 0) {
      throw new Error("A new Sheet must contain at least one worksheet");
    }
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "create_sheet",
        bookUrl: input.bookUrl,
        parentUuid: target.parentUuid,
        expectedParentPath: target.parentPath,
        title,
        slug,
        sheetOperations: operations,
        targetUrl: target.targetUrl,
        displayPath: target.displayPath,
      },
      sheetDiffText(applied.diff, operations),
      [
        "Sheet creation and first-worksheet initialization use separate verified contracts; either uncertain step returns a non-retriable partial or unknown result for reconciliation.",
      ],
      sheetDiffStats(applied.diff),
    );
  }

  async previewUpdateSheet(
    ownerId: string,
    input: { docUrl: string; operations: unknown },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const current = await this.client.getSheet(ownerId, input.docUrl);
    if (containsChartOperation(input.operations)) {
      if (
        new URL(current.url).origin !==
        new URL(this.config.personalYuqueHost).origin
      ) {
        throw new Error(
          "Chart Preview is verified only for the personal Yuque Host",
        );
      }
      const applied = applyLakeSheetChartOperations({
        id: current.id,
        title: current.title,
        draftVersion: current.version,
        bodyDraft: current.bodyDraft,
        operations: input.operations,
      });
      return this.savePreview(
        {
          schemaVersion: 3,
          kind: "update_sheet_chart",
          docUrl: input.docUrl,
          targetUrl: input.docUrl,
          displayPath: current.location.displayPath,
          title: current.title,
          sheetChartOperations: applied.operations,
          baseFingerprint: current.workbook.fingerprint,
          baseWorkbookFingerprint: current.workbook.fingerprint,
          baseTargetFingerprint: applied.baseTargetFingerprint,
          baseVersion: current.version,
        },
        sheetChartDiffText(applied.diff, applied.operations),
        [
          "Chart candidate passed local encode/decode and semantic isolation checks; no remote write occurred.",
          "Chart Confirm is deliberately disabled because Yuque accepts stale draft_version and no atomic precondition or timeout reconciliation contract is known.",
        ],
        sheetChartDiffStats(applied.diff),
      );
    }
    const operations = validateSheetOperations(input.operations);
    const renameOperation = operations.find(
      (operation) => operation.op === "rename_worksheet",
    );
    if (
      renameOperation &&
      current.chartSummaries.some(
        (chart) =>
          chart.worksheetId === renameOperation.worksheetId ||
          chart.dataWorksheetId === renameOperation.worksheetId,
      )
    ) {
      throw new Error(
        "Worksheet rename with chart references has not completed replay verification",
      );
    }
    const applied = applySheetOperations(current.workbook, operations);
    if (applied.diff.length === 0) {
      throw new Error("Sheet preview contains no semantic changes");
    }
    const baseTargetFingerprint = sheetOperationTargetFingerprint(
      current.workbook,
      operations,
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "update_sheet",
        docUrl: input.docUrl,
        targetUrl: input.docUrl,
        displayPath: current.location.displayPath,
        title: current.title,
        sheetOperations: operations,
        baseFingerprint: current.workbook.fingerprint,
        baseWorkbookFingerprint: current.workbook.fingerprint,
        baseTargetFingerprint,
        baseVersion: current.version,
      },
      sheetDiffText(applied.diff, operations),
      [
        ...current.unsupportedFeatures.map(
          (feature) => `Preserved unsupported workbook feature: ${feature}`,
        ),
        "Yuque accepts stale draft_version. Strict mode remains Preview-only; best_effort requires an exact personal knowledge-base allowlist and uses local serialization, verified temporary lock ownership, a second workbook read, encrypted snapshot, a single save attempt, timeout reconciliation and semantic write-back verification.",
      ],
      sheetDiffStats(applied.diff),
    );
  }

  async previewRestoreSnapshot(
    ownerId: string,
    snapshotId: string,
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const snapshot = this.loadSnapshot(snapshotId);
    if (
      snapshot.resourceType === "sheet" &&
      snapshot.sheetDraft !== undefined
    ) {
      const current = await this.client.getSheet(ownerId, snapshot.targetUrl);
      const restored = decodeLakeSheetDraft({
        id: current.id,
        title: current.title,
        draftVersion: snapshot.version,
        bodyDraft: snapshot.sheetDraft,
      });
      const currentText = sheetSnapshotPreviewText(current.workbook);
      const restoredText = sheetSnapshotPreviewText(restored.workbook);
      if (currentText === restoredText) {
        throw new Error("The Sheet already matches this snapshot");
      }
      const diff = createTwoFilesPatch(
        `${current.title} (current)`,
        `${snapshot.title} (snapshot)`,
        currentText,
        restoredText,
        `version-${current.version}`,
        `snapshot-${snapshotId}`,
      );
      return this.savePreview(
        {
          schemaVersion: 3,
          kind: "restore_sheet_snapshot",
          docUrl: snapshot.targetUrl,
          targetUrl: snapshot.targetUrl,
          displayPath: current.location.displayPath,
          title: current.title,
          sheetDraft: snapshot.sheetDraft,
          baseFingerprint: current.workbook.fingerprint,
          baseWorkbookFingerprint: current.workbook.fingerprint,
          baseVersion: current.version,
          snapshotId,
          resourceType: "Sheet",
        },
        diff,
        [
          "Restoring creates a new Sheet version and preserves Yuque history.",
          "The encrypted snapshot contains the complete native LakeSheet draft captured immediately before a confirmed write.",
          "Any concurrent workbook change after this Preview blocks Confirm; best_effort and an exact personal knowledge-base allowlist are still required.",
        ],
      );
    }
    if (
      snapshot.resourceType !== "doc" ||
      snapshot.lakeContent === undefined ||
      snapshot.plainText === undefined
    ) {
      throw new Error(
        "This snapshot does not contain a native Lake document and cannot be restored losslessly",
      );
    }
    const current = await this.client.getDoc(ownerId, snapshot.targetUrl);
    const diff = createTwoFilesPatch(
      current.title,
      snapshot.title,
      normalizeText(current.markdown),
      normalizeText(snapshot.plainText),
      `version-${current.version}`,
      `snapshot-${snapshotId}`,
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "restore_snapshot",
        docUrl: snapshot.targetUrl,
        targetUrl: snapshot.targetUrl,
        displayPath: current.location.displayPath,
        title: current.title,
        newTitle: snapshot.title,
        convertedLake: snapshot.lakeContent,
        markdown: snapshot.plainText,
        baseFingerprint: current.fingerprint,
        baseTargetFingerprint: fingerprint({
          mode: "restore",
          lake: current.lakeContent,
          title: current.title,
        }),
        baseVersion: current.version,
        mode: "restore",
        snapshotId,
      },
      diff,
      [
        "Restoring is a new version and never deletes Yuque history.",
        "Strict mode remains Preview-only. Best-effort restoration uses the same lock, exact-baseline, single-write, timeout-reconciliation and native read-back safeguards as a normal Doc update.",
      ],
    );
  }

  async previewRestoreDocVersion(
    ownerId: string,
    input: { docUrl: string; versionId: string },
  ): Promise<PreviewResult> {
    this.assertOwner(ownerId);
    const current = await this.client.getDoc(ownerId, input.docUrl);
    const historical = await this.client.getDocVersion(
      ownerId,
      input.docUrl,
      input.versionId,
    );
    if (
      historical.doc.url !== input.docUrl ||
      historical.version.docId !== current.id
    ) {
      throw new Error("Historical version does not belong to the selected Doc");
    }
    if (historical.version.format !== "lake") {
      throw new Error("Only native Lake Doc versions can be restored safely");
    }
    assertNonEmptyDocument(historical.version.plainText);
    const protectedBlocks = [
      ...proprietaryBlockTypes(current.lakeContent),
      ...proprietaryBlockTypes(historical.version.content),
    ];
    if (protectedBlocks.length > 0) {
      throw new Error(
        `Historical version restore is blocked because proprietary Lake blocks are present: ${[...new Set(protectedBlocks)].join(", ")}`,
      );
    }
    if (
      current.lakeContent === historical.version.content &&
      current.title === historical.version.title
    ) {
      throw new Error(
        "The Doc already matches the selected historical version",
      );
    }
    const diff = createTwoFilesPatch(
      current.title,
      historical.version.title,
      normalizeText(current.markdown),
      normalizeText(historical.version.plainText),
      `version-${current.version}`,
      `history-${historical.version.id}`,
    );
    return this.savePreview(
      {
        schemaVersion: 3,
        kind: "restore_doc_version",
        docUrl: input.docUrl,
        targetUrl: input.docUrl,
        displayPath: current.location.displayPath,
        title: current.title,
        newTitle: historical.version.title,
        convertedLake: historical.version.content,
        markdown: historical.version.plainText,
        baseFingerprint: current.fingerprint,
        baseTargetFingerprint: fingerprint({
          mode: "restore",
          lake: current.lakeContent,
          title: current.title,
        }),
        baseVersion: current.version,
        mode: "restore",
        versionId: historical.version.id,
      },
      diff,
      [
        `This Preview restores native content from historical version ${historical.version.id} by using the already verified Doc content-write path; it does not call an unverified dedicated restore endpoint.`,
        "Confirm creates a new current version and preserves Yuque history. Strict mode remains Preview-only.",
      ],
    );
  }

  async confirmChange(
    ownerId: string,
    changeToken: string,
    diffDigest: string,
    confirmDeletions = false,
    confirmationText?: string,
  ): Promise<Record<string, unknown>> {
    this.assertOwner(ownerId);
    if (!this.acceptingConfirms) {
      throw new Error(
        "The service is shutting down and is not accepting Confirm requests",
      );
    }
    if (this.config.writeKillSwitch === true) {
      throw new Error(
        "All remote writes are disabled by the deployment WRITE_KILL_SWITCH",
      );
    }
    const { row, payload } = this.loadPreview(changeToken);
    if (
      !diffDigest ||
      diffDigest !== row.diff_digest ||
      diffDigest !== payload.diffDigest
    ) {
      throw new Error("diff_digest does not match the preview");
    }
    if (row.has_deletions === 1 && !confirmDeletions) {
      throw new Error(
        "This change removes existing content; show the diff to the user and confirm again with confirm_deletions=true",
      );
    }
    if (
      payload.confirmationText !== undefined &&
      confirmationText !== payload.confirmationText
    ) {
      throw new Error(
        "confirmation_text must exactly match the full path returned by Preview",
      );
    }
    if (this.config.writeConsistencyMode !== "best_effort") {
      throw new Error(
        "Remote Confirm is blocked by strict write consistency mode; create a new Preview after the deployment owner explicitly enables best_effort for an exact knowledge-base allowlist",
      );
    }
    if (
      payload.kind === "change_book_collaborator" &&
      this.config.allowPermissionChanges !== true
    ) {
      throw new Error("Permission changes were disabled after Preview");
    }
    if (
      ((payload.kind === "change_catalog" &&
        payload.catalogAction === "delete") ||
        payload.kind === "delete_doc" ||
        payload.kind === "delete_sheet" ||
        payload.kind === "delete_book") &&
      this.config.allowObjectDeletion !== true
    ) {
      throw new Error("Object deletion was disabled after Preview");
    }
    if (payload.kind === "update_sheet_chart") {
      throw new Error(
        "Chart Confirm is disabled; cancel this local Preview. No remote write was attempted.",
      );
    }
    if (
      !this.db.transitionPendingChange(changeToken, ["previewed"], "executing")
    ) {
      throw new Error("Change token is no longer executable");
    }
    this.audit(row, "executing");
    this.activeConfirms += 1;

    try {
      const execution = await this.withTargetLock(
        payload.targetUrl || payload.bookUrl || payload.kind,
        () => this.execute(ownerId, payload),
      );
      this.db.transitionPendingChange(
        changeToken,
        ["executing"],
        execution.state,
      );
      this.audit(row, execution.state);
      return execution.result;
    } catch (error) {
      const state: ChangeState = isUncertainWriteError(error)
        ? "unknown"
        : error instanceof PartialWriteError
          ? "partial"
          : error instanceof ConflictError
            ? "conflict"
            : "failed";
      const errorCode = safeErrorCode(error);
      this.db.transitionPendingChange(
        changeToken,
        ["executing"],
        state,
        errorCode,
      );
      this.audit(row, state, errorCode);
      if (state === "unknown") {
        throw new Error(
          "Write result is unknown after a network failure; do not retry. Re-read the target and reconcile manually.",
        );
      }
      if (state === "partial") {
        throw new Error(
          "The content step succeeded but a later write step failed; do not retry automatically. Re-read the document and reconcile manually.",
        );
      }
      throw error;
    } finally {
      this.activeConfirms -= 1;
    }
  }

  activeWriteCount(): number {
    return this.activeConfirms;
  }

  beginShutdown(): void {
    this.acceptingConfirms = false;
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeConfirms > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.activeConfirms === 0;
  }

  objectDeletionEnabled(): boolean {
    return this.config.allowObjectDeletion === true;
  }

  cancel(ownerId: string, changeToken: string): boolean {
    this.assertOwner(ownerId);
    const row = this.db.getPendingChange(changeToken);
    const cancelled = this.db.cancelPendingChange(changeToken);
    if (cancelled && row) this.audit(row, "cancelled");
    return cancelled;
  }

  listSnapshots(
    ownerId: string,
    targetUrl?: string,
  ): Array<Record<string, unknown>> {
    this.assertOwner(ownerId);
    const targetHash = targetUrl ? fingerprint({ targetUrl }) : undefined;
    return this.db.listSnapshots(targetHash).map((row) => {
      const payload = this.crypto.decrypt<SnapshotPayload>(
        row.encrypted_payload,
        snapshotContext(row.snapshot_id, this.config.ownerId),
      );
      return {
        snapshot_id: row.snapshot_id,
        resource_type: row.resource_type,
        display_path: payload.displayPath,
        target_url: payload.targetUrl,
        version: payload.version,
        fingerprint: payload.fingerprint,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    });
  }

  private async execute(
    ownerId: string,
    payload: PendingChangePayload,
  ): Promise<ExecutionResult> {
    if (payload.kind === "create_book") {
      if (
        !payload.bookName ||
        payload.bookVisibility !== "private" ||
        !payload.ownerLogin
      ) {
        throw new Error("Stored knowledge-base creation is incomplete");
      }
      const created = await this.client.createPersonalBook(ownerId, {
        name: payload.bookName,
        description: payload.bookDescription,
      });
      if (!created.private || created.name !== payload.bookName) {
        throw new Error(
          "Created knowledge-base read-back does not match the Preview",
        );
      }
      return {
        state: "succeeded",
        result: { ...created },
      };
    }
    if (payload.kind === "update_book") {
      if (
        !payload.targetUrl ||
        !payload.bookName ||
        payload.bookDescription === undefined ||
        !payload.baseFingerprint ||
        payload.bookVisibility !== "private" ||
        !payload.ownerLogin
      ) {
        throw new Error("Stored knowledge-base update is incomplete");
      }
      const updated = await this.client.updatePersonalBook(ownerId, {
        bookUrl: payload.targetUrl,
        name: payload.bookName,
        description: payload.bookDescription,
        baselineFingerprint: payload.baseFingerprint,
      });
      return {
        state: "succeeded",
        result: { ...updated },
      };
    }
    if (payload.kind === "change_book_collaborator") {
      if (
        !payload.targetUrl ||
        !payload.collaboratorLogin ||
        !payload.collaboratorAction ||
        !payload.baseFingerprint
      ) {
        throw new Error("Stored collaborator change is incomplete");
      }
      const prepared = await this.client.prepareBookCollaboratorChange(
        ownerId,
        {
          bookUrl: payload.targetUrl,
          action: payload.collaboratorAction,
          collaboratorLogin: payload.collaboratorLogin,
          ...(payload.collaboratorRole
            ? { role: payload.collaboratorRole }
            : {}),
        },
      );
      if (prepared.baselineFingerprint !== payload.baseFingerprint) {
        throw new ConflictError(
          "Knowledge-base collaborators changed after Preview; no write was attempted",
        );
      }
      const changed = await this.client.changeBookCollaborator(ownerId, {
        bookUrl: payload.targetUrl,
        action: payload.collaboratorAction,
        collaboratorLogin: payload.collaboratorLogin,
        ...(payload.collaboratorRole ? { role: payload.collaboratorRole } : {}),
        baselineFingerprint: payload.baseFingerprint,
      });
      return { state: "succeeded", result: changed };
    }
    if (payload.kind === "change_catalog") {
      if (
        !payload.bookUrl ||
        !payload.catalogAction ||
        !payload.baseFingerprint
      ) {
        throw new Error("Stored catalog change is incomplete");
      }
      const catalogInput = {
        bookUrl: payload.bookUrl,
        action: payload.catalogAction,
        ...(payload.catalogNodeUuid
          ? { nodeUuid: payload.catalogNodeUuid }
          : {}),
        ...(payload.catalogTargetUuid
          ? { targetUuid: payload.catalogTargetUuid }
          : {}),
        ...(payload.catalogPosition
          ? { position: payload.catalogPosition }
          : {}),
        ...(payload.catalogTitle ? { title: payload.catalogTitle } : {}),
        ...(payload.parentUuid ? { parentUuid: payload.parentUuid } : {}),
        ...(payload.catalogExpectedParentPath
          ? { expectedParentPath: payload.catalogExpectedParentPath }
          : {}),
      };
      const current = await this.client.prepareCatalogChange(
        ownerId,
        catalogInput,
      );
      if (current.baselineFingerprint !== payload.baseFingerprint) {
        throw new ConflictError(
          "Catalog changed after Preview; no write was attempted",
        );
      }
      const changed = await this.client.changeCatalog(ownerId, {
        ...catalogInput,
        baselineFingerprint: payload.baseFingerprint,
      });
      return {
        state:
          changed.status === "partial_created_unrenamed"
            ? "partial"
            : "succeeded",
        result: changed,
      };
    }
    if (payload.kind === "change_comment") {
      if (
        !payload.docUrl ||
        !payload.commentAction ||
        !payload.baseFingerprint
      ) {
        throw new Error("Stored comment change is incomplete");
      }
      const changed = await this.client.changeComment(ownerId, {
        docUrl: payload.docUrl,
        action: payload.commentAction,
        ...(payload.commentId ? { commentId: payload.commentId } : {}),
        ...(payload.commentText ? { body: payload.commentText } : {}),
        ...(payload.commentBodyAsl ? { bodyAsl: payload.commentBodyAsl } : {}),
        ...(payload.commentBodyHtml
          ? { bodyHtml: payload.commentBodyHtml }
          : {}),
        baselineFingerprint: payload.baseFingerprint,
      });
      return { state: "succeeded", result: changed };
    }
    if (payload.kind === "delete_doc" || payload.kind === "delete_sheet") {
      const resourceType = payload.kind === "delete_sheet" ? "Sheet" : "Doc";
      if (
        !payload.docUrl ||
        !payload.baseFingerprint ||
        payload.resourceType !== resourceType
      ) {
        throw new Error("Stored whole-object deletion is incomplete");
      }
      const prepared = await this.client.prepareObjectDeletion(ownerId, {
        docUrl: payload.docUrl,
        resourceType,
      });
      if (prepared.baseFingerprint !== payload.baseFingerprint) {
        throw new ConflictError(
          "The target object changed after Preview; no deletion request was sent",
        );
      }
      const snapshotId =
        resourceType === "Sheet"
          ? this.createSheetSnapshot(prepared.sheet!)
          : this.createDocSnapshot(prepared.doc!);
      const deleted = await this.client.deleteObject(ownerId, {
        docUrl: payload.docUrl,
        resourceType,
        baselineFingerprint: payload.baseFingerprint,
      });
      return {
        state: "succeeded",
        result: {
          ...deleted,
          snapshot_id: snapshotId,
          snapshot_retention_days: 7,
          recovery_semantics: "recreate_copy_only",
        },
      };
    }
    if (payload.kind === "delete_book") {
      if (
        !payload.bookUrl ||
        !payload.baseFingerprint ||
        payload.resourceType !== "KnowledgeBase" ||
        payload.allowNonempty === undefined
      ) {
        throw new Error("Stored knowledge-base deletion is incomplete");
      }
      const prepared = await this.client.prepareBookDeletion(ownerId, {
        bookUrl: payload.bookUrl,
        allowNonempty: payload.allowNonempty,
      });
      if (prepared.baseFingerprint !== payload.baseFingerprint) {
        throw new ConflictError(
          "The knowledge base or its catalog changed after Preview; no deletion request was sent",
        );
      }
      const deleted = await this.client.deleteBook(ownerId, {
        bookUrl: payload.bookUrl,
        allowNonempty: payload.allowNonempty,
        baselineFingerprint: payload.baseFingerprint,
      });
      return {
        state: "succeeded",
        result: {
          ...deleted,
          snapshot_created: false,
          recovery_semantics: "irreversible_no_complete_local_snapshot",
        },
      };
    }
    if (payload.kind === "create_doc") {
      if (
        !payload.bookUrl ||
        !payload.title ||
        !payload.slug ||
        !payload.convertedLake
      ) {
        throw new Error("Stored create change is incomplete");
      }
      const created = await this.client.createDoc(ownerId, {
        bookUrl: payload.bookUrl,
        title: payload.title,
        slug: payload.slug,
        convertedLake: payload.convertedLake,
        parentUuid: payload.parentUuid,
        expectedParentPath: payload.expectedParentPath,
      });
      return {
        state: created.status === "created" ? "succeeded" : "partial",
        result: { ...created },
      };
    }
    if (payload.kind === "create_sheet") {
      if (
        !payload.bookUrl ||
        !payload.title ||
        !payload.slug ||
        !payload.sheetOperations
      ) {
        throw new Error("Stored Sheet creation is incomplete");
      }
      const created = await this.client.createSheet(ownerId, {
        bookUrl: payload.bookUrl,
        title: payload.title,
        slug: payload.slug,
        parentUuid: payload.parentUuid,
        expectedParentPath: payload.expectedParentPath,
        worksheets: payload.sheetOperations,
      });
      return {
        state: created.status === "created" ? "succeeded" : "partial",
        result: { ...created },
      };
    }
    if (payload.kind === "restore_sheet_snapshot") {
      return this.executeSheetSnapshotRestore(ownerId, payload);
    }
    if (payload.kind === "update_sheet") {
      return this.executeSheetUpdate(ownerId, payload);
    }
    if (
      payload.kind !== "update_doc" &&
      payload.kind !== "restore_snapshot" &&
      payload.kind !== "restore_doc_version"
    ) {
      throw new Error(
        `Change kind '${payload.kind}' is blocked until its live write contract is verified`,
      );
    }
    if (
      !payload.docUrl ||
      !payload.baseFingerprint ||
      !payload.baseTargetFingerprint ||
      !payload.mode
    ) {
      throw new Error("Stored document change is incomplete");
    }
    const docUrl = payload.docUrl;
    let current = await this.client.getDoc(ownerId, docUrl);
    const currentTarget = this.currentTargetFingerprint(current, payload);
    if (current.fingerprint !== payload.baseFingerprint) {
      if (currentTarget === payload.baseTargetFingerprint) {
        const preview = await this.rebasePreview(payload, current);
        return {
          state: "conflict",
          result: {
            status: "repreview_required",
            reason:
              "The document changed outside the target region; no write occurred. Review and confirm the new preview.",
            preview,
          },
        };
      }
      throw new ConflictError(
        "The target title or content region changed after preview; no content was written.",
      );
    }

    return this.withVerifiedResourceLock(
      ownerId,
      { docId: current.id, docUrl, expectedVersion: current.version },
      async () => {
        current = await this.client.getDoc(ownerId, docUrl);
        const lockedTarget = this.currentTargetFingerprint(current, payload);
        if (current.fingerprint !== payload.baseFingerprint) {
          if (lockedTarget === payload.baseTargetFingerprint) {
            const preview = await this.rebasePreview(payload, current);
            return {
              state: "conflict",
              result: {
                status: "repreview_required",
                reason:
                  "The document changed outside the target region after lock acquisition; no write occurred. Review and confirm the new preview.",
                preview,
              },
            };
          }
          throw new ConflictError(
            "The target title or content region changed after lock acquisition; no content was written.",
          );
        }

        const contentUpdate = payload.mode !== "rename";
        const titleUpdate =
          Boolean(payload.newTitle) && payload.newTitle !== current.title;
        if (contentUpdate) this.client.assertDocContentUpdateEnabled(docUrl);
        if (titleUpdate) this.client.assertDocRenameEnabled(docUrl);

        this.createDocSnapshot(current);
        let contentWritten = false;
        let expectedBodyHtml: string | undefined;
        let reconciledAfterUnknownResponse = false;
        try {
          if (contentUpdate) {
            const nextLake = this.proposedLake(current, payload);
            const saved = await this.client.updateDocLake(ownerId, {
              docId: current.id,
              draftVersion: current.version,
              lakeContent: nextLake,
              referer: `${docUrl.replace(/\/$/, "")}/edit`,
            });
            expectedBodyHtml = saved.bodyHtml;
            reconciledAfterUnknownResponse ||=
              saved.reconciledAfterUnknownResponse === true;
            contentWritten = true;
            try {
              await this.client.publishDoc(ownerId, {
                docId: current.id,
                referer: `${docUrl.replace(/\/$/, "")}/edit`,
              });
            } catch (error) {
              if (!isUncertainWriteError(error)) throw error;
              const published = await this.client
                .getDocEditorDraft(ownerId, docUrl)
                .catch(() => undefined);
              if (
                !published ||
                published.publishedAsl !== nextLake ||
                published.publishedHtml !== expectedBodyHtml
              ) {
                throw error;
              }
              reconciledAfterUnknownResponse = true;
            }
          }
          if (titleUpdate && payload.newTitle) {
            try {
              await this.client.renameDoc(ownerId, {
                docId: current.id,
                title: payload.newTitle,
                referer: `${docUrl.replace(/\/$/, "")}/edit`,
              });
            } catch (error) {
              if (!isUncertainWriteError(error)) throw error;
              const renamed = await this.client
                .getDoc(ownerId, docUrl)
                .catch(() => undefined);
              if (!renamed || renamed.title !== payload.newTitle) throw error;
              reconciledAfterUnknownResponse = true;
            }
          }
        } catch (error) {
          if (contentWritten) throw new PartialWriteError();
          throw error;
        }

        const verified = await this.client.getDoc(ownerId, docUrl);
        if (contentUpdate) {
          const expectedLake = this.proposedLake(current, payload);
          if (verified.lakeContent !== expectedLake) {
            throw new Error(
              "Yuque accepted the update but native Lake read-back did not match",
            );
          }
          const nativeVerified = await this.client.getDocEditorDraft(
            ownerId,
            docUrl,
          );
          if (
            nativeVerified.publishedAsl !== expectedLake ||
            nativeVerified.draftAsl !== expectedLake ||
            nativeVerified.publishedHtml !== expectedBodyHtml ||
            nativeVerified.draftHtml !== expectedBodyHtml
          ) {
            throw new Error(
              "Yuque accepted the update but native ASL/HTML read-back did not match",
            );
          }
        }
        if (titleUpdate && verified.title !== payload.newTitle) {
          throw new Error(
            "Yuque accepted the update but title read-back did not match",
          );
        }
        return {
          state: "succeeded",
          result: {
            status:
              payload.kind === "restore_snapshot" ||
              payload.kind === "restore_doc_version"
                ? "restored"
                : "updated",
            display_path: verified.location.displayPath,
            doc_url: docUrl,
            version: verified.version,
            fingerprint: verified.fingerprint,
            reconciled_after_unknown_response: reconciledAfterUnknownResponse,
          },
        };
      },
    );
  }

  private async executeSheetUpdate(
    ownerId: string,
    payload: PendingChangePayload,
  ): Promise<ExecutionResult> {
    if (
      !payload.docUrl ||
      !payload.sheetOperations ||
      !payload.baseWorkbookFingerprint ||
      !payload.baseTargetFingerprint
    ) {
      throw new Error("Stored Sheet update is incomplete");
    }
    let current = await this.client.getSheet(ownerId, payload.docUrl);
    const currentTarget = sheetOperationTargetFingerprint(
      current.workbook,
      payload.sheetOperations,
    );
    if (current.workbook.fingerprint !== payload.baseWorkbookFingerprint) {
      if (currentTarget === payload.baseTargetFingerprint) {
        const preview = await this.previewUpdateSheet(ownerId, {
          docUrl: payload.docUrl,
          operations: payload.sheetOperations,
        });
        return {
          state: "conflict",
          result: {
            status: "repreview_required",
            reason:
              "The workbook changed outside the targeted cells; no write occurred. Review and confirm the new preview.",
            preview,
          },
        };
      }
      throw new ConflictError(
        "The targeted cells or worksheet structure changed after preview; no write occurred.",
      );
    }
    this.client.assertSheetUpdateEnabled(payload.docUrl);
    return this.withVerifiedResourceLock(
      ownerId,
      {
        docId: current.id,
        docUrl: payload.docUrl,
        expectedVersion: current.version,
      },
      async () => {
        current = await this.client.getSheet(ownerId, payload.docUrl!);
        const lockedTarget = sheetOperationTargetFingerprint(
          current.workbook,
          payload.sheetOperations!,
        );
        if (current.workbook.fingerprint !== payload.baseWorkbookFingerprint) {
          if (lockedTarget === payload.baseTargetFingerprint) {
            const preview = await this.previewUpdateSheet(ownerId, {
              docUrl: payload.docUrl!,
              operations: payload.sheetOperations!,
            });
            return {
              state: "conflict",
              result: {
                status: "repreview_required",
                reason:
                  "The workbook changed outside the targeted cells after lock acquisition; no write occurred. Review and confirm the new preview.",
                preview,
              },
            };
          }
          throw new ConflictError(
            "The targeted cells or worksheet structure changed after lock acquisition; no write occurred.",
          );
        }

        const applied = applySheetOperations(
          current.workbook,
          payload.sheetOperations!,
        );
        const encoded = encodeLakeSheetDraft({
          id: current.id,
          title: current.title,
          draftVersion: current.version,
          bodyDraft: current.bodyDraft,
          workbook: applied.workbook,
        });
        const expectedFingerprint = workbookContentFingerprint(
          encoded.workbook,
        );
        this.createSheetSnapshot(current);
        let reconciledAfterUnknownResponse = false;
        let verified: NormalizedSheetDocument | undefined;
        try {
          await this.client.updateSheetDraft(ownerId, {
            docId: current.id,
            draftVersion: current.version,
            bodyDraft: encoded.bodyDraft,
            referer: `${payload.docUrl!.replace(/\/$/, "")}/edit`,
          });
        } catch (error) {
          if (!isUncertainWriteError(error)) throw error;
          verified = await this.client
            .getSheet(ownerId, payload.docUrl!)
            .catch(() => undefined);
          if (
            !verified ||
            workbookContentFingerprint(verified.workbook) !==
              expectedFingerprint
          ) {
            throw error;
          }
          reconciledAfterUnknownResponse = true;
        }
        verified ??= await this.client.getSheet(ownerId, payload.docUrl!);
        if (
          workbookContentFingerprint(verified.workbook) !== expectedFingerprint
        ) {
          throw new Error(
            "Yuque accepted the Sheet update but cell read-back did not match",
          );
        }
        return {
          state: "succeeded",
          result: {
            status: "updated",
            display_path: verified.location.displayPath,
            doc_url: payload.docUrl!,
            version: verified.version,
            fingerprint: verified.workbook.fingerprint,
            reconciled_after_unknown_response: reconciledAfterUnknownResponse,
          },
        };
      },
    );
  }

  private async executeSheetSnapshotRestore(
    ownerId: string,
    payload: PendingChangePayload,
  ): Promise<ExecutionResult> {
    if (
      !payload.docUrl ||
      !payload.sheetDraft ||
      !payload.baseWorkbookFingerprint
    ) {
      throw new Error("Stored Sheet snapshot restoration is incomplete");
    }
    let current = await this.client.getSheet(ownerId, payload.docUrl);
    if (current.workbook.fingerprint !== payload.baseWorkbookFingerprint) {
      throw new ConflictError(
        "The workbook changed after the snapshot restoration Preview; no write occurred.",
      );
    }
    this.client.assertSheetUpdateEnabled(payload.docUrl);
    return this.withVerifiedResourceLock(
      ownerId,
      {
        docId: current.id,
        docUrl: payload.docUrl,
        expectedVersion: current.version,
      },
      async () => {
        current = await this.client.getSheet(ownerId, payload.docUrl!);
        if (current.workbook.fingerprint !== payload.baseWorkbookFingerprint) {
          throw new ConflictError(
            "The workbook changed after lock acquisition; no snapshot restoration was written.",
          );
        }
        const restored = decodeLakeSheetDraft({
          id: current.id,
          title: current.title,
          draftVersion: current.version,
          bodyDraft: payload.sheetDraft!,
        });
        const expectedFingerprint = workbookContentFingerprint(
          restored.workbook,
        );
        this.createSheetSnapshot(current);
        let reconciledAfterUnknownResponse = false;
        let verified: NormalizedSheetDocument | undefined;
        try {
          await this.client.updateSheetDraft(ownerId, {
            docId: current.id,
            draftVersion: current.version,
            bodyDraft: payload.sheetDraft!,
            referer: `${payload.docUrl!.replace(/\/$/, "")}/edit`,
          });
        } catch (error) {
          if (!isUncertainWriteError(error)) throw error;
          verified = await this.client
            .getSheet(ownerId, payload.docUrl!)
            .catch(() => undefined);
          if (
            !verified ||
            workbookContentFingerprint(verified.workbook) !==
              expectedFingerprint
          ) {
            throw error;
          }
          reconciledAfterUnknownResponse = true;
        }
        verified ??= await this.client.getSheet(ownerId, payload.docUrl!);
        if (
          workbookContentFingerprint(verified.workbook) !== expectedFingerprint
        ) {
          throw new Error(
            "Yuque accepted the Sheet snapshot restoration but semantic read-back did not match",
          );
        }
        return {
          state: "succeeded",
          result: {
            status: "restored",
            display_path: verified.location.displayPath,
            doc_url: payload.docUrl!,
            version: verified.version,
            fingerprint: verified.workbook.fingerprint,
            reconciled_after_unknown_response: reconciledAfterUnknownResponse,
          },
        };
      },
    );
  }

  private async withTargetLock<T>(
    target: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = target.trim();
    const previous = this.targetLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.targetLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.targetLocks.get(key) === tail) this.targetLocks.delete(key);
    }
  }

  private async withVerifiedResourceLock(
    ownerId: string,
    input: { docId: string; docUrl: string; expectedVersion: number },
    operation: () => Promise<ExecutionResult>,
  ): Promise<ExecutionResult> {
    const before = await this.client.getResourceLockState(ownerId, input);
    if (before.draftVersion !== input.expectedVersion) {
      throw new ConflictError(
        "The Yuque draft version changed before lock acquisition; no write occurred.",
      );
    }
    if (before.lockerPresent || before.collaboratorCount > 0) {
      throw new ConflictError(
        "The target is locked or has active collaborators; no write occurred.",
      );
    }

    let acquired = false;
    let completed: ExecutionResult | undefined;
    let operationError: unknown;
    try {
      const locked = await this.client.acquireResourceLock(ownerId, input);
      acquired = true;
      if (
        locked.draftVersion !== input.expectedVersion ||
        !locked.lockerPresent ||
        locked.ownedByClient !== true ||
        locked.collaboratorCount > 0
      ) {
        throw new ConflictError(
          "The Yuque lock could not be exclusively verified at the Preview version; no write occurred.",
        );
      }
      completed = await operation();
      return completed;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (acquired) {
        try {
          await this.client.releaseResourceLock(ownerId, input);
        } catch {
          if (
            operationError === undefined &&
            completed?.state === "succeeded"
          ) {
            throw new PartialWriteError(
              "The content result is known, but the temporary Yuque lock could not be released or reconciled",
            );
          }
          if (operationError === undefined) {
            throw new ConflictError(
              "No content write was completed, but temporary lock release could not be verified",
            );
          }
        }
      }
    }
  }

  private async rebasePreview(
    payload: PendingChangePayload,
    current: NormalizedDoc,
  ): Promise<PreviewResult> {
    if (!payload.docUrl || !payload.mode) {
      throw new Error("Stored document change cannot be rebased");
    }
    if (payload.mode === "restore") {
      throw new ConflictError(
        "Snapshot restore requires an exact whole-document baseline",
      );
    }
    return this.previewUpdate(this.config.ownerId, {
      docUrl: payload.docUrl,
      mode: payload.mode,
      ...(payload.markdown !== undefined
        ? { newMarkdown: payload.markdown }
        : {}),
      ...(payload.sectionHeading
        ? { sectionHeading: payload.sectionHeading }
        : {}),
      ...(payload.newTitle && payload.newTitle !== current.title
        ? { newTitle: payload.newTitle }
        : {}),
    });
  }

  private proposedLake(
    current: NormalizedDoc,
    payload: PendingChangePayload,
  ): string {
    if (payload.mode === "restore") {
      if (!payload.convertedLake) throw new Error("Snapshot Lake is missing");
      return payload.convertedLake;
    }
    if (payload.mode === "rename") return current.lakeContent;
    if (payload.mode !== "delete_section" && !payload.convertedLake) {
      throw new Error("Converted Lake is missing");
    }
    const mode: LakePatchMode =
      payload.mode === "replace_section"
        ? "replace_section"
        : payload.mode === "delete_section"
          ? "delete_section"
          : "append";
    return planLakePatch({
      currentLake: current.lakeContent,
      convertedFragment: payload.convertedLake ?? "",
      mode,
      sectionHeading: payload.sectionHeading,
    }).lakeContent;
  }

  private currentTargetFingerprint(
    current: NormalizedDoc,
    payload: PendingChangePayload,
  ): string {
    if (payload.mode === "restore") {
      return fingerprint({
        mode: "restore",
        lake: current.lakeContent,
        title: current.title,
      });
    }
    const contentTarget =
      payload.mode === "rename"
        ? null
        : lakeTargetFingerprint({
            currentLake: current.lakeContent,
            mode: payload.mode as LakePatchMode,
            sectionHeading: payload.sectionHeading,
          });
    return fingerprint({
      mode: payload.mode,
      contentTarget,
      title:
        payload.newTitle && payload.newTitle !== payload.title
          ? current.title
          : null,
    });
  }

  private savePreview(
    payload: PendingChangePayload,
    diff: string,
    warnings: string[],
    explicitStats?: PreviewResult["stats"],
  ): PreviewResult {
    const stats = explicitStats ?? diffStats(diff);
    const targetUrl = payload.targetUrl || payload.docUrl || payload.bookUrl;
    if (!targetUrl) throw new Error("Preview target is missing");
    const displayPath = payload.displayPath || targetUrl;
    const diffDigest = fingerprint({
      schemaVersion: payload.schemaVersion,
      kind: payload.kind,
      targetUrl,
      baseFingerprint: payload.baseFingerprint,
      diff,
    });
    payload.diffDigest = diffDigest;
    payload.hasDeletions = stats.has_deletions;
    const changeToken = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + this.config.changeTtlSeconds * 1000,
    );
    const row: PendingChangeRow = {
      change_id: changeToken,
      kind: payload.kind,
      encrypted_payload: this.crypto.encrypt(
        payload,
        changeContext(changeToken, this.config.ownerId),
      ),
      expires_at: expiresAt.toISOString(),
      consumed_at: null,
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
      state: "previewed",
      diff_digest: diffDigest,
      has_deletions: stats.has_deletions ? 1 : 0,
      target_hash: fingerprint({ targetUrl }),
      error_code: null,
    };
    this.db.insertPendingChange(row);
    this.audit(row, "previewed");
    return {
      change_token: changeToken,
      expires_at: expiresAt.toISOString(),
      target_url: targetUrl,
      display_path: displayPath,
      ...(payload.baseFingerprint
        ? { base_fingerprint: payload.baseFingerprint }
        : {}),
      ...(payload.baseVersion !== undefined
        ? { base_version: payload.baseVersion }
        : {}),
      diff,
      diff_digest: diffDigest,
      stats,
      requires_deletion_confirmation: stats.has_deletions,
      warnings,
    };
  }

  private loadPreview(changeToken: string): {
    row: PendingChangeRow;
    payload: PendingChangePayload;
  } {
    const row = this.db.getPendingChange(changeToken);
    if (!row) throw new Error("Change token not found");
    if (row.state !== "previewed") {
      throw new Error(`Change token is '${row.state}' and cannot be executed`);
    }
    if (new Date(row.expires_at) <= new Date()) {
      throw new Error("Change token has expired");
    }
    const payload = this.crypto.decrypt<PendingChangePayload>(
      row.encrypted_payload,
      changeContext(changeToken, this.config.ownerId),
    );
    if (payload.schemaVersion !== 3 || payload.kind !== row.kind) {
      throw new Error("Encrypted change schema or kind mismatch");
    }
    return { row, payload };
  }

  private createDocSnapshot(doc: NormalizedDoc): string {
    const snapshotId = randomUUID();
    const createdAt = new Date();
    const payload: SnapshotPayload = {
      schemaVersion: 3,
      resourceType: "doc",
      targetUrl: doc.url || doc.bookUrl,
      displayPath: doc.location.displayPath,
      title: doc.title,
      lakeContent: doc.lakeContent,
      plainText: doc.markdown,
      fingerprint: doc.fingerprint,
      version: doc.version,
      capturedAt: createdAt.toISOString(),
    };
    const targetHash = fingerprint({ targetUrl: payload.targetUrl });
    this.db.insertSnapshot({
      snapshot_id: snapshotId,
      target_hash: targetHash,
      resource_type: "doc",
      encrypted_payload: this.crypto.encrypt(
        payload,
        snapshotContext(snapshotId, this.config.ownerId),
      ),
      created_at: createdAt.toISOString(),
      expires_at: new Date(
        createdAt.getTime() + SNAPSHOT_RETENTION_MS,
      ).toISOString(),
    });
    this.db.insertAuditEvent({
      event_id: randomUUID(),
      target_hash: targetHash,
      operation: "snapshot_doc",
      state: "snapshot_created",
      diff_digest: null,
      error_code: null,
      created_at: createdAt.toISOString(),
    });
    return snapshotId;
  }

  private createSheetSnapshot(sheet: NormalizedSheetDocument): string {
    const snapshotId = randomUUID();
    const createdAt = new Date();
    const payload: SnapshotPayload = {
      schemaVersion: 3,
      resourceType: "sheet",
      targetUrl: sheet.url,
      displayPath: sheet.location.displayPath,
      title: sheet.title,
      sheetDraft: sheet.bodyDraft,
      fingerprint: sheet.workbook.fingerprint,
      version: sheet.version,
      capturedAt: createdAt.toISOString(),
    };
    const targetHash = fingerprint({ targetUrl: payload.targetUrl });
    this.db.insertSnapshot({
      snapshot_id: snapshotId,
      target_hash: targetHash,
      resource_type: "sheet",
      encrypted_payload: this.crypto.encrypt(
        payload,
        snapshotContext(snapshotId, this.config.ownerId),
      ),
      created_at: createdAt.toISOString(),
      expires_at: new Date(
        createdAt.getTime() + SNAPSHOT_RETENTION_MS,
      ).toISOString(),
    });
    this.db.insertAuditEvent({
      event_id: randomUUID(),
      target_hash: targetHash,
      operation: "snapshot_sheet",
      state: "snapshot_created",
      diff_digest: null,
      error_code: null,
      created_at: createdAt.toISOString(),
    });
    return snapshotId;
  }

  private loadSnapshot(snapshotId: string): SnapshotPayload {
    const row = this.db.getSnapshot(snapshotId);
    if (!row) throw new Error("Snapshot not found or expired");
    return this.crypto.decrypt<SnapshotPayload>(
      row.encrypted_payload,
      snapshotContext(snapshotId, this.config.ownerId),
    );
  }

  private audit(
    row: PendingChangeRow,
    state: ChangeState,
    errorCode?: string,
  ): void {
    this.db.insertAuditEvent({
      event_id: randomUUID(),
      target_hash: row.target_hash,
      operation: row.kind,
      state,
      diff_digest: row.diff_digest || null,
      error_code: errorCode ?? null,
      created_at: new Date().toISOString(),
    });
  }

  private assertOwner(ownerId: string): void {
    if (ownerId !== this.config.ownerId) throw new Error("Owner mismatch");
  }
}

class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

class PartialWriteError extends Error {
  constructor(message = "A later write step failed after content was written") {
    super(message);
    this.name = "PartialWriteError";
  }
}

function initialWorksheetOperations(values: unknown[]): unknown[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("worksheets must be a non-empty array");
  }
  const names = new Set<string>();
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`worksheets[${String(index)}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new Error(`worksheets[${String(index)}].name is required`);
    }
    const name = record.name.trim();
    if (names.has(name)) throw new Error(`Duplicate worksheet name: ${name}`);
    names.add(name);
    return {
      op: "add_worksheet",
      name,
      ...(record.rows !== undefined ? { rows: record.rows } : {}),
    };
  });
}

function emptyWorkbook(id: string, title: string): NormalizedWorkbook {
  const partial = { id, title, revision: "0", worksheets: [] };
  return { ...partial, fingerprint: sheetSemanticFingerprint(partial) };
}

function sheetDiffText(diff: SheetDiffEntry[], operations: unknown[]): string {
  return JSON.stringify(
    {
      operations: operations.map((operation) => {
        const record = operation as Record<string, unknown>;
        return {
          op: record.op,
          ...(record.worksheetId ? { worksheet_id: record.worksheetId } : {}),
          ...(record.name ? { worksheet_name: record.name } : {}),
          ...(record.range ? { range: record.range } : {}),
          ...(record.startRow ? { start_row: record.startRow } : {}),
          ...(record.startColumn ? { start_column: record.startColumn } : {}),
          ...(record.count ? { count: record.count } : {}),
        };
      }),
      cell_changes: diff
        .filter((entry) => entry.kind === "cell")
        .map((entry) => ({
          worksheet: entry.worksheet,
          cell: entry.cell,
          before: entry.before ?? { value: null },
          after: entry.after ?? { value: null },
          deletion: entry.deletion,
        })),
      structural_changes: diff
        .filter((entry) => entry.kind === "structure")
        .map((entry) =>
          entry.structure === "worksheet_name"
            ? {
                worksheet: entry.worksheet,
                structure: entry.structure,
                before: entry.before,
                after: entry.after,
                count: entry.count,
                deletion: false,
              }
            : {
                worksheet: entry.worksheet,
                structure: entry.structure,
                ...(entry.start ? { start: entry.start } : {}),
                count: entry.count,
                deletion: true,
              },
        ),
    },
    null,
    2,
  );
}

function sheetDiffStats(diff: SheetDiffEntry[]): PreviewResult["stats"] {
  const deletions = diff.filter((entry) => entry.deletion).length;
  return {
    added_lines: diff.length - deletions,
    removed_lines: deletions,
    has_deletions: deletions > 0,
  };
}

function containsChartOperation(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return isSheetChartOperationName((entry as Record<string, unknown>).op);
  });
}

function sheetChartDiffText(
  diff: SheetChartDiffEntry[],
  operations: unknown[],
): string {
  return JSON.stringify(
    {
      operations: operations.map((operation) => {
        const record = operation as Record<string, unknown>;
        return {
          op: record.op,
          ...(record.worksheetId ? { worksheet_id: record.worksheetId } : {}),
          ...(record.range ? { range: record.range } : {}),
          ...(record.chartId ? { chart_id: record.chartId } : {}),
          ...(record.chartType ? { chart_type: record.chartType } : {}),
          ...(record.changes ? { changes: record.changes } : {}),
        };
      }),
      chart_changes: diff.map((entry) => ({
        action: entry.action,
        chart_id: entry.chartId,
        worksheet_id: entry.worksheetId,
        source_range: entry.sourceRange,
        changes: entry.changes,
      })),
    },
    null,
    2,
  );
}

function sheetChartDiffStats(
  diff: SheetChartDiffEntry[],
): PreviewResult["stats"] {
  const changes = diff.flatMap((entry) => entry.changes);
  const deletions = changes.filter((entry) => entry.deletion).length;
  return {
    added_lines: changes.length - deletions,
    removed_lines: deletions,
    has_deletions: deletions > 0,
  };
}

function workbookContentFingerprint(workbook: NormalizedWorkbook): string {
  return fingerprint({
    opaqueStructureFingerprint: workbook.opaqueStructureFingerprint,
    worksheets: workbook.worksheets.map((worksheet) => ({
      id: worksheet.id,
      name: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      cells: Object.fromEntries(
        Object.entries(worksheet.cells).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    })),
  });
}

function sheetSnapshotPreviewText(workbook: NormalizedWorkbook): string {
  return JSON.stringify(
    {
      worksheets: workbook.worksheets.map((worksheet) => ({
        id: worksheet.id,
        name: worksheet.name,
        row_count: worksheet.rowCount,
        column_count: worksheet.columnCount,
        cells: Object.fromEntries(
          Object.entries(worksheet.cells)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([address, cell]) => [
              address,
              {
                value: cell.value,
                ...(cell.formula ? { formula: cell.formula } : {}),
                ...(cell.style ? { style: cell.style } : {}),
                ...(cell.kind ? { kind: cell.kind } : {}),
                ...(cell.unsupported ? { unsupported: true } : {}),
              },
            ]),
        ),
      })),
      opaque_structure_fingerprint: workbook.opaqueStructureFingerprint,
    },
    null,
    2,
  );
}

function diffStats(diff: string): PreviewResult["stats"] {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }
  return {
    added_lines: added,
    removed_lines: removed,
    has_deletions: removed > 0,
  };
}

function assertMarkdownSafe(markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > 1024 * 1024) {
    throw new Error("Markdown exceeds the 1 MiB limit");
  }
  if (/!\[[^\]]*\]\([^)]+\)/.test(markdown) || /<img\b/i.test(markdown)) {
    throw new Error("Image and attachment uploads are not supported");
  }
  if (/\b(board|attachment):\/\//i.test(markdown)) {
    throw new Error("Yuque board and attachment blocks are not editable");
  }
}

function assertNonEmptyDocument(markdown: string): void {
  if (!normalizeText(markdown).trim()) {
    throw new Error(
      "Clearing an entire document is forbidden; delete the document manually in Yuque if required",
    );
  }
}

function assertNonEmptyFragment(markdown: string): void {
  if (!normalizeText(markdown).trim()) {
    throw new Error("The inserted or replacement content must not be empty");
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function createYuqueSlug(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function isUncertainWriteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error instanceof TypeError ||
    /timeout|timed out|fetch failed|network|result is unknown/i.test(
      error.message,
    )
  );
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "operation_failed";
  return error.name.slice(0, 64) || "operation_failed";
}

function changeContext(changeId: string, ownerId: string): string {
  return `yuque-change:${ownerId}:${changeId}`;
}

function snapshotContext(snapshotId: string, ownerId: string): string {
  return `yuque-snapshot:${ownerId}:${snapshotId}`;
}
