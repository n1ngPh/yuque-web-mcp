import { ContractError } from "./contracts.js";
import type { TableColumn, parseTableRecords } from "./table-model.js";

type Row = ReturnType<typeof parseTableRecords>["records"][number];
type Scalar = string | number | boolean | null;
export interface TableQueryInput {
  filter?: unknown;
  columns?: unknown;
  raw?: unknown;
  groupBy?: unknown;
}
const fail = (message: string): never => {
  throw new ContractError(message);
};
export function resolveColumn(
  columns: TableColumn[],
  key: string,
): TableColumn {
  const byId = columns.find((c) => c.id === key);
  if (byId) return byId;
  const matches = columns.filter((c) => c.name === key);
  if (matches.length !== 1)
    return fail(`Unknown or ambiguous Table column: ${key}`);
  return matches[0]!;
}
function fieldList(
  value: unknown,
  columns: TableColumn[],
  max: number,
): TableColumn[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    !value.every((k) => typeof k === "string")
  )
    return fail(`Expected 1-${max} column names or IDs`);
  const selected = value.map((k) => resolveColumn(columns, k));
  if (new Set(selected.map((c) => c.id)).size !== selected.length)
    return fail("Duplicate Table columns");
  return selected;
}
export function prepareTableQuery(
  columns: TableColumn[],
  input: TableQueryInput,
) {
  if (input.raw !== undefined && typeof input.raw !== "boolean")
    fail("raw must be a boolean");
  const selected =
    input.columns === undefined
      ? columns
      : fieldList(input.columns, columns, 100);
  const groups =
    input.groupBy === undefined
      ? undefined
      : fieldList(input.groupBy, columns, 10);
  const filters: Array<{
    column: TableColumn;
    value: Scalar | { id: string };
  }> = [];
  if (input.filter !== undefined) {
    if (
      !input.filter ||
      typeof input.filter !== "object" ||
      Array.isArray(input.filter)
    )
      fail("filter must be a column-to-value object");
    const entries = Object.entries(input.filter as Record<string, unknown>);
    if (entries.length > 20) fail("At most 20 filter fields are supported");
    for (const [key, value] of entries) {
      const column = resolveColumn(columns, key);
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (
          Array.isArray(value) ||
          Object.keys(v).length !== 1 ||
          typeof v.id !== "string" ||
          !v.id ||
          ![
            "mention",
            "userId",
            "modifierId",
            "select",
            "multiSelect",
          ].includes(column.type)
        )
          fail("ID filters require {id: string} on a person or option column");
      } else if (
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value)
      )
        fail("Invalid filter value");
      if (typeof value === "number" && !Number.isFinite(value))
        fail("Filter number must be finite");
      filters.push({ column, value: value as Scalar | { id: string } });
    }
  }
  const matches = (row: Row) =>
    filters.every(({ column, value }) => {
      const cell = row.cells.find((c) => c.column_id === column.id)!;
      if (value && typeof value === "object") {
        const ids = Array.isArray(cell.value) ? cell.value : [cell.value];
        return ids.some(
          (v) =>
            String(
              v && typeof v === "object" ? (v as { id?: unknown }).id : v,
            ) === value.id,
        );
      }
      if (value === null)
        return (
          cell.value === null ||
          (Array.isArray(cell.value) && !cell.value.length)
        );
      if (column.type === "progress") {
        const expected = Number(String(value).replace(/%$/, ""));
        return (
          cell.value !== null &&
          String(cell.value).trim() !== "" &&
          String(value).trim() !== "" &&
          Number.isFinite(expected) &&
          Number(cell.value) === expected
        );
      }
      return Array.isArray(cell.display_value)
        ? cell.display_value.includes(value)
        : cell.display_value === value;
    });
  return { selected, groups, matches };
}

export function tableDistributions(rows: Row[], groups: TableColumn[]) {
  return groups.map((column) => {
    const counts = new Map<
      string,
      { value: unknown; label: unknown; count: number }
    >();
    for (const row of rows) {
      const cell = row.cells.find((c) => c.column_id === column.id)!;
      let values: Array<{ value: unknown; label: unknown }>;
      if (column.type === "mention" && Array.isArray(cell.value)) {
        values = cell.value.map((v, i) => ({
          value: String((v as { id: unknown }).id),
          label: Array.isArray(cell.display_value)
            ? cell.display_value[i]
            : null,
        }));
      } else if (column.type === "multiSelect" && Array.isArray(cell.value)) {
        values = cell.value.map((v, i) => ({
          value: v,
          label: Array.isArray(cell.display_value) ? cell.display_value[i] : v,
        }));
      } else {
        const value =
          ["userId", "modifierId"].includes(column.type) && cell.value !== null
            ? String(cell.value)
            : column.type === "progress" && cell.value !== null
              ? Number(cell.value)
              : cell.value;
        values = [{ value, label: cell.display_value }];
      }
      if (!values.length) values = [{ value: null, label: null }];
      const seen = new Set<string>();
      for (const item of values) {
        const key = JSON.stringify(item.value);
        if (seen.has(key)) continue;
        seen.add(key);
        const old = counts.get(key);
        if (old) old.count++;
        else counts.set(key, { ...item, count: 1 });
      }
    }
    const all = [...counts.values()].sort(
      (a, b) =>
        b.count - a.count ||
        JSON.stringify(a.value).localeCompare(JSON.stringify(b.value)),
    );
    return {
      column_id: column.id,
      column_name: column.name,
      buckets: all.slice(0, 100),
      distinct_count: all.length,
      truncated: all.length > 100,
      omitted_memberships: all.slice(100).reduce((s, v) => s + v.count, 0),
    };
  });
}

export function boundedTableOutput(
  result: Record<string, unknown>,
  records?: Array<unknown>,
  offset = 0,
) {
  const maxBytes = 40 * 1024;
  // Budget the pretty-printed, escaped MCP content, not just compact raw JSON.
  const size = () =>
    Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }),
    );
  if (records) {
    while (size() > maxBytes && records.length > 1) {
      records.length = Math.max(1, Math.floor(records.length / 2));
      result.has_more = true;
      result.complete = false;
      result.returned_count = records.length;
      result.next_offset = offset + records.length;
      result.output_limited = true;
    }
  }
  if (size() > maxBytes)
    fail(
      "Table result exceeds 40 KiB; select fewer columns/group fields or narrower filters. A single large value may require the legacy full read saved directly to a file.",
    );
  return result;
}
