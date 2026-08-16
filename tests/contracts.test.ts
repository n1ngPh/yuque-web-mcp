import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ContractError,
  ContractRegistry,
  assertRequiredPaths,
  interpolatePath,
} from "../src/contracts.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("web endpoint contracts", () => {
  it("fails closed for unverified endpoints", async () => {
    const path = await manifest(false);
    const registry = await ContractRegistry.load(path);
    expect(() => registry.get("get_user")).toThrow(ContractError);
  });

  it("allows a verified endpoint and checks response paths", async () => {
    const path = await manifest(true);
    const registry = await ContractRegistry.load(path);
    expect(registry.get("get_user").path).toBe("/api/mine/account");
    expect(() =>
      assertRequiredPaths({ data: { user: { id: 1 } } }, ["data.user.id"]),
    ).not.toThrow();
    expect(() => assertRequiredPaths({ data: {} }, ["data.user.id"])).toThrow(
      "missing",
    );
    expect(() => registry.get("get_user", "personal")).toThrow(
      "personal-host capture and replay verification",
    );
  });

  it("requires independent host verification before reusing a path", async () => {
    const path = await manifest(true, ["organization", "personal"]);
    const registry = await ContractRegistry.load(path);
    expect(registry.get("get_user", "personal").path).toBe("/api/mine/account");
  });

  it("does not treat UI observation as replay verification", async () => {
    const path = await manifest(false, undefined, ["personal"]);
    const registry = await ContractRegistry.load(path);
    expect(registry.manifest.endpoints[0]?.observedHostTypes).toEqual([
      "personal",
    ]);
    expect(() => registry.get("get_user", "personal")).toThrow(
      "has not passed live capture and replay verification",
    );
  });

  it("enables verified best-effort content writes only on the personal Host", async () => {
    const registry = await ContractRegistry.load(
      resolve("contracts/yuque-web-2026-08-14.json"),
    );
    expect(registry.get("get_sheet", "personal").verified).toBe(true);
    expect(registry.get("get_doc_lock", "personal")).toMatchObject({
      method: "GET",
      path: "/api/docs/{docId}/lock",
      verified: true,
      verifiedHostTypes: ["personal"],
    });
    const create = registry.manifest.endpoints.find(
      (entry) => entry.capability === "create_sheet",
    );
    const save = registry.manifest.endpoints.find(
      (entry) => entry.capability === "save_sheet_content",
    );
    expect(create?.observedHostTypes).toEqual(["personal"]);
    expect(create?.verifiedHostTypes).toEqual(["personal"]);
    expect(create?.verified).toBe(true);
    expect(create?.liveWriteEnabled).toBe(true);
    expect(registry.getWritable("initialize_sheet", "personal")).toMatchObject({
      method: "PUT",
      path: "/api/docs/{docId}/content",
      liveWriteEnabled: true,
    });
    expect(save?.observedHostTypes).toContain("personal");
    expect(save).toMatchObject({
      verified: true,
      verifiedHostTypes: expect.arrayContaining(["personal"]),
      liveWriteEnabled: true,
      liveWriteHostTypes: ["personal"],
      deletionEffect: "content",
    });
    expect(registry.get("save_sheet_content", "personal")).toMatchObject({
      verified: true,
      deletionEffect: "content",
    });
    expect(registry.getWritable("create_sheet", "personal")).toMatchObject({
      method: "POST",
      path: "/api/docs",
      liveWriteEnabled: true,
    });
    expect(
      registry.getWritable("save_sheet_content", "personal"),
    ).toMatchObject({ liveWriteHostTypes: ["personal"] });
    expect(registry.getWritable("save_doc_content", "personal")).toMatchObject({
      liveWriteHostTypes: ["personal"],
    });
    expect(registry.getWritable("publish_doc", "personal")).toMatchObject({
      liveWriteHostTypes: ["personal"],
    });
    expect(() =>
      registry.getWritable("save_doc_content", "organization"),
    ).toThrow("not enabled on the organization Host");
    expect(() => registry.getWritable("publish_doc", "organization")).toThrow(
      "not enabled on the organization Host",
    );
    expect(registry.getWritable("create_book", "personal")).toMatchObject({
      method: "POST",
      path: "/api/books",
      idempotent: false,
      liveWriteEnabled: true,
    });
    expect(registry.getWritable("delete_doc", "personal")).toMatchObject({
      method: "PUT",
      path: "/api/catalog_nodes",
      deletionEffect: "doc_object",
      targetResourceType: "Doc",
      idempotent: false,
    });
    expect(registry.getWritable("delete_sheet", "personal")).toMatchObject({
      method: "PUT",
      path: "/api/catalog_nodes",
      deletionEffect: "sheet_object",
      targetResourceType: "Sheet",
      idempotent: false,
    });
    expect(registry.getWritable("delete_book", "personal")).toMatchObject({
      method: "DELETE",
      path: "/api/books/{bookId}",
      deletionEffect: "knowledge_base",
      targetResourceType: "KnowledgeBase",
      idempotent: false,
    });
    expect(() => registry.get("create_book", "organization")).toThrow(
      "organization-host capture and replay verification",
    );
  });

  it("requires an explicit live-write gate in addition to capture verification", async () => {
    const disabled = await writableManifest(false);
    const disabledRegistry = await ContractRegistry.load(disabled);
    expect(disabledRegistry.get("update_doc_meta").verified).toBe(true);
    expect(() => disabledRegistry.getWritable("update_doc_meta")).toThrow(
      "remains disabled",
    );

    const enabled = await writableManifest(true);
    const enabledRegistry = await ContractRegistry.load(enabled);
    expect(enabledRegistry.getWritable("update_doc_meta").path).toBe(
      "/api/docs/{docId}/meta",
    );
  });

  it("encodes path parameters and rejects missing values", () => {
    expect(interpolatePath("/api/docs/{id}", { id: "a/b" })).toBe(
      "/api/docs/a%2Fb",
    );
    expect(() => interpolatePath("/api/docs/{id}", {})).toThrow(
      "Missing path parameter",
    );
  });

  it("classifies deletion by effect instead of blocking the DELETE method", async () => {
    const unclassifiedDelete = await customManifest({
      capability: "get_user",
      method: "DELETE",
      path: "/api/docs/{id}",
    });
    await expect(ContractRegistry.load(unclassifiedDelete)).rejects.toThrow(
      "must be explicitly classified",
    );

    const wholeDocumentDelete = await customManifest({
      capability: "get_user",
      method: "DELETE",
      path: "/api/docs/{id}",
      deletionEffect: "doc_object",
    });
    await expect(ContractRegistry.load(wholeDocumentDelete)).rejects.toThrow(
      "capability=delete_doc",
    );

    const sheetDeleteWithoutTypedCapability = await customManifest({
      capability: "get_user",
      method: "DELETE",
      path: "/api/docs/{id}",
      deletionEffect: "sheet_object",
      targetResourceType: "Sheet",
    });
    await expect(
      ContractRegistry.load(sheetDeleteWithoutTypedCapability),
    ).rejects.toThrow("capability=delete_sheet");

    const sheetDeleteWithoutTargetGuard = await customManifest({
      capability: "delete_sheet",
      method: "DELETE",
      path: "/api/docs/{id}",
      deletionEffect: "sheet_object",
    });
    await expect(
      ContractRegistry.load(sheetDeleteWithoutTargetGuard),
    ).rejects.toThrow("targetResourceType=Sheet");

    const typedSheetDelete = await customManifest({
      capability: "delete_sheet",
      method: "DELETE",
      path: "/api/docs/{id}",
      deletionEffect: "sheet_object",
      targetResourceType: "Sheet",
    });
    const sheetDeleteRegistry = await ContractRegistry.load(typedSheetDelete);
    expect(sheetDeleteRegistry.get("delete_sheet", "personal")).toMatchObject({
      deletionEffect: "sheet_object",
      targetResourceType: "Sheet",
    });

    const typedDocumentDelete = await customManifest({
      capability: "delete_doc",
      method: "DELETE",
      path: "/api/docs/{id}",
      deletionEffect: "doc_object",
      targetResourceType: "Doc",
    });
    await expect(
      ContractRegistry.load(typedDocumentDelete),
    ).resolves.toBeDefined();

    const lockRelease = await customManifest({
      capability: "release_doc_lock",
      method: "DELETE",
      path: "/api/docs/{docId}/lock",
      deletionEffect: "none",
    });
    const registry = await ContractRegistry.load(lockRelease);
    expect(registry.get("release_doc_lock", "personal").path).toBe(
      "/api/docs/{docId}/lock",
    );
    expect(registry.getWritable("release_doc_lock", "personal").method).toBe(
      "DELETE",
    );

    const contentDelete = await customManifest({
      capability: "get_user",
      method: "DELETE",
      path: "/api/sheets/{sheetId}/rows/{rowId}",
      deletionEffect: "content",
    });
    await expect(ContractRegistry.load(contentDelete)).resolves.toBeDefined();

    const wholeKnowledgeBaseDelete = await customManifest({
      capability: "get_user",
      method: "POST",
      path: "/api/books/force_delete",
      deletionEffect: "knowledge_base",
    });
    await expect(
      ContractRegistry.load(wholeKnowledgeBaseDelete),
    ).rejects.toThrow("capability=delete_book");

    const typedKnowledgeBaseDelete = await customManifest({
      capability: "delete_book",
      method: "DELETE",
      path: "/api/books/{bookId}",
      deletionEffect: "knowledge_base",
      targetResourceType: "KnowledgeBase",
    });
    await expect(
      ContractRegistry.load(typedKnowledgeBaseDelete),
    ).resolves.toBeDefined();
  });
});

async function manifest(
  verified: boolean,
  verifiedHostTypes?: Array<"organization" | "personal">,
  observedHostTypes?: Array<"organization" | "personal">,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yuque-contract-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "contract.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "test",
      verifiedAt: verified ? new Date().toISOString() : null,
      sourceBundles: [],
      endpoints: [
        {
          capability: "get_user",
          verified,
          ...(observedHostTypes ? { observedHostTypes } : {}),
          ...(verifiedHostTypes ? { verifiedHostTypes } : {}),
          method: "GET",
          path: "/api/mine/account",
          idempotent: true,
          requiredResponsePaths: [],
        },
      ],
    }),
  );
  return path;
}

async function customManifest(input: {
  capability: string;
  method: string;
  path: string;
  deletionEffect?:
    | "none"
    | "content"
    | "permission"
    | "doc_object"
    | "sheet_object"
    | "knowledge_base";
  targetResourceType?: "Doc" | "Sheet" | "KnowledgeBase" | "Collaboration";
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yuque-contract-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "contract.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "destructive-test",
      verifiedAt: new Date().toISOString(),
      sourceBundles: [],
      endpoints: [
        {
          capability: input.capability,
          verified: true,
          verifiedHostTypes: ["personal"],
          ...((input.deletionEffect &&
            !["none", "content"].includes(input.deletionEffect)) ||
          input.capability === "release_doc_lock"
            ? { liveWriteEnabled: true }
            : {}),
          method: input.method,
          path: input.path,
          ...(input.deletionEffect
            ? { deletionEffect: input.deletionEffect }
            : {}),
          ...(input.targetResourceType
            ? { targetResourceType: input.targetResourceType }
            : {}),
          idempotent: false,
          requiredResponsePaths: [],
        },
      ],
    }),
  );
  return path;
}

async function writableManifest(liveWriteEnabled: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yuque-contract-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "contract.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "write-gate-test",
      verifiedAt: new Date().toISOString(),
      sourceBundles: [],
      endpoints: [
        {
          capability: "update_doc_meta",
          verified: true,
          liveWriteEnabled,
          method: "PUT",
          path: "/api/docs/{docId}/meta",
          idempotent: false,
          requiredResponsePaths: ["data.id", "data.title"],
        },
      ],
    }),
  );
  return path;
}
