import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ContractError } from "./contracts.js";
import { fingerprint } from "./crypto.js";
import { canonicalTableColumns, type TableColumn } from "./table-model.js";

export interface TableArchiveInput {
  sourceUrl: string;
  targetUrl: string;
  recordId: string;
  sourceSheetId?: string;
  targetSheetId?: string;
}
export interface ArchiveRecord {
  uuid: string;
  data: Record<string, unknown>;
  user_id?: unknown;
  modifier_id?: unknown;
  [key: string]: unknown;
}
export interface TableArchiveSnapshot {
  url: string;
  displayPath: string;
  id: string;
  bookUrl: string;
  sheetId: string;
  view: { id: string; type: string };
  columns: TableColumn[];
  records: ArchiveRecord[];
}
export interface ArchiveTarget {
  url: string;
  displayPath: string;
  id: string;
  bookUrl: string;
  sheetId: string;
  view: { id: string; type: string };
  columns: TableColumn[];
  recordFingerprints: Record<string, string>;
}
export interface TableArchivePlan {
  source: ArchiveTarget;
  target: ArchiveTarget;
  sourceRecord: ArchiveRecord;
  targetRecordId: string;
  fields: Array<{
    sourceId: string;
    targetId: string;
    name: string;
    type: string;
    value: unknown;
    displayValue: unknown;
  }>;
  phase:
    | "prepared"
    | "creating_target"
    | "writing_target"
    | "target_verified"
    | "removing_source"
    | "completed";
}
export interface TableArchiveIO {
  read(target: ArchiveTarget): Promise<TableArchiveSnapshot>;
  content(target: ArchiveTarget, recordId: string): Promise<unknown>;
  assertWritable(): void;
  create(target: ArchiveTarget, recordId: string): Promise<void>;
  populate(plan: TableArchivePlan): Promise<void>;
  remove(target: ArchiveTarget, recordId: string): Promise<void>;
}

const SYSTEM = new Set(["createdAt", "updatedAt", "userId", "modifierId"]);
const SUPPORTED = new Set([
  "text",
  "input",
  "select",
  "multiSelect",
  "mention",
  "date",
  "progress",
]);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError("Archive expected an object");
  return value as Record<string, unknown>;
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
export function archiveRecordFingerprint(row: ArchiveRecord): string {
  return fingerprint(stable(row));
}
function rowFingerprints(rows: ArchiveRecord[]): Record<string, string> {
  if (
    rows.length > 5000 ||
    new Set(rows.map((r) => r.uuid)).size !== rows.length
  )
    throw new ContractError(
      "Archive requires unique records and at most 5000 rows per table",
    );
  return Object.fromEntries(
    rows.map((r) => [r.uuid, archiveRecordFingerprint(r)]),
  );
}
function descriptor(snapshot: TableArchiveSnapshot): ArchiveTarget {
  const { records, ...rest } = snapshot;
  return { ...rest, recordFingerprints: rowFingerprints(records) };
}
function businessCells(row: ArchiveRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row.data).filter(([key]) => !SYSTEM.has(key)),
  );
}
function nonempty(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    !(Array.isArray(value) && value.length === 0)
  );
}
function cellValue(cell: unknown): unknown {
  const record = object(cell);
  if (Object.keys(record).some((k) => k !== "value"))
    throw new ContractError(
      "Archive cannot preserve this cell's additional metadata",
    );
  return record.value ?? null;
}
function canonical(type: string, value: unknown): unknown {
  if (!nonempty(value)) return null;
  if (type === "text" || type === "input" || type === "select") {
    if (typeof value !== "string")
      throw new ContractError("Archive expected a string cell");
    return value;
  }
  if (type === "multiSelect") {
    if (
      !Array.isArray(value) ||
      !value.every((v) => typeof v === "string") ||
      new Set(value).size !== value.length
    )
      throw new ContractError("Invalid multi-select archive value");
    return [...value].sort();
  }
  if (type === "mention") {
    if (!Array.isArray(value) || !value.length)
      throw new ContractError("Invalid personnel archive value");
    const ids = value.map((v) => String(object(v).id));
    if (ids.some((id) => !/^\d+$/.test(id)) || new Set(ids).size !== ids.length)
      throw new ContractError(
        "Archive personnel must have unique numeric account IDs",
      );
    return ids.sort();
  }
  if (type === "date") {
    const time = object(value).time;
    if (typeof time !== "string" || !Number.isFinite(Date.parse(time)))
      throw new ContractError("Archive date must contain a valid time");
    return new Date(time).toISOString();
  }
  if (type === "progress") {
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      !/^\d+(?:\.\d+)?$/.test(String(value)) ||
      !Number.isFinite(Number(value)) ||
      Number(value) > 100
    )
      throw new ContractError("Archive progress must be between 0 and 100");
    return Number(value);
  }
  throw new ContractError(`Unsupported nonempty archive field type: ${type}`);
}
function option(column: TableColumn, id: unknown): string {
  const matches = column.options?.filter((o) => o.id === id) ?? [];
  if (matches.length !== 1)
    throw new ContractError(`Unknown option in archive field: ${column.name}`);
  return matches[0]!.value;
}
function mappedValue(
  source: TableColumn,
  target: TableColumn,
  value: unknown,
): { value: unknown; displayValue: unknown } {
  canonical(source.type, value);
  if (source.type === "select" || source.type === "multiSelect") {
    const ids = source.type === "select" ? [value] : (value as string[]);
    const labels = ids.map((id) => option(source, id));
    const mapped = labels.map((label) => {
      const found = target.options?.filter((o) => o.value === label) ?? [];
      if (found.length !== 1)
        throw new ContractError(
          `Archive target option is missing or ambiguous: ${target.name}`,
        );
      return found[0]!.id;
    });
    return {
      value: source.type === "select" ? mapped[0] : mapped,
      displayValue: source.type === "select" ? labels[0] : labels,
    };
  }
  if (source.type === "date")
    return {
      value: { time: canonical("date", value) },
      displayValue: object(value).text ?? object(value).time,
    };
  if (source.type === "mention")
    return {
      value,
      displayValue: (value as unknown[]).map(
        (v) => object(v).name ?? object(v).id,
      ),
    };
  return { value, displayValue: value };
}
export function prepareTableArchive(
  source: TableArchiveSnapshot,
  target: TableArchiveSnapshot,
  recordId: string,
): TableArchivePlan {
  if (
    source.url === target.url ||
    source.id === target.id ||
    source.bookUrl !== target.bookUrl ||
    new URL(source.url).origin !== new URL(target.url).origin
  )
    throw new ContractError(
      "Archive requires two different Tables in the same knowledge base",
    );
  if (target.records.length >= 5000)
    throw new ContractError(
      "Archive target must have fewer than 5000 rows to allow complete read-back after creation",
    );
  const row = source.records.find((r) => r.uuid === recordId);
  if (!row) throw new ContractError("Source archive record was not found");
  const fields: TableArchivePlan["fields"] = [];
  for (const [id, cell] of Object.entries(businessCells(row))) {
    const value = cellValue(cell);
    if (!nonempty(value)) continue;
    const column = source.columns.find((c) => c.id === id);
    if (!column || SYSTEM.has(column.type) || !SUPPORTED.has(column.type))
      throw new ContractError(
        "Archive would lose an unknown or unsupported nonempty field",
      );
    const sameId = target.columns.find((c) => c.id === id);
    const candidates = sameId
      ? [sameId]
      : target.columns.filter(
          (c) => c.name === column.name && c.type === column.type,
        );
    if (
      candidates.length !== 1 ||
      candidates[0]!.name !== column.name ||
      candidates[0]!.type !== column.type
    )
      throw new ContractError(
        `Missing, incompatible or ambiguous archive field: ${column.name}`,
      );
    const mapped = candidates[0]!;
    if (fields.some((f) => f.targetId === mapped.id))
      throw new ContractError(
        "Multiple source fields map to one archive field",
      );
    fields.push({
      sourceId: id,
      targetId: mapped.id,
      name: column.name,
      type: column.type,
      ...mappedValue(column, mapped, value),
    });
  }
  if (!fields.length)
    throw new ContractError("Empty records cannot be archived");
  if (Buffer.byteLength(JSON.stringify(fields)) > 1024 * 1024)
    throw new ContractError("Archive record exceeds the 1 MiB write limit");
  const plan: TableArchivePlan = {
    source: descriptor(source),
    target: descriptor(target),
    sourceRecord: row,
    targetRecordId: randomBytes(16).toString("hex"),
    fields,
    phase: "prepared",
  };
  if (target.records.some((r) => matchesArchiveValues(plan, r)))
    throw new ContractError(
      "An equivalent record already exists in the archive; reconcile before creating another copy",
    );
  return plan;
}
export function matchesArchiveValues(
  plan: TableArchivePlan,
  row: ArchiveRecord,
): boolean {
  try {
    const populated = Object.entries(businessCells(row)).filter(([, v]) =>
      nonempty(cellValue(v)),
    );
    if (populated.length !== plan.fields.length) return false;
    return plan.fields.every((f) =>
      isDeepStrictEqual(
        canonical(f.type, cellValue(row.data[f.targetId])),
        canonical(f.type, f.value),
      ),
    );
  } catch {
    return false;
  }
}
function unchanged(
  expected: ArchiveTarget,
  current: TableArchiveSnapshot,
  ignore: string[] = [],
): void {
  if (
    current.id !== expected.id ||
    current.sheetId !== expected.sheetId ||
    current.url !== expected.url ||
    current.bookUrl !== expected.bookUrl ||
    !isDeepStrictEqual(
      stable(canonicalTableColumns(current.columns)),
      stable(canonicalTableColumns(expected.columns)),
    )
  )
    throw new ContractError(
      "Archive table identity or schema changed after Preview",
    );
  const omit = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).filter(([id]) => !ignore.includes(id)),
    );
  if (
    !isDeepStrictEqual(
      omit(expected.recordFingerprints),
      omit(rowFingerprints(current.records)),
    )
  )
    throw new ContractError(
      "Table records changed after Preview; do not overwrite concurrent changes",
    );
}
async function emptyBody(
  io: TableArchiveIO,
  target: ArchiveTarget,
  id: string,
): Promise<void> {
  if ((await io.content(target, id)) !== null)
    throw new ContractError(
      "Nonempty or unknown record descriptions cannot be archived without loss",
    );
}
function verifyCopy(
  plan: TableArchivePlan,
  target: TableArchiveSnapshot,
): void {
  unchanged(plan.target, target, [plan.targetRecordId]);
  const row = target.records.find((r) => r.uuid === plan.targetRecordId);
  if (!row || !matchesArchiveValues(plan, row))
    throw new ContractError(
      "Archive copy read-back does not match all business fields",
    );
}
export class TableArchiveExecutionError extends Error {
  constructor(
    readonly state: "conflict" | "partial" | "unknown",
    readonly phase: TableArchivePlan["phase"],
  ) {
    super(
      `Table archive stopped at ${phase}; inspect archive status and reconcile both record IDs before any new write`,
    );
    this.name = "TableArchiveExecutionError";
  }
}
export async function executeTableArchive(
  plan: TableArchivePlan,
  io: TableArchiveIO,
  checkpoint: () => void,
): Promise<Record<string, unknown>> {
  let attempted = false,
    writePending = false;
  try {
    if (plan.phase !== "prepared")
      throw new ContractError(
        "Archive execution cannot be resumed or retried automatically",
      );
    io.assertWritable();
    unchanged(plan.source, await io.read(plan.source));
    unchanged(plan.target, await io.read(plan.target));
    await emptyBody(io, plan.source, plan.sourceRecord.uuid);
    const write = async (
      phase: TableArchivePlan["phase"],
      fn: () => Promise<void>,
    ) => {
      io.assertWritable();
      plan.phase = phase;
      checkpoint();
      attempted = true;
      writePending = true;
      await fn();
      writePending = false;
    };
    await write("creating_target", () =>
      io.create(plan.target, plan.targetRecordId),
    );
    const created = await io.read(plan.target);
    unchanged(plan.target, created, [plan.targetRecordId]);
    const newRow = created.records.find((r) => r.uuid === plan.targetRecordId);
    if (
      !newRow ||
      Object.values(businessCells(newRow)).some((c) => nonempty(cellValue(c)))
    )
      throw new ContractError(
        "New archive record is missing or already contains values",
      );
    await write("writing_target", () => io.populate(plan));
    verifyCopy(plan, await io.read(plan.target));
    await emptyBody(io, plan.target, plan.targetRecordId);
    plan.phase = "target_verified";
    checkpoint();
    verifyCopy(plan, await io.read(plan.target));
    await emptyBody(io, plan.target, plan.targetRecordId);
    // Re-read source last, after the verified copy, before deleting exactly its fixed ID.
    unchanged(plan.source, await io.read(plan.source));
    await emptyBody(io, plan.source, plan.sourceRecord.uuid);
    await write("removing_source", () =>
      io.remove(plan.source, plan.sourceRecord.uuid),
    );
    const source = await io.read(plan.source),
      target = await io.read(plan.target);
    unchanged(plan.source, source, [plan.sourceRecord.uuid]);
    if (source.records.some((r) => r.uuid === plan.sourceRecord.uuid))
      throw new ContractError("Source record is still present after remove");
    verifyCopy(plan, target);
    await emptyBody(io, plan.target, plan.targetRecordId);
    plan.phase = "completed";
    checkpoint();
    return {
      state: "succeeded",
      source_url: plan.source.url,
      target_url: plan.target.url,
      source_record_id: plan.sourceRecord.uuid,
      target_record_id: plan.targetRecordId,
      source_count: source.records.length,
      target_count: target.records.length,
      unchanged_source_records: source.records.length,
      unchanged_target_records: target.records.length - 1,
    };
  } catch {
    throw new TableArchiveExecutionError(
      !attempted
        ? "conflict"
        : writePending || plan.phase === "removing_source"
          ? "unknown"
          : "partial",
      plan.phase,
    );
  }
}
export async function reconcileTableArchive(
  plan: TableArchivePlan,
  io: TableArchiveIO,
): Promise<Record<string, unknown>> {
  const source = await io.read(plan.source),
    target = await io.read(plan.target);
  const original = source.records.find(
      (r) => r.uuid === plan.sourceRecord.uuid,
    ),
    copy = target.records.find((r) => r.uuid === plan.targetRecordId);
  const copyMatches = !!copy && matchesArchiveValues(plan, copy);
  let otherRecordsUnchanged = true;
  try {
    unchanged(plan.source, source, [plan.sourceRecord.uuid]);
    unchanged(plan.target, target, [plan.targetRecordId]);
  } catch {
    otherRecordsUnchanged = false;
  }
  const sourceBodyEmpty = original
    ? (await io.content(plan.source, original.uuid)) === null
    : null;
  const targetBodyEmpty = copy
    ? (await io.content(plan.target, copy.uuid)) === null
    : null;
  return {
    source_present: !!original,
    target_present: !!copy,
    source_unchanged: original
      ? archiveRecordFingerprint(original) ===
        archiveRecordFingerprint(plan.sourceRecord)
      : null,
    target_values_match: copyMatches,
    other_records_unchanged: otherRecordsUnchanged,
    source_body_empty: sourceBodyEmpty,
    target_body_empty: targetBodyEmpty,
    observed_complete:
      !original && copyMatches && targetBodyEmpty && otherRecordsUnchanged,
    automatic_retry_allowed: false,
  };
}
