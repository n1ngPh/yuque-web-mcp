export interface YuqueAccount {
  id: string;
  login: string;
  name?: string;
}

export interface EncryptedEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface StoredWebSession {
  cookies: unknown;
  csrfToken: string;
  account: YuqueAccount;
  savedAt: string;
}

export type CapabilityName =
  | "get_user"
  | "list_books"
  | "list_personal_books"
  | "list_user_books"
  | "list_organizations"
  | "get_organization_user"
  | "list_groups"
  | "list_groups_all"
  | "set_active_scope"
  | "search"
  | "get_toc"
  | "change_catalog"
  | "list_docs"
  | "get_doc"
  | "create_doc_export"
  | "get_doc_editor"
  | "get_doc_lock"
  | "acquire_doc_lock"
  | "release_doc_lock"
  | "get_doc_text"
  | "list_comments"
  | "create_comment"
  | "update_comment"
  | "delete_comment"
  | "list_doc_versions"
  | "get_doc_version"
  | "restore_doc_version"
  | "get_sheet"
  | "convert_markdown"
  | "create_doc"
  | "mount_catalog_node"
  | "update_doc"
  | "save_doc_content"
  | "publish_doc"
  | "update_doc_meta"
  | "create_sheet"
  | "initialize_sheet"
  | "save_sheet_content"
  | "delete_sheet"
  | "get_book"
  | "list_collaborate_books"
  | "list_current_collaborations"
  | "list_book_collaborators"
  | "search_users"
  | "create_book"
  | "update_book"
  | "create_book_collaborator"
  | "update_book_collaborator"
  | "delete_book_collaborator"
  | "delete_doc"
  | "delete_book"
  | "logout";

export interface EndpointContract {
  capability: CapabilityName;
  verified: boolean;
  observedHostTypes?: Array<"organization" | "personal">;
  verifiedHostTypes?: Array<"organization" | "personal">;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  deletionEffect?:
    | "none"
    | "content"
    | "permission"
    | "doc_object"
    | "sheet_object"
    | "catalog_node"
    | "knowledge_base";
  targetResourceType?:
    | "Doc"
    | "Sheet"
    | "CatalogNode"
    | "KnowledgeBase"
    | "Collaboration"
    | "Comment";
  idempotent: boolean;
  requiredResponsePaths: string[];
  liveWriteEnabled?: boolean;
  liveWriteHostTypes?: Array<"organization" | "personal">;
  verifiedScenarios?: EndpointVerificationScenario[];
  notes?: string;
}

export interface EndpointVerificationScenario {
  id: string;
  verifiedHostType: "organization" | "personal";
  verifiedAt: string;
  versionTransition?: string;
  functions?: string[];
  newlyEnabledFunctions?: string[];
  formulaCount?: number;
  writeAttempts?: number;
  retryAttempts?: number;
  unknownResponses?: number;
  browserStarts?: number;
  deleteRequests?: number;
  fullResourceRestored?: boolean;
  exactMatchOnly?: boolean;
  controlledNonEmptyCellCount?: number;
  configPaths?: string[];
  sourceRangePreserved?: boolean;
  sourceCellsPreserved?: boolean;
  lockPreflight?: {
    draftVersion: number;
    lockerPresent: boolean;
    collaboratorCount: number;
    atomicCasClaimed: boolean;
  };
  constraints?: string[];
}

export interface ContractManifest {
  version: string;
  verifiedAt: string | null;
  sourceBundles: Array<{ url: string; sha256: string | null }>;
  endpoints: EndpointContract[];
}

export type PendingChangeKind =
  | "create_doc"
  | "update_doc"
  | "create_sheet"
  | "update_sheet"
  | "update_sheet_chart"
  | "restore_snapshot"
  | "restore_doc_version"
  | "restore_sheet_snapshot"
  | "create_book"
  | "update_book"
  | "change_book_collaborator"
  | "change_catalog"
  | "change_comment"
  | "delete_doc"
  | "delete_sheet"
  | "delete_book";

export type ChangeState =
  | "previewed"
  | "executing"
  | "succeeded"
  | "unknown"
  | "failed"
  | "conflict"
  | "partial"
  | "cancelled";

export interface PendingChangePayload {
  schemaVersion: 3;
  kind: PendingChangeKind;
  bookUrl?: string;
  docUrl?: string;
  title?: string;
  slug?: string;
  markdown?: string;
  convertedLake?: string;
  baseFingerprint?: string;
  baseTargetFingerprint?: string;
  diffDigest?: string;
  hasDeletions?: boolean;
  displayPath?: string;
  targetUrl?: string;
  parentUuid?: string;
  expectedParentPath?: string;
  mode?: "append" | "replace_section" | "delete_section" | "rename" | "restore";
  sectionHeading?: string;
  newTitle?: string;
  baseVersion?: number;
  snapshotId?: string;
  versionId?: string;
  sheetDraft?: string;
  sheetOperations?: unknown[];
  sheetChartOperations?: unknown[];
  baseWorkbookFingerprint?: string;
  bookId?: number;
  bookName?: string;
  bookDescription?: string;
  bookVisibility?: "private";
  ownerLogin?: string;
  collaboratorId?: string;
  collaboratorLogin?: string;
  collaboratorRole?: "reader" | "editor";
  collaboratorAction?: "invite" | "change_role" | "remove";
  catalogAction?: "create" | "rename" | "move" | "delete";
  catalogNodeUuid?: string;
  catalogTargetUuid?: string;
  catalogPosition?: "into" | "after";
  catalogTitle?: string;
  catalogExpectedParentPath?: string;
  commentAction?: "create" | "update" | "delete";
  commentId?: string;
  commentText?: string;
  commentBodyAsl?: string;
  commentBodyHtml?: string;
  resourceType?:
    | "Doc"
    | "Sheet"
    | "CatalogNode"
    | "CatalogDirectory"
    | "CatalogDocument"
    | "KnowledgeBase"
    | "Comment";
  confirmationText?: string;
  allowNonempty?: boolean;
}

export interface LoginStatus {
  state:
    | "starting"
    | "waiting_scan"
    | "waiting_sms"
    | "success"
    | "expired"
    | "failed";
  loginId: string;
  expiresAt: string;
  account?: YuqueAccount;
  message?: string;
}
