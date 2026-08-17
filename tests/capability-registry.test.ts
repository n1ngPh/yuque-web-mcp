import { describe, expect, it } from "vitest";
import {
  buildCapabilityReport,
  capabilityToolNames,
} from "../src/capability-registry.js";
import type { AppConfig } from "../src/config.js";
import type { ContractRegistry } from "../src/contracts.js";
import { toolDefinitions } from "../src/mcp.js";

describe("Capability Registry", () => {
  it("is the complete ordered status source for all MCP tools", () => {
    expect(capabilityToolNames()).toEqual(
      toolDefinitions.map((tool) => tool.name),
    );
    expect(capabilityToolNames()).toHaveLength(38);
  });

  it("reports strict mode without exposing configured secrets or hosts", () => {
    const report = buildCapabilityReport(config("strict"), contracts());
    const confirm = (
      report.capabilities as Array<Record<string, unknown>>
    ).find((entry) => entry.tool === "yuque_confirm_change");
    expect(report).toMatchObject({
      server_version: "1.2.0",
      contract_version: "fixture-contract",
      write_consistency_mode: "strict",
      safeguards: {
        object_deletion_enabled: false,
        permission_changes_enabled: false,
        exact_write_allowlist_configured: false,
      },
    });
    expect(confirm).toMatchObject({
      availability: "preview_only",
      required_write_mode: "strict",
      reasonCode: "strict_mode_default",
    });
    const createBook = (
      report.capabilities as Array<Record<string, unknown>>
    ).find((entry) => entry.tool === "yuque_preview_create_book");
    expect(createBook).toMatchObject({
      availability: "available",
      hostTypes: ["personal"],
      required_write_mode: "none",
    });
    const deleteDoc = (
      report.capabilities as Array<Record<string, unknown>>
    ).find((entry) => entry.tool === "yuque_preview_delete_doc");
    expect(deleteDoc).toMatchObject({
      availability: "disabled",
      hostTypes: ["personal"],
      reasonCode: "object_deletion_disabled",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("company.invalid");
    expect(serialized).not.toContain("employee.a");
  });

  it("marks Confirm available only after best_effort is explicit", () => {
    const report = buildCapabilityReport(config("best_effort"), contracts());
    const confirm = (
      report.capabilities as Array<Record<string, unknown>>
    ).find((entry) => entry.tool === "yuque_confirm_change");
    expect(confirm).toMatchObject({
      availability: "available",
      required_write_mode: "best_effort",
    });
    expect(confirm).not.toHaveProperty("reasonCode");
  });

  it("lets the deployment kill switch override best_effort", () => {
    const disabled = config("best_effort");
    disabled.writeKillSwitch = true;
    const report = buildCapabilityReport(disabled, contracts());
    const confirm = (
      report.capabilities as Array<Record<string, unknown>>
    ).find((entry) => entry.tool === "yuque_confirm_change");
    expect(confirm).toMatchObject({
      availability: "disabled",
      required_write_mode: "best_effort",
      reasonCode: "write_kill_switch_active",
    });
  });

  it("exposes typed object-deletion Preview only after its explicit switch", () => {
    const enabledConfig = config("best_effort");
    enabledConfig.allowObjectDeletion = true;
    const report = buildCapabilityReport(enabledConfig, contracts());
    for (const tool of [
      "yuque_preview_delete_doc",
      "yuque_preview_delete_sheet",
      "yuque_preview_delete_book",
    ]) {
      const entry = (
        report.capabilities as Array<Record<string, unknown>>
      ).find((capability) => capability.tool === tool);
      expect(entry).toMatchObject({
        availability: "available",
        hostTypes: ["personal"],
      });
      expect(entry).not.toHaveProperty("reasonCode");
    }
  });
});

function config(writeConsistencyMode: "strict" | "best_effort"): AppConfig {
  return {
    writeConsistencyMode,
    ownerId: "employee.a",
    mcpBearerToken: "secret-token".repeat(4),
    yuqueHost: "https://company.invalid",
  } as AppConfig;
}

function contracts(): ContractRegistry {
  return {
    manifest: {
      version: "fixture-contract",
      verifiedAt: "2026-08-15T00:00:00.000Z",
      sourceBundles: [],
      endpoints: [],
    },
  } as unknown as ContractRegistry;
}
