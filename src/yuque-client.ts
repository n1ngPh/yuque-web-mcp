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
}

export interface NormalizedBook {
  id: number;
  name: string;
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
  updatedAt?: string;
}

export interface BookCollaborator {
  collaborationId: string;
  login: string;
  name?: string;
  role: "owner" | "reader" | "editor" | "unknown";
  roleCode: number;
  isCurrentUser: boolean;
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

  constructor(
    private readonly config: AppConfig,
    private readonly contracts: ContractRegistry,
    private readonly sessions: SessionStore,
    private readonly lakeHtml: LakeHtmlRenderer = new PinnedLakeHtmlRenderer(),
  ) {}

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
    return {
      draftVersion: requireNumber(doc, "draft_version"),
      lockerPresent: doc.locker !== null,
      collaboratorCount: collaborators.length,
    };
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

  assertSheetUpdateEnabled(targetUrl?: string): void {
    this.assertWriteTargetAllowed(targetUrl);
    this.contracts.getWritable(
      "save_sheet_content",
      this.contractHostTypeForTarget(targetUrl),
    );
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
  ): Promise<{ response: unknown; bodyHtml: string }> {
    this.assertDocContentUpdateEnabled(input.referer);
    const bodyHtml = await this.lakeHtml.render(input.lakeContent);
    const response = await this.updateDocNativeDraft(employeeId, {
      docId: input.docId,
      draftVersion: input.draftVersion,
      bodyAsl: input.lakeContent,
      bodyHtml,
      referer: input.referer,
    });
    return { response, bodyHtml };
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
        await this.updateSheetDraft(employeeId, {
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
    return this.request(employeeId, "save_sheet_content", {
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
        return unwrapData(parsed);
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
      });
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
  constructor(resourceType: "Doc" | "Sheet") {
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

function normalizeBook(
  value: unknown,
  host: string,
  context: {
    type: YuqueScopeType;
    personalName: string;
    organizationFallback: string;
  },
): NormalizedBook {
  const record = asRecord(value, "Knowledge base");
  const user = asRecord(record.user, "Knowledge-base owner");
  const id = requireNumber(record, "id");
  const name = requireStringValue(record, "name");
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
  const accessType = "owner" as const;
  const scopeId =
    context.type === "personal"
      ? "personal"
      : organizationId === undefined
        ? "organization"
        : `organization:${String(organizationId)}`;
  const scopeLabel =
    context.type === "personal" ? `个人：${scopeName}` : `空间：${scopeName}`;
  const updatedAt = optionalStringValue(record.updated_at);
  return {
    id,
    name,
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
    ...(accessType === "owner" ? { role: "owner" as const } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
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
    role: isOwner ? "owner" : "unknown",
    roleCode,
    isCurrentUser: login === currentLogin,
  };
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
