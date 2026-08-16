import type { AppConfig } from "./config.js";
import type { ContractRegistry } from "./contracts.js";
import { SERVER_VERSION } from "./version.js";

export type CapabilityAvailability = "available" | "preview_only" | "disabled";

export type CapabilityHostType = "local" | "personal" | "organization";

interface CapabilityPolicy {
  tool: string;
  availability: CapabilityAvailability;
  hostTypes: CapabilityHostType[];
  reasonCode?: string;
}

export interface CapabilityStatus extends CapabilityPolicy {
  required_write_mode: "none" | "strict" | "best_effort";
}

const local = ["local"] as const;
const personal = ["personal"] as const;
const personalAndOrganization = ["personal", "organization"] as const;

export const CAPABILITY_POLICIES: readonly CapabilityPolicy[] = [
  available("yuque_get_capabilities", local),
  available("yuque_auth_status", local),
  available("yuque_login_begin", local),
  available("yuque_login_status", local),
  available("yuque_logout", local),
  available("yuque_get_user", local),
  available("yuque_list_scopes", personal),
  available("yuque_list_books", personalAndOrganization),
  available("yuque_get_book", personalAndOrganization),
  available("yuque_list_book_collaborators", personal),
  available("yuque_search", personalAndOrganization),
  available("yuque_get_toc", personalAndOrganization),
  available("yuque_list_docs", personalAndOrganization),
  available("yuque_list_all_docs", personalAndOrganization),
  available("yuque_get_doc", personalAndOrganization),
  available("yuque_list_comments", personal),
  available("yuque_list_doc_versions", personal),
  available("yuque_get_doc_version", personal),
  available("yuque_preview_restore_doc_version", personal),
  available("yuque_get_sheet", personalAndOrganization),
  available("yuque_preview_create_book", personal),
  available("yuque_preview_update_book", personal),
  previewOnly(
    "yuque_preview_change_book_collaborator",
    "permission_changes_disabled",
    personal,
  ),
  available("yuque_preview_change_catalog", personal),
  available("yuque_preview_change_comment", personal),
  previewOnly("yuque_preview_delete_doc", "object_deletion_disabled", personal),
  previewOnly(
    "yuque_preview_delete_sheet",
    "object_deletion_disabled",
    personal,
  ),
  previewOnly(
    "yuque_preview_delete_book",
    "object_deletion_disabled",
    personal,
  ),
  available("yuque_preview_create_doc", personalAndOrganization),
  available("yuque_preview_update_doc", personalAndOrganization),
  available("yuque_preview_create_sheet", personal),
  available("yuque_preview_update_sheet", personalAndOrganization),
  previewOnly("yuque_confirm_change", "strict_mode_default"),
  available("yuque_cancel_change", local),
  available("yuque_list_snapshots", local),
  available("yuque_preview_restore_snapshot", personalAndOrganization),
];

export function capabilityToolNames(): string[] {
  return CAPABILITY_POLICIES.map((entry) => entry.tool);
}

export function buildCapabilityReport(
  config: AppConfig,
  contracts: ContractRegistry,
): Record<string, unknown> {
  const bestEffort = config.writeConsistencyMode === "best_effort";
  return {
    server_version: SERVER_VERSION,
    registry_version: 1,
    contract_version: contracts.manifest.version,
    contract_verified_at: contracts.manifest.verifiedAt,
    write_consistency_mode: config.writeConsistencyMode,
    safeguards: {
      write_kill_switch_active: config.writeKillSwitch === true,
      object_deletion_enabled: config.allowObjectDeletion === true,
      permission_changes_enabled: config.allowPermissionChanges === true,
      exact_write_allowlist_configured:
        (config.writeBookAllowlist?.length ?? 0) > 0,
    },
    capabilities: CAPABILITY_POLICIES.map((policy): CapabilityStatus => {
      if (policy.tool === "yuque_confirm_change") {
        if (config.writeKillSwitch === true) {
          return {
            ...policy,
            availability: "disabled",
            required_write_mode: "best_effort",
            reasonCode: "write_kill_switch_active",
          };
        }
        if (bestEffort) {
          const { reasonCode: _reasonCode, ...enabledPolicy } = policy;
          return {
            ...enabledPolicy,
            availability: "available",
            required_write_mode: "best_effort",
          };
        }
        return {
          ...policy,
          availability: "preview_only",
          required_write_mode: "strict",
          reasonCode: "strict_mode_default",
        };
      }
      if (policy.tool === "yuque_preview_change_book_collaborator") {
        return config.allowPermissionChanges === true
          ? {
              ...policy,
              availability: "available",
              required_write_mode: "none",
              reasonCode: undefined,
            }
          : {
              ...policy,
              availability: "disabled",
              required_write_mode: "none",
              reasonCode: "permission_changes_disabled",
            };
      }
      if (
        policy.tool === "yuque_preview_delete_doc" ||
        policy.tool === "yuque_preview_delete_sheet" ||
        policy.tool === "yuque_preview_delete_book"
      ) {
        if (config.allowObjectDeletion === true) {
          const { reasonCode: _reasonCode, ...enabledPolicy } = policy;
          return {
            ...enabledPolicy,
            availability: "available",
            required_write_mode: "none",
          };
        }
        return {
          ...policy,
          availability: "disabled",
          required_write_mode: "none",
          reasonCode: "object_deletion_disabled",
        };
      }
      return {
        ...policy,
        required_write_mode: "none",
      };
    }),
  };
}

function available(
  tool: string,
  hostTypes: readonly CapabilityHostType[],
): CapabilityPolicy {
  return { tool, availability: "available", hostTypes: [...hostTypes] };
}

function previewOnly(
  tool: string,
  reasonCode: string,
  hostTypes: readonly CapabilityHostType[] = personalAndOrganization,
): CapabilityPolicy {
  return {
    tool,
    availability: "preview_only",
    hostTypes: [...hostTypes],
    reasonCode,
  };
}

function disabled(
  tool: string,
  reasonCode: string,
  hostTypes: readonly CapabilityHostType[] = personalAndOrganization,
): CapabilityPolicy {
  return {
    tool,
    availability: "disabled",
    hostTypes: [...hostTypes],
    reasonCode,
  };
}
