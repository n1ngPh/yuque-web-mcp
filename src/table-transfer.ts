import { canonicalTableColumns } from "./table-model.js";
import { fingerprint } from "./crypto.js";
import { ContractError } from "./contracts.js";
import type { CatalogNode, NormalizedBook } from "./yuque-client.js";
import type { TableArchiveSnapshot } from "./table-archive.js";

export interface TableTransferInput {
  action: "copy" | "move";
  sourceUrl: string;
  targetBookUrl: string;
  targetParentUuid?: string;
}
export interface TableTransferPlan {
  input: TableTransferInput;
  sourceBook: NormalizedBook;
  targetBook: NormalizedBook;
  source: TableArchiveSnapshot;
  sourceNode: CatalogNode;
  sourceCatalog: CatalogNode[];
  targetCatalog: CatalogNode[];
  targetPath: string;
  contentFingerprint: string;
  baselineFingerprint: string;
  phase: "prepared" | "transmitting" | "acknowledged" | "completed";
  resultDocId?: number;
  resultUrl?: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export function transferContentFingerprint(
  table: TableArchiveSnapshot,
  bodies: Record<string, unknown>,
): string {
  const rows = table.records
    .map((r) => {
      if (!Object.hasOwn(bodies, r.uuid))
        throw new ContractError("Table transfer row description is missing");
      const data = Object.fromEntries(
        Object.entries(r.data).filter(
          ([key]) =>
            !["createdAt", "updatedAt", "userId", "modifierId"].includes(key),
        ),
      );
      return fingerprint(stable({ data, body: bodies[r.uuid] }));
    })
    .sort();
  return fingerprint(
    stable({
      columns: canonicalTableColumns(table.columns),
      rows,
    }),
  );
}
export function transferCatalogFingerprint(
  nodes: CatalogNode[],
  ignoreDocIds: number[] = [],
): string {
  return fingerprint(
    nodes
      .filter((n) => !n.docId || !ignoreDocIds.includes(n.docId))
      .map((n) => ({
        uuid: n.uuid,
        title: n.title,
        type: n.type,
        parentUuid: n.parentUuid ?? "",
        docId: n.docId ?? null,
        docSlug: n.docSlug ?? null,
      })),
  );
}
export function prepareTransferPlan(
  input: TableTransferInput,
  sourceBook: NormalizedBook,
  targetBook: NormalizedBook,
  source: TableArchiveSnapshot,
  sourceCatalog: CatalogNode[],
  targetCatalog: CatalogNode[],
  contentFingerprint: string,
): TableTransferPlan {
  if (sourceBook.host !== targetBook.host || sourceBook.id === targetBook.id)
    throw new ContractError(
      "Native Table transfer requires different knowledge bases on the same organization Host",
    );
  const sourceNode = sourceCatalog.find((n) => String(n.docId) === source.id);
  if (
    !sourceNode ||
    sourceCatalog.some((n) => n.parentUuid === sourceNode.uuid)
  )
    throw new ContractError(
      "Only a single Table without child catalog nodes can be transferred",
    );
  const parent = input.targetParentUuid
    ? targetCatalog.find((n) => n.uuid === input.targetParentUuid)
    : undefined;
  if (input.targetParentUuid && (!parent || parent.type !== "TITLE"))
    throw new ContractError(
      "Target parent must be an existing directory TITLE node",
    );
  if (
    targetCatalog.some(
      (n) =>
        n.title === sourceNode.title &&
        (n.parentUuid ?? "") === (parent?.uuid ?? ""),
    )
  )
    throw new ContractError(
      "A same-title object already exists in the target directory",
    );
  const targetPath = `${parent?.displayPath ?? `${targetBook.scopeLabel} / ${targetBook.name}`} / ${sourceNode.title}`;
  const plan: TableTransferPlan = {
    input,
    sourceBook,
    targetBook,
    source,
    sourceNode,
    sourceCatalog,
    targetCatalog,
    targetPath,
    contentFingerprint,
    baselineFingerprint: "",
    phase: "prepared",
  };
  plan.baselineFingerprint = fingerprint(
    stable({
      input,
      sourceBook: { id: sourceBook.id, private: sourceBook.private },
      targetBook: { id: targetBook.id, private: targetBook.private },
      sourceId: source.id,
      sourceCatalog: transferCatalogFingerprint(sourceCatalog),
      targetCatalog: transferCatalogFingerprint(targetCatalog),
      contentFingerprint,
    }),
  );
  return plan;
}
