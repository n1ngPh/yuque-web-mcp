import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import {
  assertRequiredPaths,
  ContractError,
  ContractRegistry,
  interpolatePath,
} from "./contracts.js";
import { fingerprint } from "./crypto.js";
import type { SessionStore } from "./session-store.js";
import type { CapabilityName, StoredWebSession } from "./types.js";
import {
  decodeLakeSheetDraft,
  encodeLakeSheetDraft,
  type SheetChartSummary,
} from "./sheet-codec.js";
import {
  applySheetOperations,
  validateSheetOperations,
  type NormalizedWorkbook,
} from "./sheet-model.js";
import { PinnedLakeHtmlRenderer, type LakeHtmlRenderer } from "./lake-html.js";
import { lakeText } from "./lake-document.js";
import { createYuqueDispatcher } from "./network-policy.js";
import type { Dispatcher } from "undici";

export class ReloginRequiredError extends Error {
  constructor() {
    super("Yuque login has expired; scan the login QR code again");
    this.name = "ReloginRequiredError";
  }
}

export class YuqueHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "YuqueHttpError";
  }
}

interface RequestOptions {
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  referer?: string;
  baseHost?: string;
  returnEnvelope?: boolean;
}

export type YuqueScopeType = "personal" | "organization";

export interface YuqueScope {
  id: string;
  type: YuqueScopeType;
  name: string;
  label: string;
  host: string;
  organizationId?: number;
}

export interface NormalizedDoc {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  lakeContent: string;
  bookId: number;
  bookUrl: string;
  format: string;
  version: number;
  updatedAt?: string;
  url?: string;
  location: DocumentLocation;
  raw: unknown;
  fingerprint: string;
}

export const YUQUE_EXPORT_FORMATS = [
  "word",
  "markdown",
  "pdf",
  "lake",
  "jpg",
  "excel",
  "lakesheet",
] as const;

export type YuqueExportFormat = (typeof YUQUE_EXPORT_FORMATS)[number];
export type YuqueExportTargetType = "Doc" | "Sheet";

export interface YuqueExportOption {
  format: YuqueExportFormat;
  label: string;
  extension: string;
  browserLoginExpected: boolean;
}

export interface YuqueExportOptions {
  targetType: YuqueExportTargetType;
  sourceFormat: string;
  availableFormats: YuqueExportOption[];
  document: {
    id: string;
    title: string;
    url: string;
    bookUrl: string;
    displayPath: string;
    fullPath: string[];
  };
}

export interface YuqueExportLink {
  targetType: YuqueExportTargetType;
  format: YuqueExportFormat;
  filename: string;
  downloadUrl: string;
  expiresAt?: string;
  browserLoginRequired: boolean;
  deliveryHost: string;
  pollRequests: number;
  document: {
    id: string;
    title: string;
    url: string;
    bookUrl: string;
    displayPath: string;
    fullPath: string[];
  };
}

const EXPORT_OPTIONS: Record<
  YuqueExportTargetType,
  readonly YuqueExportOption[]
> = {
  Doc: [
    {
      format: "word",
      label: "Word",
      extension: "docx",
      browserLoginExpected: false,
    },
    {
      format: "markdown",
      label: "Markdown",
      extension: "md",
      browserLoginExpected: true,
    },
    {
      format: "pdf",
      label: "PDF",
      extension: "pdf",
      browserLoginExpected: true,
    },
    {
      format: "lake",
      label: "语雀 Lake",
      extension: "lake",
      browserLoginExpected: true,
    },
    {
      format: "jpg",
      label: "JPG 长图",
      extension: "jpg",
      browserLoginExpected: true,
    },
  ],
  Sheet: [
    {
      format: "excel",
      label: "Excel",
      extension: "xlsx",
      browserLoginExpected: true,
    },
    {
      format: "lakesheet",
      label: "语雀 LakeSheet",
      extension: "lakesheet",
      browserLoginExpected: true,
    },
  ],
};

const EXPORT_POLL_INTERVAL_MS = 5_000;
const EXPORT_MAX_POLL_REQUESTS = 24;

export interface NormalizedDocEditorDraft {
  id: string;
  slug: string;
  title: string;
  bookId: number;
  bookUrl: string;
  format: "lake";
  version: number;
  updatedAt?: string;
  url: string;
  location: DocumentLocation;
  publishedAsl: string;
  draftAsl: string;
  publishedHtml: string;
  draftHtml: string;
  fingerprint: string;
}

export interface ResourceLockState {
  draftVersion: number;
  lockerPresent: boolean;
  collaboratorCount: number;
  ownedByClient?: boolean;
  reconciledAfterUnknownResponse?: boolean;
}

export interface NormalizedBook {
  id: number;
  name: string;
  description: string;
  slug: string;
  groupLogin: string;
  url: string;
  itemsCount: number;
  scopeId: string;
  scopeType: YuqueScopeType;
  scopeName: string;
  scopeLabel: string;
  host: string;
  organizationId?: number;
  ownerType: string;
  ownerLogin: string;
  accessType: "owner" | "collaborator";
  role?: "owner" | "reader" | "editor";
  private: boolean;
  updatedAt?: string;
}

export interface BookCollaborator {
  collaborationId: string;
  login: string;
  name?: string;
  role: "owner" | "reader" | "editor" | "unknown";
  roleCode: number;
  status: number;
  isCurrentUser: boolean;
}

export interface PreparedBookCollaboratorChange {
  book: NormalizedBook;
  action: "invite" | "change_role" | "remove";
  collaboratorLogin: string;
  role?: "reader" | "editor";
  current?: BookCollaborator;
  baselineFingerprint: string;
  displayPath: string;
  candidate?: {
    id: number;
    userId: number;
    login: string;
    name: string;
    workId: string;
  };
}

export interface CatalogNode {
  type: string;
  title: string;
  uuid: string;
  parentUuid?: string;
  level: number;
  order: number;
  visible: boolean;
  path: string[];
  fullPath: string[];
  displayPath: string;
  docId?: number;
  docSlug?: string;
  docUrl?: string;
}

export type CatalogChangeAction = "create" | "rename" | "move" | "delete";
export type CatalogMovePosition = "into" | "after";

export interface CatalogChangeInput {
  bookUrl: string;
  action: CatalogChangeAction;
  nodeUuid?: string;
  targetUuid?: string;
  position?: CatalogMovePosition;
  title?: string;
  parentUuid?: string;
  expectedParentPath?: string;
}

export interface PreparedCatalogChange {
  book: NormalizedBook;
  action: CatalogChangeAction;
  baselineFingerprint: string;
  baselineNodeUuids: string[];
  displayPath: string;
  targetDisplayPath: string;
  node?: CatalogNode;
  target?: CatalogNode;
  title?: string;
  parentUuid?: string;
  expectedParentPath?: string;
  position?: CatalogMovePosition;
}

export interface NormalizedComment {
  id: string;
  parentId?: string;
  rootId?: string;
  authorLogin: string;
  authorName?: string;
  body: string;
  bodyAsl: string;
  format: "lake";
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
}

export interface CommentListResult {
  doc: Pick<NormalizedDoc, "id" | "title" | "url" | "bookUrl" | "location">;
  comments: NormalizedComment[];
  fingerprint: string;
  total: number;
}

export interface PreparedCommentChange {
  doc: NormalizedDoc;
  action: "create" | "update" | "delete";
  current?: NormalizedComment;
  commentId?: string;
  body?: string;
  bodyAsl?: string;
  bodyHtml?: string;
  baselineFingerprint: string;
  displayPath: string;
}

export interface PreparedObjectDeletion {
  resourceType: "Doc" | "Sheet";
  book: NormalizedBook;
  node: CatalogNode;
  targetUrl: string;
  displayPath: string;
  baseFingerprint: string;
  version: number;
  doc?: NormalizedDoc;
  sheet?: NormalizedSheetDocument;
}

export interface DeletedObjectResult {
  status: "trashed";
  resource_type: "Doc" | "Sheet";
  deleted_path: string;
  object_url: string;
  doc_id: string;
  catalog_absent: true;
  direct_read_rejected: true;
  reconciled_after_unknown_response: boolean;
}

export interface NormalizedDocVersionSummary {
  id: string;
  docId: string;
  title: string;
  name?: string;
  createdAt: string;
  draft: boolean;
  released?: boolean;
  publicationStatus?: number;
  authorLogin: string;
  authorName?: string;
  versionUrl?: string;
}

export interface NormalizedDocVersionDetail extends NormalizedDocVersionSummary {
  docType: string;
  format: string;
  slug: string;
  content: string;
  contentHtml: string;
  plainText: string;
  fingerprint: string;
}

export interface DocVersionListResult {
  doc: Pick<NormalizedDoc, "id" | "title" | "url" | "bookUrl" | "location">;
  versions: NormalizedDocVersionSummary[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface DocVersionDetailResult {
  doc: Pick<NormalizedDoc, "id" | "title" | "url" | "bookUrl" | "location">;
  version: NormalizedDocVersionDetail;
}

export interface DocumentLocation {
  path: string[];
  fullPath: string[];
  displayPath: string;
  level: number;
  order: number;
  parentUuid?: string;
}

export interface LocatedDocument {
  id: number;
  slug: string;
  title: string;
  url: string;
  bookId: number;
  bookName: string;
  bookUrl: string;
  groupLogin: string;
  scopeId: string;
  scopeType: YuqueScopeType;
  scopeLabel: string;
  position: DocumentLocation;
}

export interface CreateTarget {
  book: NormalizedBook;
  slug: string;
  title: string;
  targetUrl: string;
  displayPath: string;
  parentPath: string;
  parentUuid?: string;
}

export interface CreatedDocResult {
  status:
    "created" | "partial_created_unmounted" | "partial_created_unverified";
  id: string;
  slug: string;
  title: string;
  docUrl: string;
  displayPath?: string;
  version?: number;
  fingerprint?: string;
  catalogMounted: boolean;
  reconciledAfterUnknownResponse: boolean;
}

export interface CreatedSheetResult {
  status:
    | "created"
    | "partial_created_unmounted"
    | "partial_created_uninitialized"
    | "partial_created_unverified";
  id: string;
  slug: string;
  title: string;
  sheetUrl: string;
  displayPath?: string;
  version?: number;
  fingerprint?: string;
  worksheetCount?: number;
  catalogMounted: boolean;
  reconciledAfterUnknownResponse: boolean;
}

export interface PreparedBookCreate {
  name: string;
  ownerLogin: string;
  displayPath: string;
  dashboardUrl: string;
}

export interface CreatedBookResult {
  status: "created";
  id: string;
  slug: string;
  name: string;
  bookUrl: string;
  displayPath: string;
  private: true;
  reconciledAfterUnknownResponse: boolean;
}

export interface PreparedBookUpdate {
  book: NormalizedBook;
  name: string;
  description: string;
  baselineFingerprint: string;
  displayPath: string;
}

export interface UpdatedBookResult {
  status: "updated";
  id: string;
  name: string;
  description: string;
  bookUrl: string;
  displayPath: string;
  fingerprint: string;
  reconciledAfterUnknownResponse: boolean;
}

export interface PreparedBookDeletion {
  book: NormalizedBook;
  catalog: CatalogNode[];
  displayPath: string;
  baseFingerprint: string;
  allowNonempty: boolean;
}

export interface DeletedBookResult {
  status: "deleted";
  deletion_effect: "irreversible_book_removal";
  deleted_path: string;
  book_url: string;
  book_id: string;
  deleted_catalog_nodes: number;
  list_absent: true;
  direct_read_rejected: true;
  reconciled_after_unknown_response: boolean;
}

export interface NormalizedSheetDocument {
  id: string;
  slug: string;
  title: string;
  format: "lakesheet";
  bookId: number;
  bookUrl: string;
  version: number;
  updatedAt?: string;
  url: string;
  location: DocumentLocation;
  workbook: NormalizedWorkbook;
  bodyDraft: string;
  unsupportedFeatures: string[];
  chartSummaries: SheetChartSummary[];
}

export class YuqueWebClient {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly docLockClientUuid = randomUUID();
  private readonly documentIndexCache = new Map<
    string,
    { expiresAt: number; documents: LocatedDocument[] }
  >();
  private readonly dispatcher: Dispatcher | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly contracts: ContractRegistry,
    private readonly sessions: SessionStore,
    private readonly lakeHtml: LakeHtmlRenderer = new PinnedLakeHtmlRenderer(),
    private readonly exportPollDelay: (
      milliseconds: number,
    ) => Promise<void> = wait,
  ) {
    this.dispatcher = createYuqueDispatcher(config);
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }

  async getUser(employeeId: string): Promise<unknown> {
    return this.request(employeeId, "get_user");
  }

  async listScopes(employeeId: string): Promise<{
    defaultScopeId: "personal" | "organization";
    scopes: YuqueScope[];
  }> {
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const raw = await this.request(employeeId, "list_organizations", {
      baseHost: this.config.personalYuqueHost,
      referer: `${this.config.personalYuqueHost}/dashboard`,
    });
    if (!Array.isArray(raw)) {
      throw new ContractError("Yuque organization list is not an array");
    }
    const personalName = session.account.name?.trim() || session.account.login;
    const organizations = raw.map((value) =>
      normalizeOrganizationScope(value, this.config.yuqueHost),
    );
    return {
      defaultScopeId: organizations.length > 0 ? "organization" : "personal",
      scopes: [
        {
          id: "personal",
          type: "personal",
          name: personalName,
          label: `个人：${personalName}`,
          host: this.config.personalYuqueHost,
        },
        ...organizations,
      ],
    };
  }

  async listBooks(
    employeeId: string,
    keyword?: string,
    limit = 20,
    scopeId = "organization",
  ): Promise<NormalizedBook[]> {
    const books = await this.listAllBooks(employeeId, scopeId);
    const normalizedKeyword = keyword?.trim().toLocaleLowerCase();
    const filtered = normalizedKeyword
      ? books.filter((book) =>
          [book.name, book.slug, book.groupLogin, book.url].some((value) =>
            value.toLocaleLowerCase().includes(normalizedKeyword),
          ),
        )
      : books;
    return filtered.slice(0, limit);
  }

  async getBook(employeeId: string, bookUrl: string): Promise<NormalizedBook> {
    return this.resolveBook(employeeId, bookUrl);
  }

  async listBookCollaborators(
    employeeId: string,
    bookUrl: string,
  ): Promise<{ book: NormalizedBook; collaborators: BookCollaborator[] }> {
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const book = await this.resolveBook(employeeId, bookUrl);
    if (book.scopeType !== "personal") {
      throw new ContractError(
        "Private collaborator listing is verified only for personal knowledge bases",
      );
    }
    const raw = await this.request(employeeId, "list_book_collaborators", {
      query: {
        target_type: "Book",
        target_id: book.id,
        limit: 40,
        offset: 0,
        withCount: true,
        query: "",
      },
      baseHost: book.host,
      referer: `${book.host}/r/${encodeURIComponent(book.groupLogin)}/${encodeURIComponent(book.slug)}/collaborators`,
    });
    if (!Array.isArray(raw)) {
      throw new ContractError("Yuque collaborator list is not an array");
    }
    const collaborators = raw.map((value) =>
      normalizeBookCollaborator(value, session.account.login, book.groupLogin),
    );
    return { book, collaborators };
  }

  async prepareBookCollaboratorChange(
    employeeId: string,
    input: {
      bookUrl: string;
      action: "invite" | "change_role" | "remove";
      collaboratorLogin: string;
      role?: "reader" | "editor";
    },
  ): Promise<PreparedBookCollaboratorChange> {
    this.assertWriteTargetAllowed(input.bookUrl);
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const { book, collaborators } = await this.listBookCollaborators(
      employeeId,
      input.bookUrl,
    );
    if (
      book.scopeType !== "personal" ||
      book.ownerLogin !== session.account.login ||
      book.accessType !== "owner" ||
      !book.private
    ) {
      throw new ContractError(
        "Collaborator changes are verified only for a private personal knowledge base owned by the current account",
      );
    }
    const collaboratorLogin = input.collaboratorLogin.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(collaboratorLogin)) {
      throw new Error("collaborator_login is not a valid Yuque login");
    }
    if (collaboratorLogin === session.account.login) {
      throw new Error(
        "The knowledge-base owner cannot be changed as a collaborator",
      );
    }
    if (
      (input.action === "invite" || input.action === "change_role") &&
      !input.role
    ) {
      throw new Error("role is required for invite and change_role");
    }
    if (input.action === "remove" && input.role) {
      throw new Error("role must be omitted for remove");
    }
    const matches = collaborators.filter(
      (entry) => entry.login === collaboratorLogin,
    );
    if (matches.length > 1) {
      throw new ContractError("Collaborator list contains a duplicate login");
    }
    const current = matches[0];
    let candidate: PreparedBookCollaboratorChange["candidate"];
    if (input.action === "invite") {
      if (current) throw new Error("The Yuque login is already a collaborator");
      candidate = await this.findExactUser(employeeId, collaboratorLogin, book);
    } else {
      if (!current) throw new Error("The Yuque login is not a collaborator");
      if (current.role !== "reader" && current.role !== "editor") {
        throw new ContractError(
          "Only verified reader/editor collaborators can be changed",
        );
      }
      if (input.action === "change_role" && current.role === input.role) {
        throw new Error("Collaborator already has the requested role");
      }
    }
    return {
      book,
      action: input.action,
      collaboratorLogin,
      ...(input.role ? { role: input.role } : {}),
      ...(current ? { current } : {}),
      ...(candidate ? { candidate } : {}),
      baselineFingerprint: collaboratorFingerprint(collaborators),
      displayPath: `${book.scopeLabel} / ${book.name}`,
    };
  }

  async changeBookCollaborator(
    employeeId: string,
    input: {
      bookUrl: string;
      action: "invite" | "change_role" | "remove";
      collaboratorLogin: string;
      role?: "reader" | "editor";
      baselineFingerprint: string;
    },
  ): Promise<Record<string, unknown>> {
    const prepared = await this.prepareBookCollaboratorChange(
      employeeId,
      input,
    );
    if (prepared.baselineFingerprint !== input.baselineFingerprint) {
      throw new ContractError(
        "Knowledge-base collaborators changed after Preview; no write was attempted",
      );
    }
    const capability: CapabilityName =
      prepared.action === "invite"
        ? "create_book_collaborator"
        : prepared.action === "change_role"
          ? "update_book_collaborator"
          : "delete_book_collaborator";
    this.contracts.getWritable(capability, "personal");
    const referer = `${prepared.book.host}/r/${encodeURIComponent(prepared.book.groupLogin)}/${encodeURIComponent(prepared.book.slug)}/collaborators`;
    const roleCode = prepared.role === "editor" ? 1 : 0;
    let collaborationId = prepared.current?.collaborationId;
    let reconciledAfterUnknownResponse = false;
    try {
      if (prepared.action === "invite") {
        if (!prepared.candidate) {
          throw new Error("Stored collaborator candidate is missing");
        }
        const raw = await this.request(employeeId, capability, {
          body: {
            onlyStaff: true,
            role: roleCode,
            status: 1,
            target_id: prepared.book.id,
            target_type: "Book",
            users: [
              {
                id: prepared.candidate.id,
                login: prepared.candidate.login,
                name: prepared.candidate.name,
                user_id: prepared.candidate.userId,
                work_id: prepared.candidate.workId,
                workid: prepared.candidate.workId,
              },
            ],
          },
          baseHost: prepared.book.host,
          referer,
        });
        if (!Array.isArray(raw) || raw.length !== 1) {
          throw new ContractError(
            "Collaborator invitation response is not a single-item array",
          );
        }
        collaborationId = String(
          requireNumber(asRecord(raw[0], "Invited collaborator"), "id"),
        );
      } else if (prepared.action === "change_role") {
        await this.request(employeeId, capability, {
          pathParams: { collaborationId: prepared.current!.collaborationId },
          body: { role: roleCode },
          baseHost: prepared.book.host,
          referer,
        });
      } else {
        await this.request(employeeId, capability, {
          pathParams: { collaborationId: prepared.current!.collaborationId },
          body: {},
          baseHost: prepared.book.host,
          referer,
        });
      }
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      reconciledAfterUnknownResponse = true;
    }
    const verified = await this.listBookCollaborators(
      employeeId,
      prepared.book.url,
    );
    const matches = verified.collaborators.filter(
      (entry) => entry.login === prepared.collaboratorLogin,
    );
    const success =
      prepared.action === "remove"
        ? matches.length === 0
        : matches.length === 1 && matches[0]?.role === prepared.role;
    if (!success) {
      if (reconciledAfterUnknownResponse) {
        throw new Error(
          "Collaborator write result is unknown after a network failure; do not retry",
        );
      }
      throw new ContractError(
        "Collaborator write read-back does not match the Preview",
      );
    }
    if (matches[0]) collaborationId = matches[0].collaborationId;
    return {
      status:
        prepared.action === "invite"
          ? "invited"
          : prepared.action === "change_role"
            ? "role_changed"
            : "removed",
      book_url: prepared.book.url,
      display_path: prepared.displayPath,
      collaborator_login: prepared.collaboratorLogin,
      ...(prepared.role ? { role: prepared.role } : {}),
      ...(collaborationId ? { collaboration_id: collaborationId } : {}),
      reconciled_after_unknown_response: reconciledAfterUnknownResponse,
    };
  }

  private async findExactUser(
    employeeId: string,
    login: string,
    book: NormalizedBook,
  ): Promise<NonNullable<PreparedBookCollaboratorChange["candidate"]>> {
    const raw = await this.request(employeeId, "search_users", {
      query: { q: login, include_unconfirmed_corp_account: true },
      baseHost: book.host,
      referer: `${book.host}/r/${encodeURIComponent(book.groupLogin)}/${encodeURIComponent(book.slug)}/collaborators`,
    });
    if (!Array.isArray(raw)) {
      throw new ContractError("Yuque user search is not an array");
    }
    const matches = raw
      .map((value) => asRecord(value, "Yuque user candidate"))
      .filter((value) => value.login === login);
    if (matches.length !== 1) {
      throw new ContractError(
        "Exact collaborator login did not resolve to one Yuque account",
      );
    }
    const candidate = matches[0];
    if (!candidate) {
      throw new ContractError("Exact collaborator candidate disappeared");
    }
    return {
      id: requireNumber(candidate, "id"),
      userId: requireNumber(candidate, "user_id"),
      login: requireStringValue(candidate, "login"),
      name: requireStringValue(candidate, "name"),
      workId: optionalStringValue(candidate.work_id) ?? "",
    };
  }

  async listAllBooks(
    employeeId: string,
    scopeId = "organization",
  ): Promise<NormalizedBook[]> {
    assertScopeId(scopeId);
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const personal = scopeId === "personal";
    const baseHost = personal
      ? this.config.personalYuqueHost
      : this.config.yuqueHost;
    const capability: CapabilityName = personal
      ? "list_personal_books"
      : "list_books";
    const pageSize = 100;
    const books: NormalizedBook[] = [];
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const raw = await this.request(employeeId, capability, {
        query: { limit: pageSize, offset },
        baseHost,
        ...(personal
          ? { referer: `${this.config.personalYuqueHost}/dashboard` }
          : {}),
      });
      if (!Array.isArray(raw))
        throw new ContractError("Yuque book list is not an array");
      books.push(
        ...raw.map((value) =>
          normalizeBook(value, baseHost, {
            type: personal ? "personal" : "organization",
            personalName: session.account.name?.trim() || session.account.login,
            organizationFallback: this.config.organization,
          }),
        ),
      );
      if (raw.length < pageSize) break;
      if (offset + pageSize >= 10_000)
        throw new ContractError("Yuque book pagination exceeded safety limit");
    }
    if (personal && this.contracts.has("list_collaborate_books", "personal")) {
      if (!this.contracts.has("list_current_collaborations", "personal")) {
        throw new ContractError(
          "Shared knowledge-base role contract is unavailable",
        );
      }
      const currentRaw = await this.request(
        employeeId,
        "list_current_collaborations",
        {
          baseHost,
          referer: `${this.config.personalYuqueHost}/dashboard`,
        },
      );
      if (!Array.isArray(currentRaw)) {
        throw new ContractError("Current collaboration list is not an array");
      }
      const roleByBookId = new Map<number, "reader" | "editor">();
      for (const value of currentRaw) {
        const entry = asRecord(value, "Current collaboration");
        if (entry.target_type !== "Book") continue;
        const targetId = requireNumber(entry, "target_id");
        const role = roleFromCode(requireNumber(entry, "role"));
        if (role === "reader" || role === "editor") {
          roleByBookId.set(targetId, role);
        }
      }
      for (let offset = 0; offset < 10_000; offset += pageSize) {
        const raw = await this.request(employeeId, "list_collaborate_books", {
          query: { limit: pageSize, offset },
          baseHost,
          referer: `${this.config.personalYuqueHost}/dashboard`,
        });
        if (!Array.isArray(raw)) {
          throw new ContractError(
            "Yuque collaborated-book list is not an array",
          );
        }
        books.push(
          ...raw.map((value) => {
            const record = asRecord(value, "Collaborated knowledge base");
            const role = roleByBookId.get(requireNumber(record, "id"));
            if (!role) {
              throw new ContractError(
                "Collaborated knowledge base has no verified current role",
              );
            }
            return normalizeBook(record, baseHost, {
              type: "personal",
              personalName:
                session.account.name?.trim() || session.account.login,
              organizationFallback: this.config.organization,
              accessType: "collaborator",
              collaboratorRole: role,
            });
          }),
        );
        if (raw.length < pageSize) break;
        if (offset + pageSize >= 10_000) {
          throw new ContractError(
            "Yuque collaborated-book pagination exceeded safety limit",
          );
        }
      }
    }
    const filtered = scopeId.startsWith("organization:")
      ? books.filter((book) => book.scopeId === scopeId)
      : books;
    return deduplicateBy(
      filtered,
      (book) => `${new URL(book.url).origin}:${String(book.id)}`,
    );
  }

  async search(
    employeeId: string,
    query: string,
    bookUrl?: string,
    limit = 20,
    scopeId = "organization",
  ): Promise<unknown> {
    assertScopeId(scopeId);
    const book = bookUrl
      ? await this.resolveBook(employeeId, bookUrl)
      : undefined;
    if (!book && scopeId === "personal") {
      throw new ContractError(
        "Personal global search is not verified; provide a personal book_url for book-scoped search",
      );
    }
    return this.request(employeeId, "search", {
      query: {
        p: 1,
        q: query,
        limit,
        type: "content",
        tab: book ? "book" : "organization",
        scope: book ? `${book.groupLogin}/${book.slug}` : "/",
      },
      baseHost: book?.host ?? this.config.yuqueHost,
      ...(book?.scopeType === "personal"
        ? { referer: `${this.config.personalYuqueHost}/dashboard` }
        : {}),
    });
  }

  async getToc(
    employeeId: string,
    bookUrl: string,
  ): Promise<{ book: NormalizedBook; nodes: CatalogNode[] }> {
    const book = await this.resolveBook(employeeId, bookUrl);
    const nodes = await this.loadCatalog(employeeId, book);
    return { book, nodes };
  }

  async prepareCatalogChange(
    employeeId: string,
    input: CatalogChangeInput,
  ): Promise<PreparedCatalogChange> {
    this.assertWriteTargetAllowed(input.bookUrl);
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const book = await this.resolveBook(employeeId, input.bookUrl);
    if (
      book.scopeType !== "personal" ||
      book.ownerLogin !== session.account.login ||
      book.accessType !== "owner" ||
      !book.private
    ) {
      throw new ContractError(
        "Catalog changes are verified only for a private personal knowledge base owned by the current account",
      );
    }
    const nodes = await this.loadCatalog(employeeId, book);
    const baselineFingerprint = catalogFingerprint(nodes);
    const baselineNodeUuids = nodes.map((node) => node.uuid).sort();
    const bookPath = `${book.scopeLabel} / ${book.name}`;
    const findNode = (uuid: string | undefined, field: string): CatalogNode => {
      if (!uuid) throw new Error(`${field} is required`);
      const node = nodes.find((candidate) => candidate.uuid === uuid);
      if (!node) throw new Error(`${field} does not identify a catalog node`);
      return node;
    };

    if (input.action === "create") {
      const title = normalizeCatalogTitle(input.title);
      const parentUuid = input.parentUuid?.trim() || undefined;
      const parent = parentUuid
        ? findNode(parentUuid, "parent_uuid")
        : undefined;
      if (parent && parent.type !== "TITLE") {
        throw new Error("parent_uuid must identify a directory group");
      }
      const parentPath = parent?.displayPath ?? bookPath;
      if (
        input.expectedParentPath?.trim() &&
        input.expectedParentPath.trim() !== parentPath
      ) {
        throw new ContractError(
          `Expected parent path does not match the current catalog: ${parentPath}`,
        );
      }
      assertUniqueCatalogTitle(nodes, parentUuid, title);
      return {
        book,
        action: "create",
        title,
        ...(parentUuid ? { parentUuid } : {}),
        ...(input.expectedParentPath
          ? { expectedParentPath: input.expectedParentPath.trim() }
          : {}),
        baselineFingerprint,
        baselineNodeUuids,
        displayPath: parentPath,
        targetDisplayPath: `${parentPath} / ${title}`,
      };
    }

    const node = findNode(input.nodeUuid, "node_uuid");
    if (input.action === "rename") {
      if (node.type !== "TITLE") {
        throw new ContractError(
          "Catalog rename is restricted to directory TITLE nodes",
        );
      }
      const title = normalizeCatalogTitle(input.title);
      if (title === node.title) throw new Error("Directory title is unchanged");
      assertUniqueCatalogTitle(nodes, node.parentUuid, title, node.uuid);
      const parentPath = node.fullPath.slice(0, -1).join(" / ");
      return {
        book,
        action: "rename",
        node,
        title,
        baselineFingerprint,
        baselineNodeUuids,
        displayPath: node.displayPath,
        targetDisplayPath: `${parentPath} / ${title}`,
      };
    }
    if (input.action === "move") {
      if (node.type !== "TITLE" && node.type !== "DOC") {
        throw new ContractError(
          "Catalog move is verified only for directory, Doc and Sheet entries",
        );
      }
      const target = findNode(input.targetUuid, "target_uuid");
      const position = input.position;
      if (position !== "into" && position !== "after") {
        throw new Error("position must be into or after");
      }
      if (target.uuid === node.uuid) {
        throw new Error("A directory cannot be moved relative to itself");
      }
      if (position === "into" && target.type !== "TITLE") {
        throw new Error("position=into requires a directory target");
      }
      if (
        node.type === "TITLE" &&
        catalogNodeIsDescendant(nodes, target, node.uuid)
      ) {
        throw new Error("A directory cannot be moved into its descendant");
      }
      const targetParentUuid =
        position === "into" ? target.uuid : target.parentUuid;
      const parentPath =
        position === "into"
          ? target.displayPath
          : target.fullPath.slice(0, -1).join(" / ");
      assertUniqueCatalogTitle(nodes, targetParentUuid, node.title, node.uuid);
      return {
        book,
        action: "move",
        node,
        target,
        position,
        baselineFingerprint,
        baselineNodeUuids,
        displayPath: node.displayPath,
        targetDisplayPath: `${parentPath} / ${node.title}`,
      };
    }
    if (input.action === "delete") {
      if (node.type !== "TITLE") {
        throw new ContractError(
          "Catalog deletion is restricted to empty directory TITLE nodes; use the dedicated Doc or Sheet deletion Preview for whole objects",
        );
      }
      const children = nodes.filter(
        (candidate) => candidate.parentUuid === node.uuid,
      );
      if (children.length > 0) {
        throw new ContractError(
          "Non-empty directory deletion is disabled; move or delete every child explicitly first",
        );
      }
      return {
        book,
        action: "delete",
        node,
        baselineFingerprint,
        baselineNodeUuids,
        displayPath: node.displayPath,
        targetDisplayPath: node.displayPath,
      };
    }
    throw new Error("Unsupported catalog action");
  }

  assertCatalogChangeEnabled(targetUrl: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable("change_catalog", "personal");
  }

  async changeCatalog(
    employeeId: string,
    input: CatalogChangeInput & { baselineFingerprint: string },
  ): Promise<Record<string, unknown>> {
    this.assertCatalogChangeEnabled(input.bookUrl);
    const prepared = await this.prepareCatalogChange(employeeId, input);
    if (prepared.baselineFingerprint !== input.baselineFingerprint) {
      throw new ContractError(
        "Catalog changed after Preview; no write was attempted",
      );
    }
    const requestBody = (fields: Record<string, unknown>) => ({
      book_id: prepared.book.id,
      format: "list",
      ...fields,
    });
    if (prepared.action === "create") {
      const inserted = await this.insertCatalogGroup(
        employeeId,
        prepared,
        requestBody,
      );
      let renameError: unknown;
      try {
        await this.request(employeeId, "change_catalog", {
          body: requestBody({
            action: "edit",
            node_uuid: inserted.uuid,
            title: prepared.title,
          }),
          baseHost: prepared.book.host,
          referer: `${prepared.book.url}/toc`,
        });
      } catch (error) {
        renameError = error;
      }
      const current = await this.waitForCatalog(
        employeeId,
        prepared.book,
        (nodes) =>
          nodes.some(
            (node) =>
              node.uuid === inserted.uuid && node.title === prepared.title,
          ),
      );
      const created = current.find((node) => node.uuid === inserted.uuid);
      if (!created || created.title !== prepared.title) {
        return {
          status: "partial_created_unrenamed",
          node_uuid: inserted.uuid,
          display_path: created?.displayPath ?? prepared.displayPath,
          ...(renameError ? { error_code: "catalog_rename_failed" } : {}),
        };
      }
      this.invalidateDocumentIndex(employeeId);
      return {
        status: "created",
        node_uuid: created.uuid,
        display_path: created.displayPath,
        book_url: prepared.book.url,
        catalog_fingerprint: catalogFingerprint(current),
      };
    }

    const node = prepared.node;
    if (!node) throw new Error("Prepared catalog node is missing");
    const body =
      prepared.action === "rename"
        ? requestBody({
            action: "edit",
            node_uuid: node.uuid,
            title: prepared.title,
          })
        : prepared.action === "move"
          ? requestBody({
              action:
                prepared.position === "into" ? "prependChild" : "moveAfter",
              node_uuid: node.uuid,
              target_uuid: prepared.target?.uuid,
            })
          : requestBody({
              action: "destroyWithChildren",
              has_child: false,
              node_uuid: node.uuid,
            });
    const response = await this.request(employeeId, "change_catalog", {
      body,
      baseHost: prepared.book.host,
      referer: `${prepared.book.url}/toc`,
    });
    if (!Array.isArray(response)) {
      throw new ContractError("Catalog write response data is not an array");
    }
    const expectedParentUuid =
      prepared.action === "move"
        ? prepared.position === "into"
          ? prepared.target?.uuid
          : prepared.target?.parentUuid
        : undefined;
    const current = await this.waitForCatalog(
      employeeId,
      prepared.book,
      (nodes) => {
        const candidate = nodes.find((item) => item.uuid === node.uuid);
        if (prepared.action === "delete") return candidate === undefined;
        if (!candidate) return false;
        if (prepared.action === "rename") {
          return candidate.title === prepared.title;
        }
        return (candidate.parentUuid ?? "") === (expectedParentUuid ?? "");
      },
    );
    const verified = current.find((candidate) => candidate.uuid === node.uuid);
    if (prepared.action === "delete") {
      if (verified) {
        throw new ContractError(
          "Yuque accepted directory deletion but the node remains in read-back",
        );
      }
      this.invalidateDocumentIndex(employeeId);
      return {
        status: "deleted",
        deleted_path: prepared.displayPath,
        book_url: prepared.book.url,
        catalog_fingerprint: catalogFingerprint(current),
      };
    }
    if (!verified) {
      throw new ContractError(
        "Catalog node disappeared after a non-delete write",
      );
    }
    if (prepared.action === "rename" && verified.title !== prepared.title) {
      throw new ContractError(
        "Directory rename read-back does not match Preview",
      );
    }
    if (prepared.action === "move") {
      if ((verified.parentUuid ?? "") !== (expectedParentUuid ?? "")) {
        throw new ContractError(
          "Directory move read-back parent does not match",
        );
      }
    }
    this.invalidateDocumentIndex(employeeId);
    return {
      status: prepared.action === "rename" ? "renamed" : "moved",
      node_uuid: verified.uuid,
      display_path: verified.displayPath,
      book_url: prepared.book.url,
      catalog_fingerprint: catalogFingerprint(current),
    };
  }

  async listComments(
    employeeId: string,
    docUrl: string,
  ): Promise<CommentListResult> {
    const doc = await this.getDoc(employeeId, docUrl);
    const rawDoc = asRecord(doc.raw, "Comment target document");
    if (rawDoc.type === "Sheet" || doc.format === "lakesheet") {
      throw new ContractError("Document comments are not verified for Sheet");
    }
    const targetUrl = doc.url ?? docUrl.replace(/\/$/, "");
    const baseHost = parseYuqueUrl(targetUrl, this.allowedYuqueHosts()).origin;
    const raw = asRecord(
      await this.request(employeeId, "list_comments", {
        query: {
          commentable_id: doc.id,
          commentable_type: "Doc",
          include_reactions: true,
          include_section: true,
          include_to_user: true,
        },
        referer: targetUrl,
        baseHost,
      }),
      "Comment list",
    );
    const roots = raw.comments;
    if (!Array.isArray(roots)) {
      throw new ContractError("Yuque comment list is not an array");
    }
    const comments = normalizeCommentTree(roots);
    const meta = optionalRecord(raw.meta);
    const total = optionalNonNegativeNumber(meta?.total) ?? comments.length;
    return {
      doc: {
        id: doc.id,
        title: doc.title,
        url: targetUrl,
        bookUrl: doc.bookUrl,
        location: doc.location,
      },
      comments,
      fingerprint: commentCollectionFingerprint(comments),
      total,
    };
  }

  async listDocVersions(
    employeeId: string,
    docUrl: string,
    offset = 0,
    limit = 200,
  ): Promise<DocVersionListResult> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("Version offset must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Version limit must be an integer from 1 to 200");
    }
    const doc = await this.getDoc(employeeId, docUrl);
    const rawDoc = asRecord(doc.raw, "Version target document");
    if (rawDoc.type === "Sheet" || doc.format === "lakesheet") {
      throw new ContractError(
        "Document version history is not verified for Sheet",
      );
    }
    const targetUrl = doc.url ?? docUrl.replace(/\/$/, "");
    const baseHost = parseYuqueUrl(targetUrl, this.allowedYuqueHosts()).origin;
    const raw = await this.request(employeeId, "list_doc_versions", {
      query: {
        doc_id: doc.id,
        doc_type: optionalStringValue(rawDoc.type) ?? "Doc",
        offset,
        limit,
      },
      referer: `${targetUrl}/edit`,
      baseHost,
    });
    if (!Array.isArray(raw)) {
      throw new ContractError("Yuque document version list is not an array");
    }
    const versions = raw.map((value) =>
      normalizeDocVersionSummary(value, doc.id, baseHost),
    );
    return {
      doc: docVersionDocument(doc, targetUrl),
      versions,
      offset,
      limit,
      hasMore: versions.length === limit,
    };
  }

  async getDocVersion(
    employeeId: string,
    docUrl: string,
    versionId: string,
  ): Promise<DocVersionDetailResult> {
    if (!/^[1-9][0-9]*$/.test(versionId)) {
      throw new Error("version_id must be a positive numeric identifier");
    }
    const doc = await this.getDoc(employeeId, docUrl);
    const rawDoc = asRecord(doc.raw, "Version target document");
    if (rawDoc.type === "Sheet" || doc.format === "lakesheet") {
      throw new ContractError(
        "Document version history is not verified for Sheet",
      );
    }
    const targetUrl = doc.url ?? docUrl.replace(/\/$/, "");
    const baseHost = parseYuqueUrl(targetUrl, this.allowedYuqueHosts()).origin;
    const raw = await this.request(employeeId, "get_doc_version", {
      pathParams: { versionId },
      query: { doc_id: doc.id },
      referer: `${targetUrl}/edit`,
      baseHost,
    });
    const version = normalizeDocVersionDetail(raw, doc.id, baseHost);
    if (version.id !== versionId) {
      throw new ContractError(
        "Yuque document version detail ID does not match the requested version",
      );
    }
    return {
      doc: docVersionDocument(doc, targetUrl),
      version,
    };
  }

  async prepareCommentChange(
    employeeId: string,
    input: {
      docUrl: string;
      action: "create" | "update" | "delete";
      commentId?: string;
      body?: string;
    },
  ): Promise<PreparedCommentChange> {
    this.assertWriteTargetAllowed(input.docUrl);
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const listed = await this.listComments(employeeId, input.docUrl);
    const doc = await this.getDoc(employeeId, input.docUrl);
    const displayPath = `${doc.location.displayPath} / 评论`;
    if (input.action === "create") {
      if (input.commentId) {
        throw new Error("comment_id must be omitted for comment creation");
      }
      const body = normalizeCommentBody(input.body);
      const bodyAsl = await this.convertMarkdownToLake(
        employeeId,
        body,
        input.docUrl,
      );
      return {
        doc,
        action: "create",
        body,
        bodyAsl,
        bodyHtml: await this.lakeHtml.render(bodyAsl),
        baselineFingerprint: listed.fingerprint,
        displayPath: `${displayPath} / 新评论`,
      };
    }
    const commentId = normalizePositiveId(input.commentId, "comment_id");
    const matches = listed.comments.filter(
      (comment) => comment.id === commentId,
    );
    if (matches.length !== 1) {
      throw new Error("comment_id does not identify one visible comment");
    }
    const current = matches[0]!;
    if (current.authorLogin !== session.account.login) {
      throw new ContractError(
        "v0.4 comment update/delete is restricted to the current employee's own comments",
      );
    }
    if (input.action === "delete") {
      if (input.body !== undefined) {
        throw new Error("body must be omitted for comment deletion");
      }
      return {
        doc,
        action: "delete",
        commentId,
        current,
        baselineFingerprint: listed.fingerprint,
        displayPath: `${displayPath} #${commentId}`,
      };
    }
    if (input.action !== "update") {
      throw new Error("Unsupported comment action");
    }
    const body = normalizeCommentBody(input.body);
    if (body === current.body) throw new Error("Comment body is unchanged");
    const bodyAsl = await this.convertMarkdownToLake(
      employeeId,
      body,
      input.docUrl,
    );
    return {
      doc,
      action: "update",
      commentId,
      current,
      body,
      bodyAsl,
      bodyHtml: await this.lakeHtml.render(bodyAsl),
      baselineFingerprint: listed.fingerprint,
      displayPath: `${displayPath} #${commentId}`,
    };
  }

  async changeComment(
    employeeId: string,
    input: {
      docUrl: string;
      action: "create" | "update" | "delete";
      commentId?: string;
      body?: string;
      bodyAsl?: string;
      bodyHtml?: string;
      baselineFingerprint: string;
    },
  ): Promise<Record<string, unknown>> {
    this.assertWriteTargetAllowed(input.docUrl);
    const capability =
      input.action === "create"
        ? "create_comment"
        : input.action === "update"
          ? "update_comment"
          : "delete_comment";
    this.contracts.getWritable(capability, "personal");
    const before = await this.listComments(employeeId, input.docUrl);
    if (before.fingerprint !== input.baselineFingerprint) {
      throw new ContractError(
        "Comments changed after Preview; no write was attempted",
      );
    }
    const targetUrl = before.doc.url ?? input.docUrl;
    const baseHost = parseYuqueUrl(targetUrl, this.allowedYuqueHosts()).origin;
    if (input.action === "create") {
      if (!input.body || !input.bodyAsl || !input.bodyHtml) {
        throw new Error("Prepared comment creation is incomplete");
      }
      const raw = asRecord(
        await this.request(employeeId, "create_comment", {
          body: {
            body: input.bodyHtml,
            body_asl: input.bodyAsl,
            commentable_id: Number(before.doc.id),
            commentable_type: "Doc",
            format: "lake",
            mention: null,
            page: null,
            parent_id: null,
            rect: null,
          },
          referer: targetUrl,
          baseHost,
        }),
        "Created comment",
      );
      const createdId = String(requireNumber(raw, "id"));
      const after = await this.listComments(employeeId, input.docUrl);
      const created = after.comments.find(
        (comment) => comment.id === createdId,
      );
      if (!created || created.bodyAsl !== input.bodyAsl) {
        throw new ContractError(
          "Yuque accepted comment creation but read-back did not match",
        );
      }
      return {
        status: "created",
        comment_id: created.id,
        display_path: `${before.doc.location.displayPath} / 评论 #${created.id}`,
        doc_url: targetUrl,
        fingerprint: created.fingerprint,
      };
    }
    const commentId = normalizePositiveId(input.commentId, "comment_id");
    const current = before.comments.find((comment) => comment.id === commentId);
    if (!current) {
      throw new ContractError("Prepared comment disappeared before Confirm");
    }
    if (input.action === "update") {
      if (!input.body || !input.bodyAsl || !input.bodyHtml) {
        throw new Error("Prepared comment update is incomplete");
      }
      await this.request(employeeId, "update_comment", {
        pathParams: { commentId },
        body: {
          body: input.bodyHtml,
          body_asl: input.bodyAsl,
          format: "lake",
          mention: null,
        },
        referer: targetUrl,
        baseHost,
      });
      const after = await this.listComments(employeeId, input.docUrl);
      const updated = after.comments.find(
        (comment) => comment.id === commentId,
      );
      if (!updated || updated.bodyAsl !== input.bodyAsl) {
        throw new ContractError(
          "Yuque accepted comment update but read-back did not match",
        );
      }
      return {
        status: "updated",
        comment_id: updated.id,
        display_path: `${before.doc.location.displayPath} / 评论 #${updated.id}`,
        doc_url: targetUrl,
        fingerprint: updated.fingerprint,
      };
    }
    await this.request(employeeId, "delete_comment", {
      pathParams: { commentId },
      referer: targetUrl,
      baseHost,
    });
    const after = await this.listComments(employeeId, input.docUrl);
    if (after.comments.some((comment) => comment.id === commentId)) {
      throw new ContractError(
        "Yuque accepted comment deletion but the comment remains visible",
      );
    }
    return {
      status: "deleted",
      comment_id: commentId,
      deleted_path: `${before.doc.location.displayPath} / 评论 #${commentId}`,
      doc_url: targetUrl,
    };
  }

  async prepareObjectDeletion(
    employeeId: string,
    input: { docUrl: string; resourceType: "Doc" | "Sheet" },
  ): Promise<PreparedObjectDeletion> {
    this.assertWriteTargetAllowed(input.docUrl);
    if (this.contractHostTypeForTarget(input.docUrl) !== "personal") {
      throw new ContractError(
        "Whole-object deletion is verified only for the personal Yuque Host",
      );
    }
    const resource =
      input.resourceType === "Sheet"
        ? await this.getSheet(employeeId, input.docUrl)
        : await this.getDoc(employeeId, input.docUrl);
    if (
      input.resourceType === "Doc" &&
      (resource as NormalizedDoc).format === "lakesheet"
    ) {
      throw new ContractError(
        "The target is a Sheet; use yuque_preview_delete_sheet",
      );
    }
    const targetUrl = resource.url ?? input.docUrl.replace(/\/$/u, "");
    const book = await this.getBook(employeeId, resource.bookUrl);
    if (
      book.scopeType !== "personal" ||
      book.accessType !== "owner" ||
      book.ownerLogin !== book.groupLogin ||
      !book.private
    ) {
      throw new ContractError(
        "Whole-object deletion is restricted to an owned private personal knowledge base",
      );
    }
    const toc = await this.getToc(employeeId, book.url);
    const matches = toc.nodes.filter(
      (node) =>
        node.type === "DOC" &&
        String(node.docId ?? "") === resource.id &&
        node.docUrl === targetUrl,
    );
    if (matches.length !== 1) {
      throw new ContractError(
        "The target does not resolve to exactly one catalog document node",
      );
    }
    const node = matches[0]!;
    const contentFingerprint =
      input.resourceType === "Sheet"
        ? (resource as NormalizedSheetDocument).workbook.fingerprint
        : (resource as NormalizedDoc).fingerprint;
    return {
      resourceType: input.resourceType,
      book,
      node,
      targetUrl,
      displayPath: node.displayPath,
      baseFingerprint: objectDeletionFingerprint({
        resourceType: input.resourceType,
        bookId: book.id,
        nodeUuid: node.uuid,
        docId: resource.id,
        title: resource.title,
        version: resource.version,
        contentFingerprint,
      }),
      version: resource.version,
      ...(input.resourceType === "Sheet"
        ? { sheet: resource as NormalizedSheetDocument }
        : { doc: resource as NormalizedDoc }),
    };
  }

  async deleteObject(
    employeeId: string,
    input: {
      docUrl: string;
      resourceType: "Doc" | "Sheet";
      baselineFingerprint: string;
    },
  ): Promise<DeletedObjectResult> {
    this.assertWriteTargetAllowed(input.docUrl);
    const capability: CapabilityName =
      input.resourceType === "Sheet" ? "delete_sheet" : "delete_doc";
    this.contracts.getWritable(capability, "personal");
    const prepared = await this.prepareObjectDeletion(employeeId, input);
    if (prepared.baseFingerprint !== input.baselineFingerprint) {
      throw new ContractError(
        "The target object changed after Preview; no deletion request was sent",
      );
    }
    let reconciledAfterUnknownResponse = false;
    try {
      const envelope = asRecord(
        await this.request(employeeId, capability, {
          body: {
            action: "destroyWithChildren",
            book_id: prepared.book.id,
            format: "list",
            has_child: false,
            node_uuid: prepared.node.uuid,
          },
          baseHost: prepared.book.host,
          referer: prepared.targetUrl,
          returnEnvelope: true,
        }),
        "Object deletion response",
      );
      const meta = asRecord(envelope.meta, "Object deletion metadata");
      const deletedDocIds = Array.isArray(meta.deletedDocIds)
        ? meta.deletedDocIds.map(String)
        : [];
      if (
        meta.book_id !== prepared.book.id ||
        meta.node_uuid !== prepared.node.uuid ||
        typeof meta.toc_updated_at !== "string" ||
        deletedDocIds.length !== 1 ||
        deletedDocIds[0] !== String(prepared.node.docId)
      ) {
        throw new ContractError(
          "Object deletion response affected an unexpected document set",
        );
      }
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      reconciledAfterUnknownResponse = true;
    }

    this.invalidateDocumentIndex(employeeId);
    const toc = await this.getToc(employeeId, prepared.book.url);
    const catalogAbsent = !toc.nodes.some(
      (node) =>
        node.uuid === prepared.node.uuid ||
        String(node.docId ?? "") === String(prepared.node.docId),
    );
    let directReadRejected = false;
    try {
      if (input.resourceType === "Sheet") {
        await this.getSheet(employeeId, prepared.targetUrl);
      } else {
        await this.getDoc(employeeId, prepared.targetUrl);
      }
    } catch (error) {
      if (error instanceof YuqueHttpError && error.status === 404) {
        directReadRejected = true;
      } else {
        throw error;
      }
    }
    if (!catalogAbsent || !directReadRejected) {
      const error = new Error(
        "Object deletion result is unknown after read-back; do not retry",
      );
      error.name = "DeletionResultUnknownError";
      throw error;
    }
    return {
      status: "trashed",
      resource_type: input.resourceType,
      deleted_path: prepared.displayPath,
      object_url: prepared.targetUrl,
      doc_id: String(prepared.node.docId),
      catalog_absent: true,
      direct_read_rejected: true,
      reconciled_after_unknown_response: reconciledAfterUnknownResponse,
    };
  }

  private async insertCatalogGroup(
    employeeId: string,
    prepared: PreparedCatalogChange,
    requestBody: (fields: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<CatalogNode> {
    let response: unknown;
    try {
      response = await this.request(employeeId, "change_catalog", {
        body: requestBody({
          action: "insert",
          target_uuid: prepared.parentUuid ?? null,
          type: "TITLE",
        }),
        baseHost: prepared.book.host,
        referer: `${prepared.book.url}/toc`,
      });
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
    }
    const baseline = new Set(prepared.baselineNodeUuids);
    const findCandidates = (nodes: CatalogNode[]) =>
      nodes.filter(
        (node) =>
          !baseline.has(node.uuid) &&
          node.type === "TITLE" &&
          (node.parentUuid ?? "") === (prepared.parentUuid ?? ""),
      );
    const responseNodes = Array.isArray(response)
      ? normalizeCatalog(response, prepared.book)
      : await this.waitForCatalog(
          employeeId,
          prepared.book,
          (nodes) => findCandidates(nodes).length === 1,
        );
    const candidates = findCandidates(responseNodes);
    if (candidates.length !== 1) {
      throw new ContractError(
        "Catalog insert result is unknown; do not retry. Re-read the directory and reconcile manually.",
      );
    }
    return candidates[0]!;
  }

  private async waitForCatalog(
    employeeId: string,
    book: NormalizedBook,
    expected: (nodes: CatalogNode[]) => boolean,
  ): Promise<CatalogNode[]> {
    const delaysMs = [0, 150, 350, 700, 1_200];
    let current: CatalogNode[] = [];
    for (const delayMs of delaysMs) {
      if (delayMs > 0) await delay(delayMs);
      current = await this.loadCatalog(employeeId, book);
      if (expected(current)) return current;
    }
    return current;
  }

  async listDocs(
    employeeId: string,
    bookUrl: string,
    limit = 50,
  ): Promise<LocatedDocument[]> {
    const { book, nodes } = await this.getToc(employeeId, bookUrl);
    return catalogDocuments(book, nodes).slice(0, limit);
  }

  async listAllDocs(
    employeeId: string,
    forceRefresh = false,
    scopeId = "organization",
  ): Promise<LocatedDocument[]> {
    assertScopeId(scopeId);
    const cacheKey = `${employeeId}:${scopeId}`;
    const cached = this.documentIndexCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.documents;
    }
    const books = await this.listAllBooks(employeeId, scopeId);
    const documents: LocatedDocument[] = [];
    for (const book of books) {
      const nodes = await this.loadCatalog(employeeId, book);
      documents.push(...catalogDocuments(book, nodes));
    }
    const deduplicated = deduplicateBy(
      documents,
      (document) => `${document.bookId}:${document.id}`,
    );
    this.documentIndexCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      documents: deduplicated,
    });
    return deduplicated;
  }

  async prepareCreateTarget(
    employeeId: string,
    input: {
      bookUrl: string;
      title: string;
      slug: string;
      parentUuid?: string;
      expectedParentPath?: string;
    },
  ): Promise<CreateTarget> {
    const title = input.title.trim();
    if (!title) throw new Error("Document title is required");
    assertCreateSlug(input.slug);
    const book = await this.resolveBook(employeeId, input.bookUrl);
    const nodes = await this.loadCatalog(employeeId, book);
    const parentUuid = input.parentUuid?.trim() || undefined;
    const parent = parentUuid
      ? nodes.find((node) => node.uuid === parentUuid)
      : undefined;
    if (parentUuid && (!parent || parent.type !== "TITLE")) {
      throw new Error(
        "parent_uuid must identify an existing directory in the target knowledge base",
      );
    }
    const parentPath = parent
      ? parent.fullPath.join(" / ")
      : [book.scopeLabel, book.name].join(" / ");
    if (
      input.expectedParentPath &&
      input.expectedParentPath.trim() !== parentPath
    ) {
      throw new Error(
        `Expected parent path does not match the current catalog: ${parentPath}`,
      );
    }
    const normalizedParent = parentUuid ?? "";
    const duplicateTitle = nodes.find(
      (node) =>
        node.type === "DOC" &&
        (node.parentUuid ?? "") === normalizedParent &&
        node.title === title,
    );
    if (duplicateTitle) {
      throw new Error(
        `An object with the same title already exists at ${duplicateTitle.displayPath}`,
      );
    }
    const duplicateSlug = nodes.find(
      (node) => node.type === "DOC" && node.docSlug === input.slug,
    );
    if (duplicateSlug) {
      throw new Error(
        `The prepared Yuque slug is already in use at ${duplicateSlug.displayPath}`,
      );
    }
    return {
      book,
      slug: input.slug,
      title,
      targetUrl: `${book.url}/${encodeURIComponent(input.slug)}`,
      displayPath: `${parentPath} / ${title}`,
      parentPath,
      ...(parentUuid ? { parentUuid } : {}),
    };
  }

  async getDoc(employeeId: string, docUrl: string): Promise<NormalizedDoc> {
    const locator = parseYuqueUrl(docUrl, this.allowedYuqueHosts());
    if (!locator.docSlug)
      throw new Error("doc_url must include a document slug");
    const book = await this.resolveBook(employeeId, docUrl);
    const detail = await this.request(employeeId, "get_doc", {
      pathParams: { docSlug: locator.docSlug },
      query: {
        book_id: book.id,
        include_contributors: true,
        include_like: true,
        include_hits: true,
        merge_dynamic_data: false,
      },
      baseHost: book.host,
    });
    const text = await this.request(employeeId, "get_doc_text", {
      pathParams: {
        groupSlug: locator.groupSlug,
        bookSlug: locator.bookSlug,
        docSlug: locator.docSlug,
      },
      baseHost: book.host,
    });
    const normalized = normalizeDoc(detail, text, docUrl, book);
    const nodes = await this.loadCatalog(employeeId, book);
    const located = catalogDocuments(book, nodes).find(
      (document) =>
        String(document.id) === normalized.id ||
        document.slug === normalized.slug,
    );
    if (!located) {
      throw new ContractError(
        "Document is readable but its full catalog path could not be resolved",
      );
    }
    return { ...normalized, location: located.position };
  }

  async getExportOptions(
    employeeId: string,
    docUrl: string,
  ): Promise<YuqueExportOptions> {
    const target = await this.resolveExportTarget(employeeId, docUrl);
    return {
      targetType: target.targetType,
      sourceFormat: target.sourceFormat,
      availableFormats: EXPORT_OPTIONS[target.targetType].map((option) => ({
        ...option,
      })),
      document: target.document,
    };
  }

  async createExportLink(
    employeeId: string,
    docUrl: string,
    format: YuqueExportFormat,
  ): Promise<YuqueExportLink> {
    if (!YUQUE_EXPORT_FORMATS.includes(format)) {
      throw new Error(
        "format must be word, markdown, pdf, lake, jpg, excel or lakesheet",
      );
    }
    const target = await this.resolveExportTarget(employeeId, docUrl);
    const option = EXPORT_OPTIONS[target.targetType].find(
      (candidate) => candidate.format === format,
    );
    if (!option) {
      throw new ContractError(
        `${target.targetType} cannot be exported as ${format}; call yuque_get_export_options and let the user choose an available format`,
      );
    }
    const requestBody: Record<string, unknown> = {
      type: format,
      force: 0,
    };
    if (format === "markdown") {
      requestBody.options = JSON.stringify({ latexType: 1, useMdai: 1 });
    } else if (format === "pdf") {
      requestBody.options = JSON.stringify({ enableToc: 1 });
    }

    let exportResponse: Record<string, unknown> | undefined;
    let pollRequests = 0;
    while (pollRequests < EXPORT_MAX_POLL_REQUESTS) {
      pollRequests += 1;
      const response = asRecord(
        await this.request(employeeId, "create_doc_export", {
          pathParams: { docId: target.document.id },
          body: requestBody,
          referer: target.document.url,
          baseHost: target.book.host,
        }),
        "Document export response",
      );
      const state = requireStringValue(response, "state");
      if (state === "success") {
        exportResponse = response;
        break;
      }
      if (state === "error") {
        throw new ContractError("Yuque rejected the requested export");
      }
      if (pollRequests < EXPORT_MAX_POLL_REQUESTS) {
        await this.exportPollDelay(EXPORT_POLL_INTERVAL_MS);
      }
    }
    if (!exportResponse) {
      throw new ContractError(
        "Yuque export is still processing after two minutes; no file was downloaded and the request was not forced or restarted",
      );
    }
    const rawUrl = requireStringValue(exportResponse, "url");
    if (!rawUrl) {
      throw new ContractError("Yuque export response contains an empty URL");
    }
    const delivery = validateExportUrl({
      rawUrl,
      format,
      targetType: target.targetType,
      documentOrigin: target.locator.origin,
      ownerSlug: target.locator.groupSlug,
      bookSlug: target.locator.bookSlug,
      docSlug: target.docSlug,
    });
    return {
      targetType: target.targetType,
      format,
      filename: safeExportFilename(target.document.title, option.extension),
      downloadUrl: delivery.url,
      ...(delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}),
      browserLoginRequired: delivery.browserLoginRequired,
      deliveryHost: delivery.host,
      pollRequests,
      document: target.document,
    };
  }

  private async resolveExportTarget(employeeId: string, docUrl: string) {
    const locator = parseYuqueUrl(docUrl, this.allowedYuqueHosts());
    if (!locator.docSlug) {
      throw new Error("doc_url must include a document slug");
    }
    const book = await this.resolveBook(employeeId, docUrl);
    const detail = asRecord(
      await this.request(employeeId, "get_doc", {
        pathParams: { docSlug: locator.docSlug },
        query: {
          book_id: book.id,
          include_contributors: true,
          include_like: true,
          include_hits: true,
          merge_dynamic_data: false,
        },
        baseHost: book.host,
      }),
      "Export target document",
    );
    const id = String(requireNumber(detail, "id"));
    const title = requireStringValue(detail, "title");
    const slug = requireStringValue(detail, "slug");
    const rawType = detail.type;
    if (
      (rawType !== "Doc" && rawType !== "Sheet") ||
      (rawType === "Doc" && detail.format === "lakesheet") ||
      (rawType === "Sheet" && detail.format !== "lakesheet") ||
      requireNumber(detail, "book_id") !== book.id ||
      slug !== locator.docSlug
    ) {
      throw new ContractError(
        "Native export currently supports only the requested ordinary Doc or LakeSheet",
      );
    }
    const targetType: YuqueExportTargetType = rawType;
    const abilities = asRecord(detail.abilities, "Document abilities");
    if (abilities.export !== true) {
      throw new ContractError(
        "The current Yuque account is not allowed to export this document",
      );
    }
    const nodes = await this.loadCatalog(employeeId, book);
    const located = catalogDocuments(book, nodes).find(
      (document) => String(document.id) === id || document.slug === slug,
    );
    if (!located) {
      throw new ContractError(
        "Document is exportable but its full catalog path could not be resolved",
      );
    }
    return {
      targetType,
      sourceFormat: requireStringValue(detail, "format"),
      docSlug: locator.docSlug,
      locator,
      book,
      document: {
        id,
        title,
        url: located.url,
        bookUrl: book.url,
        displayPath: located.position.displayPath,
        fullPath: located.position.fullPath,
      },
    };
  }

  async getDocEditorDraft(
    employeeId: string,
    docUrl: string,
  ): Promise<NormalizedDocEditorDraft> {
    const locator = parseYuqueUrl(docUrl, this.allowedYuqueHosts());
    if (!locator.docSlug)
      throw new Error("doc_url must include a document slug");
    const book = await this.resolveBook(employeeId, docUrl);
    const detail = asRecord(
      await this.request(employeeId, "get_doc_editor", {
        pathParams: { docSlug: locator.docSlug },
        query: {
          book_id: book.id,
          mode: "edit",
          merge_dynamic_data: false,
          include_contributors: true,
          include_like: true,
          include_hits: true,
        },
        referer: `${docUrl.replace(/\/$/, "")}/edit`,
        baseHost: book.host,
      }),
      "Doc editor detail",
    );
    if (detail.format !== "lake" || detail.type !== "Doc") {
      throw new ContractError("Target is not a Doc/lake editor draft");
    }
    const id = String(requireNumber(detail, "id"));
    const slug = requireStringValue(detail, "slug");
    const title = requireStringValue(detail, "title");
    const bookId = requireNumber(detail, "book_id");
    const version = requireNumber(detail, "draft_version");
    if (bookId !== book.id)
      throw new ContractError("Doc editor response belongs to another book");
    const publishedAsl = requireStringValue(detail, "body_asl");
    const draftAsl = requireStringValue(detail, "body_draft_asl");
    const publishedHtml = requireStringValue(detail, "body");
    const draftHtml = requireStringValue(detail, "body_draft");
    const nodes = await this.loadCatalog(employeeId, book);
    const located = catalogDocuments(book, nodes).find(
      (document) => String(document.id) === id || document.slug === slug,
    );
    if (!located) {
      throw new ContractError(
        "Doc editor draft is readable but its full catalog path could not be resolved",
      );
    }
    const updatedAt = optionalStringValue(detail.updated_at);
    return {
      id,
      slug,
      title,
      bookId,
      bookUrl: book.url,
      format: "lake",
      version,
      ...(updatedAt ? { updatedAt } : {}),
      url: docUrl.replace(/\/$/, "").replace(/\/edit$/, ""),
      location: located.position,
      publishedAsl,
      draftAsl,
      publishedHtml,
      draftHtml,
      fingerprint: fingerprint({
        id,
        title,
        version,
        publishedAsl,
        draftAsl,
        publishedHtml,
        draftHtml,
        updatedAt,
      }),
    };
  }

  async getResourceLockState(
    employeeId: string,
    input: { docId: string; docUrl: string },
  ): Promise<ResourceLockState> {
    const locator = parseYuqueUrl(input.docUrl, this.allowedYuqueHosts());
    const raw = asRecord(
      await this.request(employeeId, "get_doc_lock", {
        pathParams: { docId: input.docId },
        query: { uuid: this.docLockClientUuid },
        referer: `${input.docUrl.replace(/\/$/, "").replace(/\/edit$/, "")}/edit`,
        baseHost: locator.origin,
      }),
      "Doc lock response",
    );
    const doc = asRecord(raw.doc, "Doc lock state");
    const collaborators = doc.collab_members;
    if (!Array.isArray(collaborators)) {
      throw new ContractError("Doc lock collaborators are not an array");
    }
    if (
      !("locker" in doc) ||
      (doc.locker !== null &&
        (!doc.locker ||
          typeof doc.locker !== "object" ||
          Array.isArray(doc.locker)))
    ) {
      throw new ContractError("Doc lock holder has an unexpected shape");
    }
    const locker = doc.locker as Record<string, unknown> | null;
    return {
      draftVersion: requireNumber(doc, "draft_version"),
      lockerPresent: locker !== null,
      collaboratorCount: collaborators.length,
      ...(locker !== null
        ? { ownedByClient: locker.uuid === this.docLockClientUuid }
        : {}),
    };
  }

  async acquireResourceLock(
    employeeId: string,
    input: { docId: string; docUrl: string },
  ): Promise<ResourceLockState> {
    const locator = parseYuqueUrl(input.docUrl, this.allowedYuqueHosts());
    try {
      await this.request(employeeId, "acquire_doc_lock", {
        pathParams: { docId: input.docId },
        body: { uuid: this.docLockClientUuid },
        referer: `${input.docUrl.replace(/\/$/, "").replace(/\/edit$/, "")}/edit`,
        baseHost: locator.origin,
      });
      return this.getResourceLockState(employeeId, input);
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      const reconciled = await this.getResourceLockState(
        employeeId,
        input,
      ).catch(() => undefined);
      if (!reconciled?.ownedByClient) throw error;
      return { ...reconciled, reconciledAfterUnknownResponse: true };
    }
  }

  async releaseResourceLock(
    employeeId: string,
    input: { docId: string; docUrl: string },
  ): Promise<void> {
    const locator = parseYuqueUrl(input.docUrl, this.allowedYuqueHosts());
    try {
      await this.request(employeeId, "release_doc_lock", {
        pathParams: { docId: input.docId },
        body: { uuid: this.docLockClientUuid },
        referer: `${input.docUrl.replace(/\/$/, "").replace(/\/edit$/, "")}/edit`,
        baseHost: locator.origin,
      });
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      const reconciled = await this.getResourceLockState(
        employeeId,
        input,
      ).catch(() => undefined);
      if (!reconciled || reconciled.ownedByClient === true) throw error;
    }
  }

  async getSheet(
    employeeId: string,
    docUrl: string,
  ): Promise<NormalizedSheetDocument> {
    const locator = parseYuqueUrl(docUrl, this.allowedYuqueHosts());
    if (!locator.docSlug)
      throw new Error("doc_url must include a document slug");
    const book = await this.resolveBook(employeeId, docUrl);
    const detail = asRecord(
      await this.request(employeeId, "get_sheet", {
        pathParams: { docSlug: locator.docSlug },
        query: {
          book_id: book.id,
          mode: "edit",
          forceLocal: false,
          include_contributors: true,
          include_like: true,
          include_hits: true,
          merge_dynamic_data: false,
        },
        referer: `${docUrl.replace(/\/$/, "")}/edit`,
        baseHost: book.host,
      }),
      "LakeSheet detail",
    );
    if (detail.format !== "lakesheet" || detail.type !== "Sheet") {
      throw new ContractError("Target is not an independent Sheet/lakesheet");
    }
    const id = String(requireNumber(detail, "id"));
    const slug = requireStringValue(detail, "slug");
    const title = requireStringValue(detail, "title");
    const version = requireNumber(detail, "draft_version");
    const bodyDraft = requireStringValue(detail, "body_draft");
    const nodes = await this.loadCatalog(employeeId, book);
    const located = catalogDocuments(book, nodes).find(
      (document) => String(document.id) === id || document.slug === slug,
    );
    if (!located) {
      throw new ContractError(
        "Sheet is readable but its full catalog path could not be resolved",
      );
    }
    const decoded = decodeLakeSheetDraft({
      id,
      title,
      draftVersion: version,
      bodyDraft,
    });
    return {
      id,
      slug,
      title,
      format: "lakesheet",
      bookId: book.id,
      bookUrl: book.url,
      version,
      ...(optionalStringValue(detail.updated_at)
        ? { updatedAt: optionalStringValue(detail.updated_at) }
        : {}),
      url: docUrl.replace(/\/$/, "").replace(/\/edit$/, ""),
      location: located.position,
      workbook: decoded.workbook,
      bodyDraft,
      unsupportedFeatures: decoded.unsupportedFeatures,
      chartSummaries: decoded.chartSummaries,
    };
  }

  async convertMarkdown(
    employeeId: string,
    markdown: string,
    targetUrl?: string,
  ): Promise<unknown> {
    const baseHost = targetUrl
      ? parseYuqueUrl(targetUrl, this.allowedYuqueHosts()).origin
      : this.config.yuqueHost;
    return this.request(employeeId, "convert_markdown", {
      body: { content: markdown, from: "markdown", to: "lake" },
      baseHost,
    });
  }

  async convertMarkdownToLake(
    employeeId: string,
    markdown: string,
    targetUrl?: string,
  ): Promise<string> {
    return extractConvertedLake(
      await this.convertMarkdown(employeeId, markdown, targetUrl),
    );
  }

  assertDocCreateEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "create_doc",
      this.contractHostTypeForTarget(targetUrl),
    );
  }

  assertDocContentUpdateEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    const hostType = this.contractHostTypeForTarget(targetUrl);
    this.contracts.getWritable("save_doc_content", hostType);
    this.contracts.getWritable("publish_doc", hostType);
  }

  assertDocNativeDraftSaveEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "save_doc_content",
      this.contractHostTypeForTarget(targetUrl),
    );
  }

  assertDocPublishEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "publish_doc",
      this.contractHostTypeForTarget(targetUrl),
    );
  }

  assertDocRenameEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "update_doc_meta",
      this.contractHostTypeForTarget(targetUrl),
    );
  }

  assertSheetCreateEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "create_sheet",
      this.contractHostTypeForTarget(targetUrl),
    );
  }

  assertSheetInitializeEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "initialize_sheet",
      this.contractHostTypeForTarget(targetUrl),
    );
  }

  assertSheetUpdateEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "save_sheet_content",
      this.contractHostTypeForTarget(targetUrl),
    );
  }

  assertBookCreateEnabled(): void {
    this.contracts.getWritable("create_book", "personal");
  }

  assertBookUpdateEnabled(targetUrl: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable("update_book", "personal");
  }

  async preparePersonalBookCreate(
    employeeId: string,
    name: string,
  ): Promise<PreparedBookCreate> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("Knowledge-base name is required");
    if (normalizedName.length > 100) {
      throw new Error("Knowledge-base name must not exceed 100 characters");
    }
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const existing = await this.listAllBooks(employeeId, "personal");
    if (existing.some((book) => book.name === normalizedName)) {
      throw new ContractError(
        "A personal knowledge base with the same name already exists",
      );
    }
    const ownerName = session.account.name?.trim() || session.account.login;
    return {
      name: normalizedName,
      ownerLogin: session.account.login,
      displayPath: `个人：${ownerName} / ${normalizedName}`,
      dashboardUrl: `${this.config.personalYuqueHost}/dashboard`,
    };
  }

  async createPersonalBook(
    employeeId: string,
    input: { name: string; description?: string },
  ): Promise<CreatedBookResult> {
    this.assertBookCreateEnabled();
    const prepared = await this.preparePersonalBookCreate(
      employeeId,
      input.name,
    );
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const numericUserId = Number(session.account.id);
    if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
      throw new ContractError("Bound personal account ID is not numeric");
    }
    let created: Record<string, unknown> | undefined;
    let reconciledAfterUnknownResponse = false;
    try {
      created = asRecord(
        await this.request(employeeId, "create_book", {
          body: {
            description: input.description?.trim() || "",
            extend_private: 0,
            name: prepared.name,
            public: 0,
            type: "Book",
            user_id: numericUserId,
          },
          baseHost: this.config.personalYuqueHost,
          referer: prepared.dashboardUrl,
        }),
        "Created knowledge-base response",
      );
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      const reconciled = await this.findCreatedPersonalBook(
        employeeId,
        prepared.name,
      );
      if (!reconciled) throw new CreateResultUnknownError("KnowledgeBase");
      created = reconciled;
      reconciledAfterUnknownResponse = true;
    }
    const createdId = requireNumber(created, "id");
    const createdSlug = requireStringValue(created, "slug");
    if (
      created.name !== prepared.name ||
      created.type !== "Book" ||
      created.public !== 0 ||
      created.extend_private !== 0 ||
      created.organization_id !== 0 ||
      created.user_id !== numericUserId
    ) {
      throw new ContractError(
        "Created knowledge-base response does not match the private personal target",
      );
    }
    const verified = await this.findCreatedPersonalBook(
      employeeId,
      prepared.name,
      createdId,
    );
    if (!verified) {
      throw new ContractError(
        "Created knowledge base could not be verified by personal list read-back",
      );
    }
    const owner = asRecord(verified.user, "Knowledge-base owner");
    if (
      verified.slug !== createdSlug ||
      verified.public !== 0 ||
      verified.extend_private !== 0 ||
      verified.organization_id !== 0 ||
      verified.type !== "Book" ||
      verified.items_count !== 0 ||
      owner.login !== prepared.ownerLogin
    ) {
      throw new ContractError(
        "Created knowledge-base read-back does not match the private personal target",
      );
    }
    return {
      status: "created",
      id: String(createdId),
      slug: createdSlug,
      name: prepared.name,
      bookUrl: `${this.config.personalYuqueHost}/${encodeURIComponent(prepared.ownerLogin)}/${encodeURIComponent(createdSlug)}`,
      displayPath: prepared.displayPath,
      private: true,
      reconciledAfterUnknownResponse,
    };
  }

  async preparePersonalBookUpdate(
    employeeId: string,
    input: { bookUrl: string; name?: string; description?: string },
  ): Promise<PreparedBookUpdate> {
    this.assertWriteTargetAllowed(input.bookUrl);
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const book = await this.resolveBook(employeeId, input.bookUrl);
    if (
      book.scopeType !== "personal" ||
      book.ownerLogin !== session.account.login ||
      book.accessType !== "owner" ||
      !book.private
    ) {
      throw new ContractError(
        "Knowledge-base update is verified only for a private personal knowledge base owned by the current account",
      );
    }
    const name = input.name?.trim() ?? book.name;
    const description = input.description?.trim() ?? book.description;
    if (!name) throw new Error("Knowledge-base name is required");
    if (name.length > 100) {
      throw new Error("Knowledge-base name must not exceed 100 characters");
    }
    if (description.length > 2_000) {
      throw new Error(
        "Knowledge-base description must not exceed 2000 characters",
      );
    }
    if (name === book.name && description === book.description) {
      throw new Error("Knowledge-base update does not change any field");
    }
    if (name !== book.name) {
      const books = await this.listAllBooks(employeeId, "personal");
      if (
        books.some(
          (candidate) => candidate.id !== book.id && candidate.name === name,
        )
      ) {
        throw new ContractError(
          "A personal knowledge base with the same name already exists",
        );
      }
    }
    return {
      book,
      name,
      description,
      baselineFingerprint: bookFingerprint(book),
      displayPath: `${book.scopeLabel} / ${book.name}`,
    };
  }

  async updatePersonalBook(
    employeeId: string,
    input: {
      bookUrl: string;
      name: string;
      description: string;
      baselineFingerprint: string;
    },
  ): Promise<UpdatedBookResult> {
    this.assertBookUpdateEnabled(input.bookUrl);
    const prepared = await this.preparePersonalBookUpdate(employeeId, input);
    if (prepared.baselineFingerprint !== input.baselineFingerprint) {
      throw new ContractError(
        "Knowledge base changed after Preview; no write was attempted",
      );
    }
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();
    const body: Record<string, string> = {};
    if (prepared.name !== prepared.book.name) body.name = prepared.name;
    if (prepared.description !== prepared.book.description) {
      body.description = prepared.description;
    }
    let reconciledAfterUnknownResponse = false;
    try {
      const updated = asRecord(
        await this.request(employeeId, "update_book", {
          pathParams: { bookId: prepared.book.id },
          body,
          baseHost: prepared.book.host,
          referer: prepared.book.url,
        }),
        "Updated knowledge-base response",
      );
      if (
        updated.id !== prepared.book.id ||
        updated.name !== prepared.name ||
        updated.description !== prepared.description ||
        updated.slug !== prepared.book.slug ||
        updated.user_id !== Number(session.account.id) ||
        updated.organization_id !== 0 ||
        updated.public !== 0
      ) {
        throw new ContractError(
          "Updated knowledge-base response does not match the Preview",
        );
      }
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      const reconciled = await this.resolveBook(employeeId, input.bookUrl);
      if (
        reconciled.name !== prepared.name ||
        reconciled.description !== prepared.description
      ) {
        throw error;
      }
      reconciledAfterUnknownResponse = true;
    }
    const verified = await this.resolveBook(employeeId, input.bookUrl);
    if (
      verified.id !== prepared.book.id ||
      verified.name !== prepared.name ||
      verified.description !== prepared.description ||
      verified.slug !== prepared.book.slug ||
      verified.ownerLogin !== session.account.login ||
      !verified.private
    ) {
      throw new ContractError(
        "Updated knowledge-base list read-back does not match the Preview",
      );
    }
    return {
      status: "updated",
      id: String(verified.id),
      name: verified.name,
      description: verified.description,
      bookUrl: verified.url,
      displayPath: `${verified.scopeLabel} / ${verified.name}`,
      fingerprint: bookFingerprint(verified),
      reconciledAfterUnknownResponse,
    };
  }

  async prepareBookDeletion(
    employeeId: string,
    input: { bookUrl: string; allowNonempty: boolean },
  ): Promise<PreparedBookDeletion> {
    this.assertWriteTargetAllowed(input.bookUrl);
    if (this.contractHostTypeForTarget(input.bookUrl) !== "personal") {
      throw new ContractError(
        "Knowledge-base deletion is verified only for the personal Yuque Host",
      );
    }
    const book = await this.getBook(employeeId, input.bookUrl);
    if (
      book.scopeType !== "personal" ||
      book.accessType !== "owner" ||
      book.ownerLogin !== book.groupLogin ||
      !book.private
    ) {
      throw new ContractError(
        "Knowledge-base deletion is restricted to an owned private personal knowledge base",
      );
    }
    const toc = await this.getToc(employeeId, book.url);
    if (toc.nodes.length > 0 && !input.allowNonempty) {
      throw new Error(
        "The knowledge base is non-empty; review its full catalog and preview again with allow_nonempty=true",
      );
    }
    return {
      book,
      catalog: toc.nodes,
      displayPath: `${book.scopeLabel} / ${book.name}`,
      baseFingerprint: fingerprint({
        operation: "delete_book",
        book: bookFingerprint(book),
        catalog: catalogFingerprint(toc.nodes),
      }),
      allowNonempty: input.allowNonempty,
    };
  }

  async deleteBook(
    employeeId: string,
    input: {
      bookUrl: string;
      allowNonempty: boolean;
      baselineFingerprint: string;
    },
  ): Promise<DeletedBookResult> {
    this.assertWriteTargetAllowed(input.bookUrl);
    this.contracts.getWritable("delete_book", "personal");
    const prepared = await this.prepareBookDeletion(employeeId, input);
    if (prepared.baseFingerprint !== input.baselineFingerprint) {
      throw new ContractError(
        "The knowledge base or its catalog changed after Preview; no deletion request was sent",
      );
    }
    let reconciledAfterUnknownResponse = false;
    let uncertainError: unknown;
    try {
      const envelope = asRecord(
        await this.request(employeeId, "delete_book", {
          pathParams: { bookId: prepared.book.id },
          baseHost: prepared.book.host,
          referer: `${prepared.book.url}/settings/advanced`,
          returnEnvelope: true,
        }),
        "Knowledge-base deletion response",
      );
      const deleted = asRecord(envelope.data, "Deleted knowledge base");
      if (
        String(requireNumber(deleted, "id")) !== String(prepared.book.id) ||
        requireStringValue(deleted, "slug") !== prepared.book.slug ||
        requireStringValue(deleted, "name") !== prepared.book.name ||
        requireStringValue(deleted, "type") !== "Book" ||
        requireNumber(deleted, "organization_id") !== 0 ||
        requireNumber(deleted, "public") !== 0
      ) {
        throw new ContractError(
          "Knowledge-base deletion response does not match the prepared target",
        );
      }
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      reconciledAfterUnknownResponse = true;
      uncertainError = error;
    }

    const books = await this.listAllBooks(employeeId, "personal");
    const listAbsent = !books.some(
      (book) =>
        book.id === prepared.book.id ||
        book.url === prepared.book.url ||
        (book.ownerLogin === prepared.book.ownerLogin &&
          book.slug === prepared.book.slug),
    );
    let directReadRejected = false;
    try {
      await this.getBook(employeeId, prepared.book.url);
    } catch {
      directReadRejected = true;
    }
    if (!listAbsent || !directReadRejected) {
      if (uncertainError) throw uncertainError;
      const error = new Error(
        "Knowledge-base deletion result is unknown after read-back; do not retry",
      );
      error.name = "DeletionResultUnknownError";
      throw error;
    }
    return {
      status: "deleted",
      deletion_effect: "irreversible_book_removal",
      deleted_path: prepared.displayPath,
      book_url: prepared.book.url,
      book_id: String(prepared.book.id),
      deleted_catalog_nodes: prepared.catalog.length,
      list_absent: true,
      direct_read_rejected: true,
      reconciled_after_unknown_response: reconciledAfterUnknownResponse,
    };
  }

  async createDoc(
    employeeId: string,
    input: {
      bookUrl: string;
      title: string;
      slug: string;
      convertedLake: string;
      parentUuid?: string;
      expectedParentPath?: string;
    },
  ): Promise<CreatedDocResult> {
    this.assertDocCreateEnabled(input.bookUrl);
    const target = await this.prepareCreateTarget(employeeId, input);
    const bodyHtml = await this.lakeHtml.render(input.convertedLake);
    let created: Record<string, unknown> | undefined;
    let reconciledAfterUnknownResponse = false;
    try {
      created = asRecord(
        await this.request(employeeId, "create_doc", {
          body: {
            action: "prependChild",
            body: bodyHtml,
            body_draft: bodyHtml,
            body_asl: input.convertedLake,
            body_draft_asl: input.convertedLake,
            book_id: target.book.id,
            format: "lake",
            insert_to_catalog: true,
            slug: target.slug,
            status: 1,
            title: target.title,
            type: "Doc",
            target_uuid: target.parentUuid ?? "",
          },
          referer: target.book.url,
          baseHost: target.book.host,
        }),
        "Created Doc response",
      );
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      const reconciled = await this.findCreatedObject(employeeId, target);
      if (!reconciled) throw new CreateResultUnknownError("Doc");
      created = reconciled.detail;
      reconciledAfterUnknownResponse = true;
    }
    const createdId = String(requireNumber(created, "id"));
    const createdSlug = requireStringValue(created, "slug");
    const createdTitle = requireStringValue(created, "title");
    const createdBookId = requireNumber(created, "book_id");
    if (
      createdSlug !== target.slug ||
      createdTitle !== target.title ||
      createdBookId !== target.book.id ||
      created.format !== "lake" ||
      created.type !== "Doc"
    ) {
      throw new ContractError(
        "Created Doc response does not match the prepared target",
      );
    }

    const located = await this.findCreatedObject(employeeId, target);
    if (!located?.catalogNode) {
      return {
        status: "partial_created_unmounted",
        id: createdId,
        slug: createdSlug,
        title: createdTitle,
        docUrl: target.targetUrl,
        catalogMounted: false,
        reconciledAfterUnknownResponse,
      };
    }
    this.invalidateDocumentIndex(employeeId);
    let verified: NormalizedDoc;
    try {
      verified = await this.getDoc(employeeId, target.targetUrl);
      if (
        verified.id !== createdId ||
        verified.title !== target.title ||
        verified.slug !== target.slug ||
        verified.lakeContent !== input.convertedLake
      ) {
        throw new ContractError(
          "Created Doc read-back does not match the prepared title, slug or Lake body",
        );
      }
    } catch {
      return {
        status: "partial_created_unverified",
        id: createdId,
        slug: createdSlug,
        title: createdTitle,
        docUrl: target.targetUrl,
        displayPath: located.catalogNode.displayPath,
        catalogMounted: true,
        reconciledAfterUnknownResponse,
      };
    }
    return {
      status: "created",
      id: createdId,
      slug: createdSlug,
      title: createdTitle,
      docUrl: target.targetUrl,
      displayPath: verified.location.displayPath,
      version: verified.version,
      fingerprint: verified.fingerprint,
      catalogMounted: true,
      reconciledAfterUnknownResponse,
    };
  }

  async updateDoc(
    employeeId: string,
    input: { docUrl: string; markdown: string; title?: string },
  ): Promise<unknown> {
    void input.markdown;
    throw new ContractError(
      "The legacy high-level Doc update contract is disabled; use the verified Lake patch pipeline",
    );
  }

  async renameDoc(
    employeeId: string,
    input: { docId: string; title: string; referer: string },
  ): Promise<unknown> {
    this.assertDocRenameEnabled(input.referer);
    return this.request(employeeId, "update_doc_meta", {
      pathParams: { docId: input.docId },
      body: { title: input.title },
      referer: input.referer,
      baseHost: parseYuqueUrl(input.referer, this.allowedYuqueHosts()).origin,
    });
  }

  async updateDocLake(
    employeeId: string,
    input: {
      docId: string;
      draftVersion: number;
      lakeContent: string;
      referer: string;
    },
  ): Promise<{
    response: unknown;
    bodyHtml: string;
    reconciledAfterUnknownResponse: boolean;
  }> {
    this.assertDocContentUpdateEnabled(input.referer);
    const bodyHtml = await this.lakeHtml.render(input.lakeContent);
    try {
      const response = await this.updateDocNativeDraft(employeeId, {
        docId: input.docId,
        draftVersion: input.draftVersion,
        bodyAsl: input.lakeContent,
        bodyHtml,
        referer: input.referer,
      });
      return {
        response,
        bodyHtml,
        reconciledAfterUnknownResponse: false,
      };
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      const reconciled = await this.getDocEditorDraft(
        employeeId,
        input.referer.replace(/\/edit$/, ""),
      ).catch(() => undefined);
      if (
        !reconciled ||
        reconciled.draftAsl !== input.lakeContent ||
        reconciled.draftHtml !== bodyHtml
      ) {
        throw error;
      }
      return {
        response: {},
        bodyHtml,
        reconciledAfterUnknownResponse: true,
      };
    }
  }

  async updateDocNativeDraft(
    employeeId: string,
    input: {
      docId: string;
      draftVersion: number;
      bodyAsl: string;
      bodyHtml: string;
      referer: string;
    },
  ): Promise<unknown> {
    this.assertDocNativeDraftSaveEnabled(input.referer);
    return this.request(employeeId, "save_doc_content", {
      pathParams: { docId: input.docId },
      body: {
        body_asl: input.bodyAsl,
        body_html: input.bodyHtml,
        created_by: "online",
        draft_version: input.draftVersion,
        edit_type: "Lake",
        format: "lake",
        save_type: "user",
        sync_dynamic_data: false,
        target_uuid: null,
      },
      referer: input.referer,
      baseHost: parseYuqueUrl(input.referer, this.allowedYuqueHosts()).origin,
    });
  }

  async publishDoc(
    employeeId: string,
    input: { docId: string; referer: string },
  ): Promise<unknown> {
    this.assertDocPublishEnabled(input.referer);
    return this.request(employeeId, "publish_doc", {
      pathParams: { docId: input.docId },
      body: {
        cover: null,
        force: false,
        notify: false,
        ignoreGlobalMessage: true,
      },
      referer: input.referer,
      baseHost: parseYuqueUrl(input.referer, this.allowedYuqueHosts()).origin,
    });
  }

  async createSheet(
    employeeId: string,
    input: {
      bookUrl: string;
      title: string;
      slug: string;
      parentUuid?: string;
      expectedParentPath?: string;
      worksheets: unknown[];
    },
  ): Promise<CreatedSheetResult> {
    this.assertSheetCreateEnabled(input.bookUrl);
    const initialization =
      input.worksheets.length > 0
        ? validateSheetOperations(input.worksheets)
        : [];
    if (
      initialization.length > 0 &&
      (initialization.length !== 1 || initialization[0]?.op !== "add_worksheet")
    ) {
      throw new ContractError(
        "A new Sheet may initialize exactly one verified native worksheet; additional worksheets require a separately verified template",
      );
    }
    const target = await this.prepareCreateTarget(employeeId, input);
    let created: Record<string, unknown> | undefined;
    let reconciledAfterUnknownResponse = false;
    try {
      created = asRecord(
        await this.request(employeeId, "create_sheet", {
          body: {
            action: "prependChild",
            body_draft_asl: null,
            book_id: target.book.id,
            format: "lakesheet",
            insert_to_catalog: true,
            slug: target.slug,
            status: 1,
            title: target.title,
            type: "Sheet",
            ...(target.parentUuid ? { target_uuid: target.parentUuid } : {}),
          },
          referer: target.book.url,
          baseHost: target.book.host,
        }),
        "Created Sheet response",
      );
    } catch (error) {
      if (!isUncertainNetworkError(error)) throw error;
      const reconciled = await this.findCreatedObject(employeeId, target);
      if (!reconciled) throw new CreateResultUnknownError("Sheet");
      created = reconciled.detail;
      reconciledAfterUnknownResponse = true;
    }
    const createdId = String(requireNumber(created, "id"));
    const createdSlug = requireStringValue(created, "slug");
    const createdTitle = requireStringValue(created, "title");
    const createdBookId = requireNumber(created, "book_id");
    if (
      createdSlug !== target.slug ||
      createdTitle !== target.title ||
      createdBookId !== target.book.id ||
      created.format !== "lakesheet" ||
      created.type !== "Sheet"
    ) {
      throw new ContractError(
        "Created Sheet response does not match the prepared target",
      );
    }

    const located = await this.findCreatedObject(employeeId, target);
    if (!located?.catalogNode) {
      return {
        status: "partial_created_unmounted",
        id: createdId,
        slug: createdSlug,
        title: createdTitle,
        sheetUrl: target.targetUrl,
        catalogMounted: false,
        reconciledAfterUnknownResponse,
      };
    }
    this.invalidateDocumentIndex(employeeId);
    let verified: NormalizedSheetDocument;
    try {
      verified = await this.getSheet(employeeId, target.targetUrl);
      if (
        verified.id !== createdId ||
        verified.title !== target.title ||
        verified.slug !== target.slug
      ) {
        throw new ContractError(
          "Created Sheet read-back does not match the prepared title or slug",
        );
      }
    } catch {
      return {
        status: "partial_created_unverified",
        id: createdId,
        slug: createdSlug,
        title: createdTitle,
        sheetUrl: target.targetUrl,
        displayPath: located.catalogNode.displayPath,
        catalogMounted: true,
        reconciledAfterUnknownResponse,
      };
    }
    if (initialization.length > 0) {
      const applied = applySheetOperations(verified.workbook, initialization);
      let encoded: ReturnType<typeof encodeLakeSheetDraft>;
      try {
        encoded = encodeLakeSheetDraft({
          id: verified.id,
          title: verified.title,
          draftVersion: verified.version,
          bodyDraft: verified.bodyDraft,
          workbook: applied.workbook,
        });
      } catch {
        return partialUninitializedSheetResult({
          createdId,
          createdSlug,
          createdTitle,
          targetUrl: target.targetUrl,
          displayPath: located.catalogNode.displayPath,
          reconciledAfterUnknownResponse,
        });
      }
      try {
        await this.initializeSheetDraft(employeeId, {
          docId: verified.id,
          draftVersion: verified.version,
          bodyDraft: encoded.bodyDraft,
          referer: `${target.targetUrl}/edit`,
        });
      } catch {
        const reconciled = await this.getSheet(
          employeeId,
          target.targetUrl,
        ).catch(() => undefined);
        if (
          !reconciled ||
          workbookCellFingerprint(reconciled.workbook) !==
            workbookCellFingerprint(encoded.workbook)
        ) {
          return partialUninitializedSheetResult({
            createdId,
            createdSlug,
            createdTitle,
            targetUrl: target.targetUrl,
            displayPath: located.catalogNode.displayPath,
            reconciledAfterUnknownResponse,
          });
        }
        verified = reconciled;
        reconciledAfterUnknownResponse = true;
      }
      if (
        workbookCellFingerprint(verified.workbook) !==
        workbookCellFingerprint(encoded.workbook)
      ) {
        verified = await this.getSheet(employeeId, target.targetUrl);
      }
      if (
        workbookCellFingerprint(verified.workbook) !==
        workbookCellFingerprint(encoded.workbook)
      ) {
        return partialUninitializedSheetResult({
          createdId,
          createdSlug,
          createdTitle,
          targetUrl: target.targetUrl,
          displayPath: located.catalogNode.displayPath,
          reconciledAfterUnknownResponse,
        });
      }
    }
    return {
      status: "created",
      id: createdId,
      slug: createdSlug,
      title: createdTitle,
      sheetUrl: target.targetUrl,
      displayPath: verified.location.displayPath,
      version: verified.version,
      fingerprint: verified.workbook.fingerprint,
      worksheetCount: verified.workbook.worksheets.length,
      catalogMounted: true,
      reconciledAfterUnknownResponse,
    };
  }

  async updateSheetDraft(
    employeeId: string,
    input: {
      docId: string;
      draftVersion: number;
      bodyDraft: string;
      referer: string;
    },
  ): Promise<unknown> {
    this.assertSheetUpdateEnabled(input.referer);
    return this.writeSheetDraft(employeeId, "save_sheet_content", input);
  }

  async initializeSheetDraft(
    employeeId: string,
    input: {
      docId: string;
      draftVersion: number;
      bodyDraft: string;
      referer: string;
    },
  ): Promise<unknown> {
    this.assertSheetInitializeEnabled(input.referer);
    return this.writeSheetDraft(employeeId, "initialize_sheet", input);
  }

  private async writeSheetDraft(
    employeeId: string,
    capability: "initialize_sheet" | "save_sheet_content",
    input: {
      docId: string;
      draftVersion: number;
      bodyDraft: string;
      referer: string;
    },
  ): Promise<unknown> {
    return this.request(employeeId, capability, {
      pathParams: { docId: input.docId },
      body: {
        body_asl: input.bodyDraft,
        body_html: null,
        created_by: "online",
        draft_version: input.draftVersion,
        edit_type: "Lake",
        format: "lakesheet",
        save_type: "user",
        sync_dynamic_data: false,
        target_uuid: null,
      },
      referer: input.referer,
      baseHost: parseYuqueUrl(input.referer, this.allowedYuqueHosts()).origin,
    });
  }

  async logout(employeeId: string): Promise<void> {
    for (const key of this.documentIndexCache.keys()) {
      if (key.startsWith(`${employeeId}:`)) this.documentIndexCache.delete(key);
    }
    await this.sessions.remove(employeeId);
  }

  private invalidateDocumentIndex(employeeId: string): void {
    for (const key of this.documentIndexCache.keys()) {
      if (key.startsWith(`${employeeId}:`)) this.documentIndexCache.delete(key);
    }
  }

  private async findCreatedPersonalBook(
    employeeId: string,
    name: string,
    expectedId?: number,
  ): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await this.request(employeeId, "list_personal_books", {
        query: { limit: 100, offset: 0 },
        baseHost: this.config.personalYuqueHost,
        referer: `${this.config.personalYuqueHost}/dashboard`,
      });
      if (!Array.isArray(raw)) {
        throw new ContractError(
          "Personal knowledge-base response is not an array",
        );
      }
      const matches = raw
        .map((value) => asRecord(value, "Personal knowledge base"))
        .filter(
          (book) =>
            book.name === name &&
            (expectedId === undefined || book.id === expectedId),
        );
      if (matches.length > 1) {
        throw new ContractError(
          "Multiple personal knowledge bases match the prepared name",
        );
      }
      if (matches[0]) return matches[0];
      if (attempt < 2) await delay(150);
    }
    return undefined;
  }

  private async findCreatedObject(
    employeeId: string,
    target: CreateTarget,
  ): Promise<
    | {
        detail: Record<string, unknown>;
        catalogNode?: CatalogNode;
      }
    | undefined
  > {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nodes = await this.loadCatalog(employeeId, target.book);
      const catalogNode = nodes.find(
        (node) =>
          node.type === "DOC" &&
          node.docSlug === target.slug &&
          node.title === target.title &&
          (node.parentUuid ?? "") === (target.parentUuid ?? ""),
      );
      try {
        const detail = asRecord(
          await this.request(employeeId, "get_doc", {
            pathParams: { docSlug: target.slug },
            query: {
              book_id: target.book.id,
              include_contributors: true,
              include_like: true,
              include_hits: true,
              merge_dynamic_data: false,
            },
            baseHost: target.book.host,
          }),
          "Created object detail",
        );
        if (
          detail.slug === target.slug &&
          detail.title === target.title &&
          detail.book_id === target.book.id
        ) {
          return { detail, ...(catalogNode ? { catalogNode } : {}) };
        }
      } catch (error) {
        if (!(error instanceof YuqueHttpError) || error.status !== 404) {
          throw error;
        }
      }
      if (attempt < 2) await delay(150);
    }
    return undefined;
  }

  private async resolveBook(
    employeeId: string,
    value: string,
  ): Promise<NormalizedBook> {
    const locator = parseYuqueUrl(value, this.allowedYuqueHosts());
    const scopeId = classifyYuqueHostType({
      baseHost: locator.origin,
      yuqueHost: this.config.yuqueHost,
      personalYuqueHost: this.config.personalYuqueHost,
      organization: this.config.organization,
    });
    const books = await this.listAllBooks(employeeId, scopeId);
    const book = books.find(
      (candidate) =>
        new URL(candidate.url).origin === locator.origin &&
        candidate.groupLogin === locator.groupSlug &&
        candidate.slug === locator.bookSlug,
    );
    if (!book)
      throw new Error("Knowledge base is not visible to this employee");
    return book;
  }

  private async loadCatalog(
    employeeId: string,
    book: NormalizedBook,
  ): Promise<CatalogNode[]> {
    const raw = await this.request(employeeId, "get_toc", {
      query: { book_id: book.id },
      baseHost: book.host,
    });
    if (!Array.isArray(raw))
      throw new ContractError("Yuque catalog response is not an array");
    return normalizeCatalog(raw, book);
  }

  async request(
    employeeId: string,
    capability: CapabilityName,
    options: RequestOptions = {},
  ): Promise<unknown> {
    return this.withEmployeeQueue(employeeId, () =>
      this.requestUnlocked(employeeId, capability, options),
    );
  }

  private async requestUnlocked(
    employeeId: string,
    capability: CapabilityName,
    options: RequestOptions,
  ): Promise<unknown> {
    const baseHost = options.baseHost ?? this.config.yuqueHost;
    this.assertAllowedYuqueHost(baseHost);
    const contract = this.contracts.get(
      capability,
      this.contractHostTypeForBaseHost(baseHost),
    );
    const session = await this.sessions.load(employeeId);
    if (!session) throw new ReloginRequiredError();

    const jar = CookieJar.deserializeSync(
      session.cookies as SerializedCookieJar,
    );
    const path = interpolatePath(contract.path, options.pathParams ?? {});
    const url = new URL(path, baseHost);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const attempts = contract.idempotent ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetchWithSession(
          url,
          contract.method,
          options.body,
          session,
          jar,
          options.referer,
        );
        const parsed = await parseResponse(response);
        if (isLoginExpired(response, parsed)) throw new ReloginRequiredError();
        if (response.status === 429)
          throw new YuqueHttpError(
            429,
            rateLimitMessage(response),
            retryAfterSeconds(response.headers.get("retry-after")),
          );
        if (!response.ok)
          throw new YuqueHttpError(
            response.status,
            `Yuque web request failed (${response.status})`,
          );
        assertRequiredPaths(parsed, contract.requiredResponsePaths);
        await this.persistJar(
          employeeId,
          session,
          jar,
          url,
          response.headers.get("x-csrf-token") ?? undefined,
        );
        return options.returnEnvelope ? parsed : unwrapData(parsed);
      } catch (error) {
        lastError = error;
        if (
          attempt + 1 >= attempts ||
          error instanceof ContractError ||
          error instanceof ReloginRequiredError ||
          error instanceof YuqueHttpError
        ) {
          if (error instanceof ReloginRequiredError) {
            await this.sessions.remove(employeeId);
          }
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async fetchWithSession(
    url: URL,
    method: string,
    body: unknown,
    session: StoredWebSession,
    jar: CookieJar,
    referer?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: referer || `${url.origin}/`,
      Origin: url.origin,
      Cookie: await jar.getCookieString(url.toString()),
      "x-csrf-token": session.csrfToken,
      "x-login": session.account.login,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit & { dispatcher?: Dispatcher });
      const getSetCookie = (
        response.headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie;
      const cookies = getSetCookie?.call(response.headers) ?? [];
      for (const cookie of cookies) await jar.setCookie(cookie, url.toString());
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async persistJar(
    employeeId: string,
    session: StoredWebSession,
    jar: CookieJar,
    url: URL,
    responseCsrf?: string,
  ): Promise<void> {
    const cookies = await jar.getCookies(url.toString());
    const csrfCookie = cookies.find((cookie) =>
      /(^|_)(csrf|ctoken)/i.test(cookie.key),
    );
    await this.sessions.save(employeeId, {
      ...session,
      cookies: jar.serializeSync(),
      csrfToken: responseCsrf || csrfCookie?.value || session.csrfToken,
      savedAt: new Date().toISOString(),
    });
  }

  private async withEmployeeQueue<T>(
    employeeId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(employeeId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(employeeId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(employeeId) === current)
        this.queues.delete(employeeId);
    }
  }

  private allowedYuqueHosts(): string[] {
    return [this.config.yuqueHost, this.config.personalYuqueHost];
  }

  private assertWriteTargetAllowed(targetUrl?: string): void {
    if (this.config.writeBookAllowlist === undefined) return;
    if (!targetUrl) {
      throw new Error("A full knowledge-base or document URL is required");
    }
    const locator = parseYuqueUrl(targetUrl, this.allowedYuqueHosts());
    const bookUrl = `${locator.origin}/${encodeURIComponent(locator.groupSlug)}/${encodeURIComponent(locator.bookSlug)}`;
    if (!this.config.writeBookAllowlist.includes(bookUrl)) {
      throw new Error(
        "Target knowledge base is not present in YUQUE_WRITE_BOOK_ALLOWLIST",
      );
    }
  }

  private assertAllowedYuqueHost(value: string): void {
    const origin = new URL(value).origin;
    if (
      !this.allowedYuqueHosts().some(
        (candidate) => new URL(candidate).origin === origin,
      )
    ) {
      throw new Error("Yuque URL host is not allowed");
    }
  }

  private contractHostTypeForTarget(
    targetUrl?: string,
  ): "organization" | "personal" {
    if (!targetUrl)
      return this.config.organization ? "organization" : "personal";
    return this.contractHostTypeForBaseHost(
      parseYuqueUrl(targetUrl, this.allowedYuqueHosts()).origin,
    );
  }

  private contractHostTypeForBaseHost(
    baseHost: string,
  ): "organization" | "personal" {
    return classifyYuqueHostType({
      baseHost,
      yuqueHost: this.config.yuqueHost,
      personalYuqueHost: this.config.personalYuqueHost,
      organization: this.config.organization,
    });
  }
}

export function classifyYuqueHostType(input: {
  baseHost: string;
  yuqueHost: string;
  personalYuqueHost: string;
  organization: string;
}): "organization" | "personal" {
  const origin = new URL(input.baseHost).origin;
  const organizationOrigin = new URL(input.yuqueHost).origin;
  const personalOrigin = new URL(input.personalYuqueHost).origin;
  if (
    origin === personalOrigin &&
    (!input.organization || personalOrigin === organizationOrigin)
  )
    return input.organization ? "organization" : "personal";
  if (origin === organizationOrigin) return "organization";
  return "personal";
}

function parseYuqueUrl(
  value: string,
  allowedHosts: string[],
): {
  origin: string;
  groupSlug: string;
  bookSlug: string;
  docSlug?: string;
} {
  const url = new URL(value, allowedHosts[0]);
  if (
    !allowedHosts.some((candidate) => new URL(candidate).origin === url.origin)
  )
    throw new Error("Yuque URL host is not allowed");
  const parts = url.pathname.split("/").filter(Boolean);
  const groupSlug = parts[0];
  const bookSlug = parts[1];
  if (!groupSlug || !bookSlug)
    throw new Error("Yuque URL must include group and book slugs");
  return {
    origin: url.origin,
    groupSlug,
    bookSlug,
    ...(parts[2] ? { docSlug: parts[2] } : {}),
  };
}

class CreateResultUnknownError extends Error {
  constructor(resourceType: "Doc" | "Sheet" | "KnowledgeBase") {
    super(
      `Yuque ${resourceType} creation result is unknown after a network failure; do not retry`,
    );
    this.name = "CreateResultUnknownError";
  }
}

function isUncertainNetworkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error instanceof TypeError ||
      /timeout|timed out|fetch failed|network/i.test(error.message))
  );
}

function assertCreateSlug(value: string): void {
  if (!/^[a-z0-9]{16}$/.test(value)) {
    throw new Error(
      "Prepared Yuque slug must contain 16 lowercase letters or digits",
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return { html: text.slice(0, 256) };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContractError("Yuque returned malformed JSON");
  }
}

function isLoginExpired(response: Response, parsed: unknown): boolean {
  if (response.status === 401) return true;
  const location = response.headers.get("location");
  if (location?.includes("/login")) return true;
  const record =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  return record?.code === "force_redirect_login";
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function rateLimitMessage(response: Response): string {
  const seconds = retryAfterSeconds(response.headers.get("retry-after"));
  return seconds === undefined
    ? "Yuque rate limit reached; retry later"
    : `Yuque rate limit reached; retry after ${seconds} seconds`;
}

function unwrapData(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) {
    return (value as Record<string, unknown>).data;
  }
  return value;
}

function objectDeletionFingerprint(input: {
  resourceType: "Doc" | "Sheet";
  bookId: number;
  nodeUuid: string;
  docId: string;
  title: string;
  version: number;
  contentFingerprint: string;
}): string {
  return fingerprint({
    operation: "delete_object",
    ...input,
  });
}

function normalizeBook(
  value: unknown,
  host: string,
  context: {
    type: YuqueScopeType;
    personalName: string;
    organizationFallback: string;
    accessType?: "owner" | "collaborator";
    collaboratorRole?: "reader" | "editor";
  },
): NormalizedBook {
  const record = asRecord(value, "Knowledge base");
  const user = asRecord(record.user, "Knowledge-base owner");
  const id = requireNumber(record, "id");
  const name = requireStringValue(record, "name");
  const description = optionalStringValue(record.description) ?? "";
  const slug = requireStringValue(record, "slug");
  const groupLogin = requireStringValue(user, "login");
  const itemsCount = requireNumber(record, "items_count");
  const ownerType =
    optionalStringValue(user.type) ??
    (context.type === "personal" ? "User" : "Group");
  const organization = optionalRecord(user.organization);
  const organizationId =
    optionalNumber(record.organization_id) ?? optionalNumber(organization?.id);
  const organizationName =
    optionalStringValue(organization?.name) ?? context.organizationFallback;
  const scopeName =
    context.type === "personal" ? context.personalName : organizationName;
  const accessType = context.accessType ?? "owner";
  const scopeId =
    context.type === "personal"
      ? "personal"
      : organizationId === undefined
        ? "organization"
        : `organization:${String(organizationId)}`;
  const scopeLabel =
    accessType === "collaborator"
      ? `共享：${groupLogin}`
      : context.type === "personal"
        ? `个人：${scopeName}`
        : `空间：${scopeName}`;
  const updatedAt = optionalStringValue(record.updated_at);
  const visibility = optionalNumber(record.public);
  return {
    id,
    name,
    description,
    slug,
    groupLogin,
    url: `${host}/${encodeURIComponent(groupLogin)}/${encodeURIComponent(slug)}`,
    itemsCount,
    scopeId,
    scopeType: context.type,
    scopeName,
    scopeLabel,
    host,
    ...(context.type === "organization" && organizationId !== undefined
      ? { organizationId }
      : {}),
    ownerType,
    ownerLogin: groupLogin,
    accessType,
    private: visibility === 0,
    ...(accessType === "owner"
      ? { role: "owner" as const }
      : { role: requiredCollaboratorRole(context.collaboratorRole) }),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function bookFingerprint(book: NormalizedBook): string {
  return fingerprint({
    id: book.id,
    slug: book.slug,
    ownerLogin: book.ownerLogin,
    name: book.name,
    description: book.description,
    private: book.private,
    updatedAt: book.updatedAt ?? null,
  });
}

function normalizeBookCollaborator(
  value: unknown,
  currentLogin: string,
  ownerLogin: string,
): BookCollaborator {
  const record = asRecord(value, "Book collaboration");
  const owner = asRecord(record.owner, "Book collaborator account");
  const login = requireStringValue(owner, "login");
  const roleCode = requireNumber(record, "role");
  const isOwner = login === ownerLogin;
  const name = optionalStringValue(owner.name);
  return {
    collaborationId: String(requireNumber(record, "id")),
    login,
    ...(name ? { name } : {}),
    role: isOwner ? "owner" : roleFromCode(roleCode),
    roleCode,
    status: requireNumber(record, "status"),
    isCurrentUser: login === currentLogin,
  };
}

function requiredCollaboratorRole(
  role: "reader" | "editor" | undefined,
): "reader" | "editor" {
  if (!role) {
    throw new ContractError("Collaborated knowledge base has an unknown role");
  }
  return role;
}

function roleFromCode(
  roleCode: number,
): "owner" | "reader" | "editor" | "unknown" {
  if (roleCode === 0) return "reader";
  if (roleCode === 1) return "editor";
  if (roleCode === 2) return "owner";
  return "unknown";
}

function collaboratorFingerprint(collaborators: BookCollaborator[]): string {
  return fingerprint(
    collaborators
      .map((entry) => ({
        id: entry.collaborationId,
        login: entry.login,
        role: entry.roleCode,
        status: entry.status,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function normalizeOrganizationScope(
  value: unknown,
  configuredHost: string,
): YuqueScope {
  const record = asRecord(value, "Yuque organization");
  const id = requireNumber(record, "id");
  const name = requireStringValue(record, "name");
  const advertisedHost = optionalStringValue(record.host);
  if (advertisedHost && !sameHostname(advertisedHost, configuredHost)) {
    throw new ContractError(
      "Yuque organization host does not match the configured company host",
    );
  }
  return {
    id: `organization:${String(id)}`,
    type: "organization",
    name,
    label: `空间：${name}`,
    host: configuredHost,
    organizationId: id,
  };
}

function normalizeCatalog(
  values: unknown[],
  book: NormalizedBook,
): CatalogNode[] {
  const records = values.map((value) => asRecord(value, "Catalog node"));
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    byUuid.set(requireStringValue(record, "uuid"), record);
  }
  return records.map((record, order) => {
    const uuid = requireStringValue(record, "uuid");
    const type = requireStringValue(record, "type");
    const title = requireStringValue(record, "title");
    const parentUuid = optionalStringValue(record.parent_uuid) || undefined;
    const level = requireNumber(record, "level");
    const docId = optionalNumber(record.doc_id);
    const docSlug = optionalStringValue(record.url) || undefined;
    const path = catalogPath(record, byUuid);
    const fullPath = [book.scopeLabel, book.name, ...path];
    return {
      type,
      title,
      uuid,
      ...(parentUuid ? { parentUuid } : {}),
      level,
      order,
      visible: record.visible !== 0,
      path,
      fullPath,
      displayPath: fullPath.join(" / "),
      ...(docId !== undefined ? { docId } : {}),
      ...(docSlug ? { docSlug } : {}),
      ...(docSlug
        ? {
            docUrl: `${book.url}/${encodeURIComponent(docSlug)}`,
          }
        : {}),
    };
  });
}

function normalizeCatalogTitle(value: string | undefined): string {
  const title = value?.trim() || "";
  if (!title) throw new Error("Directory title is required");
  if (title.length > 100) {
    throw new Error("Directory title must not exceed 100 characters");
  }
  if (/\p{Cc}/u.test(title)) {
    throw new Error("Directory title contains a control character");
  }
  return title;
}

function assertUniqueCatalogTitle(
  nodes: CatalogNode[],
  parentUuid: string | undefined,
  title: string,
  excludedUuid?: string,
): void {
  const duplicate = nodes.find(
    (node) =>
      node.uuid !== excludedUuid &&
      (node.parentUuid ?? "") === (parentUuid ?? "") &&
      node.title === title,
  );
  if (duplicate) {
    throw new ContractError(
      `A catalog object with the same title already exists at ${duplicate.displayPath}`,
    );
  }
}

function catalogNodeIsDescendant(
  nodes: CatalogNode[],
  candidate: CatalogNode,
  ancestorUuid: string,
): boolean {
  const byUuid = new Map(nodes.map((node) => [node.uuid, node]));
  let parentUuid = candidate.parentUuid;
  const visited = new Set<string>();
  while (parentUuid) {
    if (parentUuid === ancestorUuid) return true;
    if (visited.has(parentUuid)) {
      throw new ContractError("Yuque catalog has a cycle");
    }
    visited.add(parentUuid);
    parentUuid = byUuid.get(parentUuid)?.parentUuid;
  }
  return false;
}

function catalogFingerprint(nodes: CatalogNode[]): string {
  return fingerprint(
    nodes.map((node) => ({
      uuid: node.uuid,
      type: node.type,
      title: node.title,
      parentUuid: node.parentUuid ?? null,
      order: node.order,
      docId: node.docId ?? null,
      docSlug: node.docSlug ?? null,
    })),
  );
}

function catalogPath(
  record: Record<string, unknown>,
  byUuid: Map<string, Record<string, unknown>>,
): string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let current: Record<string, unknown> | undefined = record;
  while (current) {
    const uuid = requireStringValue(current, "uuid");
    if (visited.has(uuid)) throw new ContractError("Yuque catalog has a cycle");
    visited.add(uuid);
    path.unshift(requireStringValue(current, "title"));
    const parentUuid = optionalStringValue(current.parent_uuid);
    current = parentUuid ? byUuid.get(parentUuid) : undefined;
    if (path.length > 100)
      throw new ContractError("Yuque catalog nesting exceeds safety limit");
  }
  return path;
}

function catalogDocuments(
  book: NormalizedBook,
  nodes: CatalogNode[],
): LocatedDocument[] {
  return nodes.flatMap((node) => {
    if (
      node.type !== "DOC" ||
      node.docId === undefined ||
      !node.docSlug ||
      !node.docUrl
    ) {
      return [];
    }
    return [
      {
        id: node.docId,
        slug: node.docSlug,
        title: node.title,
        url: node.docUrl,
        bookId: book.id,
        bookName: book.name,
        bookUrl: book.url,
        groupLogin: book.groupLogin,
        scopeId: book.scopeId,
        scopeType: book.scopeType,
        scopeLabel: book.scopeLabel,
        position: {
          path: node.path,
          fullPath: node.fullPath,
          displayPath: node.displayPath,
          level: node.level,
          order: node.order,
          ...(node.parentUuid ? { parentUuid: node.parentUuid } : {}),
        },
      },
    ];
  });
}

function assertScopeId(value: string): void {
  if (
    value !== "personal" &&
    value !== "organization" &&
    !/^organization:[1-9][0-9]*$/.test(value)
  ) {
    throw new Error(
      "scope_id must be personal, organization or organization:<numeric-id>",
    );
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function docVersionDocument(
  doc: NormalizedDoc,
  targetUrl: string,
): DocVersionListResult["doc"] {
  return {
    id: doc.id,
    title: doc.title,
    url: targetUrl,
    bookUrl: doc.bookUrl,
    location: doc.location,
  };
}

function normalizeDocVersionSummary(
  value: unknown,
  expectedDocId: string,
  baseHost: string,
): NormalizedDocVersionSummary {
  const record = asRecord(value, "Document version");
  const id = String(requireNumber(record, "id"));
  const docId = String(requireNumber(record, "doc_id"));
  if (docId !== expectedDocId) {
    throw new ContractError("Yuque document version belongs to another Doc");
  }
  const user = asRecord(record.user, "Document version author");
  const name = optionalStringValue(record.name);
  const authorName = optionalStringValue(user.name);
  const released = record.isReleased;
  if (typeof released !== "boolean") {
    throw new ContractError(
      "Yuque document version is missing boolean 'isReleased'",
    );
  }
  return {
    id,
    docId,
    title: requireStringValue(record, "title"),
    ...(name ? { name } : {}),
    createdAt: requireStringValue(record, "created_at"),
    draft: requireBooleanValue(record, "draft"),
    released,
    publicationStatus: requireNumber(record, "publication_status"),
    authorLogin: requireStringValue(user, "login"),
    ...(authorName ? { authorName } : {}),
    ...(name
      ? {
          versionUrl: new URL(
            `/r/doc_versions/${encodeURIComponent(id)}`,
            baseHost,
          ).href,
        }
      : {}),
  };
}

function normalizeDocVersionDetail(
  value: unknown,
  expectedDocId: string,
  baseHost: string,
): NormalizedDocVersionDetail {
  const record = asRecord(value, "Document version detail");
  const id = String(requireNumber(record, "id"));
  const docId = String(requireNumber(record, "doc_id"));
  if (docId !== expectedDocId) {
    throw new ContractError(
      "Yuque document version detail belongs to another Doc",
    );
  }
  const user = asRecord(record.user, "Document version detail author");
  const content = requireStringValue(record, "content");
  const contentHtml = requireStringValue(record, "content_html");
  const name = optionalStringValue(record.name);
  const authorName = optionalStringValue(user.name);
  const released = record.isReleased;
  const publicationStatus = optionalNumber(record.publication_status);
  const normalized: NormalizedDocVersionDetail = {
    id,
    docId,
    title: requireStringValue(record, "title"),
    ...(name ? { name } : {}),
    createdAt: requireStringValue(record, "created_at"),
    draft: requireBooleanValue(record, "draft"),
    ...(typeof released === "boolean" ? { released } : {}),
    ...(publicationStatus !== undefined ? { publicationStatus } : {}),
    authorLogin: requireStringValue(user, "login"),
    ...(authorName ? { authorName } : {}),
    ...(name
      ? {
          versionUrl: new URL(
            `/r/doc_versions/${encodeURIComponent(id)}`,
            baseHost,
          ).href,
        }
      : {}),
    docType: requireStringValue(record, "doc_type"),
    format: requireStringValue(record, "format"),
    slug: requireStringValue(record, "slug"),
    content,
    contentHtml,
    plainText: lakeText(content).trim(),
    fingerprint: "",
  };
  normalized.fingerprint = fingerprint({
    id,
    docId,
    title: normalized.title,
    format: normalized.format,
    content,
    createdAt: normalized.createdAt,
  });
  return normalized;
}

function normalizeCommentTree(values: unknown[]): NormalizedComment[] {
  const comments: NormalizedComment[] = [];
  const visit = (value: unknown): void => {
    const record = asRecord(value, "Comment");
    const id = String(requireNumber(record, "id"));
    const user = asRecord(record.user, "Comment author");
    const bodyAsl = requireStringValue(record, "body_asl");
    const format = requireStringValue(record, "format");
    if (format !== "lake") {
      throw new ContractError("Only Lake comment content is verified");
    }
    const authorLogin = requireStringValue(user, "login");
    const authorName = optionalStringValue(user.name);
    const createdAt = requireStringValue(record, "created_at");
    const updatedAt = requireStringValue(record, "updated_at");
    const parentId = optionalNumber(record.parent_id);
    const rootId = optionalNumber(record.root_id);
    const normalized: NormalizedComment = {
      id,
      ...(parentId !== undefined ? { parentId: String(parentId) } : {}),
      ...(rootId !== undefined ? { rootId: String(rootId) } : {}),
      authorLogin,
      ...(authorName ? { authorName } : {}),
      body: lakeText(bodyAsl).trim(),
      bodyAsl,
      format: "lake",
      createdAt,
      updatedAt,
      fingerprint: "",
    };
    normalized.fingerprint = fingerprint({
      id,
      parentId: normalized.parentId ?? null,
      rootId: normalized.rootId ?? null,
      authorLogin,
      bodyAsl,
      updatedAt,
    });
    comments.push(normalized);
    const children = record.sub_comments;
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        throw new ContractError("Comment replies are not an array");
      }
      children.forEach(visit);
    }
  };
  values.forEach(visit);
  return comments;
}

function commentCollectionFingerprint(comments: NormalizedComment[]): string {
  return fingerprint(
    comments
      .map((comment) => ({ id: comment.id, fingerprint: comment.fingerprint }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function normalizeCommentBody(value: string | undefined): string {
  const body = value?.trim();
  if (!body) throw new Error("Comment body is required");
  if (body.length > 20_000) {
    throw new Error("Comment body must not exceed 20,000 characters");
  }
  return body;
}

function normalizePositiveId(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${field} must be a positive numeric ID`);
  }
  return normalized;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function sameHostname(value: string, expected: string): boolean {
  try {
    const candidate = value.includes("://")
      ? new URL(value)
      : new URL(`https://${value}`);
    return candidate.hostname === new URL(expected).hostname;
  } catch {
    return false;
  }
}

function normalizeDoc(
  detailValue: unknown,
  textValue: unknown,
  url: string,
  book: NormalizedBook,
): Omit<NormalizedDoc, "location"> {
  if (!detailValue || typeof detailValue !== "object")
    throw new ContractError("Document response is not an object");
  const record = detailValue as Record<string, unknown>;
  const textRecord = asRecord(textValue, "Document text response");
  const id = requireNumber(record, "id");
  const title = requireStringValue(record, "title");
  const textTitle = requireStringValue(textRecord, "title");
  const markdown = requireStringValue(textRecord, "content");
  const lakeContent = requireStringValue(record, "content");
  const slug = requireStringValue(record, "slug");
  const bookId = requireNumber(record, "book_id");
  const format = requireStringValue(record, "format");
  const version = requireNumber(record, "draft_version");
  if (title !== textTitle)
    throw new ContractError("Document detail and text titles do not match");
  if (bookId !== book.id)
    throw new ContractError("Document response belongs to another book");
  const updatedAt =
    typeof record.updated_at === "string" ? record.updated_at : undefined;
  const normalized: Omit<NormalizedDoc, "location"> = {
    id: String(id),
    slug,
    title,
    markdown,
    lakeContent,
    bookId,
    bookUrl: book.url,
    format,
    version,
    url,
    raw: detailValue,
    ...(updatedAt ? { updatedAt } : {}),
    fingerprint: "",
  };
  normalized.fingerprint = fingerprint({
    id: normalized.id,
    title,
    lakeContent,
    version,
    updatedAt,
  });
  return normalized;
}

function partialUninitializedSheetResult(input: {
  createdId: string;
  createdSlug: string;
  createdTitle: string;
  targetUrl: string;
  displayPath: string;
  reconciledAfterUnknownResponse: boolean;
}): CreatedSheetResult {
  return {
    status: "partial_created_uninitialized",
    id: input.createdId,
    slug: input.createdSlug,
    title: input.createdTitle,
    sheetUrl: input.targetUrl,
    displayPath: input.displayPath,
    catalogMounted: true,
    reconciledAfterUnknownResponse: input.reconciledAfterUnknownResponse,
  };
}

export function validateExportUrl(input: {
  rawUrl: string;
  format: YuqueExportFormat;
  targetType: YuqueExportTargetType;
  documentOrigin: string;
  ownerSlug: string;
  bookSlug: string;
  docSlug: string;
}): {
  url: string;
  host: string;
  browserLoginRequired: boolean;
  expiresAt?: string;
} {
  if (
    !EXPORT_OPTIONS[input.targetType].some(
      (option) => option.format === input.format,
    )
  ) {
    throw new ContractError(
      `Yuque ${input.targetType} export format is not enabled: ${input.format}`,
    );
  }
  let url: URL;
  try {
    url = new URL(input.rawUrl, input.documentOrigin);
  } catch {
    throw new ContractError("Yuque export returned an invalid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ContractError("Yuque export returned an unsafe URL");
  }
  const queryKeys = [...url.searchParams.keys()].sort();
  if (new Set(queryKeys).size !== queryKeys.length) {
    throw new ContractError("Yuque export URL contains duplicate parameters");
  }
  const requireQuery = (expected: string[]) => {
    if (
      JSON.stringify(queryKeys) !== JSON.stringify([...expected].sort()) ||
      expected.some((key) => !url.searchParams.get(key))
    ) {
      throw new ContractError("Yuque export URL parameters changed");
    }
  };
  if (input.targetType === "Doc" && input.format === "word") {
    if (
      url.hostname.toLowerCase() !== "lark-temp.oss-cn-hangzhou.aliyuncs.com" ||
      !/^\/__temp\/[^/]+\/docx\/[^/]+\.docx$/.test(url.pathname)
    ) {
      throw new ContractError("Yuque Word export delivery Host changed");
    }
    requireQuery(["Expires", "OSSAccessKeyId", "Signature"]);
    const expiresSeconds = Number(url.searchParams.get("Expires"));
    if (
      !Number.isSafeInteger(expiresSeconds) ||
      expiresSeconds * 1_000 <= Date.now()
    ) {
      throw new ContractError("Yuque Word export URL is already expired");
    }
    return {
      url: url.toString(),
      host: url.hostname.toLowerCase(),
      browserLoginRequired: false,
      expiresAt: new Date(expiresSeconds * 1_000).toISOString(),
    };
  }
  if (url.origin !== new URL(input.documentOrigin).origin) {
    throw new ContractError("Yuque export returned an unknown delivery Host");
  }
  if (
    (input.targetType === "Doc" &&
      (input.format === "markdown" || input.format === "lake")) ||
    (input.targetType === "Sheet" && input.format === "lakesheet")
  ) {
    const expectedPath = `/${encodeURIComponent(input.ownerSlug)}/${encodeURIComponent(input.bookSlug)}/${encodeURIComponent(input.docSlug)}/${input.format}`;
    if (url.pathname !== expectedPath) {
      throw new ContractError("Yuque document export route changed");
    }
    requireQuery(
      input.format === "markdown"
        ? ["anchor", "attachment", "latexcode", "linebreak", "useMdai"]
        : ["attachment"],
    );
  } else if (
    input.targetType === "Doc" &&
    (input.format === "pdf" || input.format === "jpg")
  ) {
    if (!/^\/attachments\/__temp\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)) {
      throw new ContractError("Yuque temporary export route changed");
    }
    requireQuery(["attachable_id", "attachable_type", "filename"]);
  } else if (input.targetType === "Sheet" && input.format === "excel") {
    if (
      !/^\/attachments\/__temp\/[^/]+\/xlsx\/[^/]+\.xlsx$/.test(url.pathname)
    ) {
      throw new ContractError("Yuque Excel export route changed");
    }
    requireQuery(["attachable_id", "attachable_type", "filename"]);
  } else {
    throw new ContractError(
      `Yuque ${input.targetType} export format is not enabled: ${input.format}`,
    );
  }
  return {
    url: url.toString(),
    host: url.hostname.toLowerCase(),
    browserLoginRequired: true,
  };
}

function safeExportFilename(title: string, extension: string): string {
  const safeTitle = title
    .replace(/[\\/:*?"<>|%]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return `${safeTitle || "yuque-export"}.${extension}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function workbookCellFingerprint(workbook: NormalizedWorkbook): string {
  return fingerprint(
    workbook.worksheets.map((worksheet) => ({
      id: worksheet.id,
      name: worksheet.name,
      cells: Object.fromEntries(
        Object.entries(worksheet.cells).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    })),
  );
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function requireStringValue(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new ContractError(`Yuque response is missing string '${key}'`);
  return value;
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ContractError(`Yuque response is missing number '${key}'`);
  return value;
}

function requireBooleanValue(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new ContractError(`Yuque response is missing boolean '${key}'`);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function deduplicateBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function extractConvertedLake(value: unknown): string {
  if (typeof value === "string" && value.trim().startsWith("<")) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["content", "body", "lake"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().startsWith("<")) {
        return candidate;
      }
    }
  }
  throw new ContractError(
    "Markdown conversion no longer returns a verified Lake HTML string",
  );
}
