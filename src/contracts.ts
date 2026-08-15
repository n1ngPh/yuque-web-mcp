import { readFile } from "node:fs/promises";
import type {
  CapabilityName,
  ContractManifest,
  EndpointContract,
} from "./types.js";

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export class ContractRegistry {
  private constructor(
    readonly manifest: ContractManifest,
    private readonly allowUnverified: boolean,
  ) {}

  static async load(
    path: string,
    allowUnverified = false,
  ): Promise<ContractRegistry> {
    const manifest = JSON.parse(
      await readFile(path, "utf8"),
    ) as ContractManifest;
    validateManifest(manifest);
    return new ContractRegistry(manifest, allowUnverified);
  }

  get(
    capability: CapabilityName,
    hostType: "organization" | "personal" = "organization",
  ): EndpointContract {
    const contract = this.manifest.endpoints.find(
      (entry) => entry.capability === capability,
    );
    if (!contract)
      throw new ContractError(
        `No endpoint contract for capability: ${capability}`,
      );
    if (!contract.verified && !this.allowUnverified) {
      throw new ContractError(
        `Yuque web endpoint '${capability}' has not passed live capture and replay verification`,
      );
    }
    const verifiedHostTypes = contract.verifiedHostTypes ?? ["organization"];
    if (!verifiedHostTypes.includes(hostType) && !this.allowUnverified) {
      throw new ContractError(
        `Yuque web endpoint '${capability}' has not passed ${hostType}-host capture and replay verification`,
      );
    }
    return contract;
  }

  getWritable(
    capability: CapabilityName,
    hostType: "organization" | "personal" = "organization",
  ): EndpointContract {
    const contract = this.get(capability, hostType);
    if (!contract.liveWriteEnabled) {
      throw new ContractError(
        `Yuque web write '${capability}' is captured but remains disabled until every required serialization, atomic conflict and write read-back gate is verified`,
      );
    }
    return contract;
  }

  has(
    capability: CapabilityName,
    hostType: "organization" | "personal" = "organization",
  ): boolean {
    try {
      this.get(capability, hostType);
      return true;
    } catch (error) {
      if (error instanceof ContractError) return false;
      throw error;
    }
  }
}

export function interpolatePath(
  path: string,
  values: Record<string, string | number>,
): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined)
      throw new ContractError(`Missing path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
}

export function assertRequiredPaths(value: unknown, paths: string[]): void {
  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path.split(".")) {
      if (!current || typeof current !== "object" || !(segment in current)) {
        throw new ContractError(
          `Yuque response no longer matches contract; missing '${path}'`,
        );
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
}

function validateManifest(value: ContractManifest): void {
  if (!value.version || !Array.isArray(value.endpoints))
    throw new ContractError("Invalid contract manifest");
  const capabilities = new Set<string>();
  for (const endpoint of value.endpoints) {
    if (capabilities.has(endpoint.capability)) {
      throw new ContractError(
        `Duplicate endpoint capability: ${endpoint.capability}`,
      );
    }
    capabilities.add(endpoint.capability);
    if (
      endpoint.deletionEffect !== undefined &&
      ![
        "none",
        "content",
        "permission",
        "doc_object",
        "sheet_object",
        "knowledge_base",
      ].includes(endpoint.deletionEffect)
    ) {
      throw new ContractError(
        `Invalid deletionEffect for ${endpoint.capability}`,
      );
    }
    if (!endpoint.path.startsWith("/api/")) {
      throw new ContractError(
        `Endpoint path must remain under /api/: ${endpoint.path}`,
      );
    }
    if (
      requiresDeletionClassification(endpoint) &&
      endpoint.deletionEffect === undefined
    ) {
      throw new ContractError(
        `Deletion semantics must be explicitly classified: ${endpoint.capability}`,
      );
    }
    if (
      endpoint.targetResourceType !== undefined &&
      !["Doc", "Sheet", "KnowledgeBase", "Collaboration"].includes(
        endpoint.targetResourceType,
      )
    ) {
      throw new ContractError(
        `Invalid targetResourceType for ${endpoint.capability}`,
      );
    }
    validateDestructiveContract(endpoint);
    for (const field of ["observedHostTypes", "verifiedHostTypes"] as const) {
      if (
        endpoint[field]?.some(
          (hostType) => hostType !== "organization" && hostType !== "personal",
        )
      ) {
        throw new ContractError(`Invalid ${field} for ${endpoint.capability}`);
      }
    }
    for (const scenario of endpoint.verifiedScenarios ?? []) {
      if (
        !scenario.id ||
        !scenario.verifiedAt ||
        (scenario.verifiedHostType !== "organization" &&
          scenario.verifiedHostType !== "personal")
      ) {
        throw new ContractError(
          `Invalid verified scenario for ${endpoint.capability}`,
        );
      }
    }
  }
}

function hasDeletionPathSegment(path: string): boolean {
  return path
    .split(/[/?#_-]+/)
    .some((segment) =>
      ["delete", "destroy", "remove"].includes(segment.toLowerCase()),
    );
}

function requiresDeletionClassification(endpoint: EndpointContract): boolean {
  return endpoint.method === "DELETE" || hasDeletionPathSegment(endpoint.path);
}

function validateDestructiveContract(endpoint: EndpointContract): void {
  const expected = {
    doc_object: { capability: "delete_doc", resource: "Doc" },
    sheet_object: { capability: "delete_sheet", resource: "Sheet" },
    knowledge_base: {
      capability: "delete_book",
      resource: "KnowledgeBase",
    },
    permission: {
      capability: "delete_book_collaborator",
      resource: "Collaboration",
    },
  } as const;
  const effect = endpoint.deletionEffect;
  if (!effect || effect === "none" || effect === "content") return;
  const rule = expected[effect];
  if (
    endpoint.capability !== rule.capability ||
    endpoint.targetResourceType !== rule.resource
  ) {
    throw new ContractError(
      `${effect} requires capability=${rule.capability} and targetResourceType=${rule.resource}: ${endpoint.capability}`,
    );
  }
  if (
    !endpoint.verified ||
    !endpoint.liveWriteEnabled ||
    !endpoint.verifiedHostTypes?.includes("personal")
  ) {
    throw new ContractError(
      `Destructive contract must be verified and liveWriteEnabled on the personal Host: ${endpoint.capability}`,
    );
  }
}
