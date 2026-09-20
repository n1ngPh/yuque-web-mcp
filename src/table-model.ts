import { ContractError } from "./contracts.js";

type JsonObject = Record<string, unknown>;

export interface TableColumn {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; value: string }>;
}

// Field/option enumeration order can change after native copy without a schema change.
export function canonicalTableColumns(columns: TableColumn[]): TableColumn[] {
  return columns
    .map((column) => ({
      ...column,
      ...(column.options
        ? {
            options: [...column.options].sort((a, b) =>
              a.id.localeCompare(b.id),
            ),
          }
        : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface TableSheet {
  id: string;
  columns: TableColumn[];
  views: Array<{ id: string; name: string; type: string }>;
}

export function parseTableSchema(content: string): TableSheet[] {
  if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024) {
    throw new ContractError("Table schema exceeds the 10 MiB limit");
  }
  const schema = object(json(content), "Table schema");
  if (
    schema.format !== "laketable" ||
    !Array.isArray(schema.sheet) ||
    !schema.sheet.length
  ) {
    throw new ContractError("Table schema must contain laketable sheets");
  }
  const ids = new Set<string>();
  return schema.sheet.map((value) => {
    const sheet = object(value, "Table sheet");
    const id = string(sheet.id, "Table sheet id");
    if (ids.has(id)) throw new ContractError("Duplicate Table sheet id");
    ids.add(id);
    if (!Array.isArray(sheet.columns))
      throw new ContractError("Table columns must be an array");
    const columnIds = new Set<string>();
    const columns = sheet.columns.map((value): TableColumn => {
      const column = object(value, "Table column");
      const id = string(column.id, "Table column id");
      if (columnIds.has(id))
        throw new ContractError("Duplicate Table column id");
      columnIds.add(id);
      return {
        id,
        name: string(column.name, "Table column name"),
        type: string(column.type, "Table column type"),
        ...(Array.isArray(column.options)
          ? {
              options: column.options.map((value) => {
                const option = object(value, "Table option");
                return {
                  id: string(option.id, "Table option id"),
                  value: string(option.value, "Table option value"),
                };
              }),
            }
          : {}),
      };
    });
    const views = Object.values(object(sheet.views, "Table views")).map(
      (value) => {
        const view = object(value, "Table view");
        return {
          id: string(view.id, "Table view id"),
          name: string(view.name, "Table view name"),
          type: string(view.type, "Table view type"),
        };
      },
    );
    // views.data is presentation state, never evidence of record existence.
    return { id, columns, views };
  });
}

export function parseTableRecords(
  response: unknown,
  sheet: TableSheet,
  docId: string,
  limit: number,
) {
  const page = object(response, "Table records response");
  if (
    !Array.isArray(page.records) ||
    typeof page.hasMore !== "boolean" ||
    !Array.isArray(page.users)
  ) {
    throw new ContractError(
      "Table response must include records, hasMore and users",
    );
  }
  if (page.records.length > limit || (page.hasMore && !page.records.length)) {
    throw new ContractError("Table pagination did not make bounded progress");
  }
  const users = new Map<string, string>();
  for (const value of page.users) {
    const user = object(value, "Table user");
    if (typeof user.name === "string") {
      if (user.id !== undefined) users.set(String(user.id), user.name);
      if (user.user_id !== undefined)
        users.set(String(user.user_id), user.name);
    }
  }
  const ids = new Set<string>();
  const records = page.records.map((value) => {
    const row = object(value, "Table record");
    if (
      String(row.doc_id) !== docId ||
      row.doc_type !== "Doc" ||
      row.sheet_id !== sheet.id
    ) {
      throw new ContractError(
        "Table record belongs to a different document or sheet",
      );
    }
    const id = string(row.uuid, "Table record uuid");
    if (ids.has(id)) throw new ContractError("Duplicate Table record uuid");
    ids.add(id);
    const data = object(
      typeof row.data === "string" ? json(row.data) : row.data,
      "Table record data",
    );
    const cells = sheet.columns.map((column) => {
      const systemFields: Record<string, string> = {
        createdAt: "created_at",
        updatedAt: "updated_at",
        userId: "user_id",
        modifierId: "modifier_id",
      };
      const field = systemFields[column.type];
      const rawCell = data[column.id];
      const raw = field
        ? (data[column.type] ?? row[field] ?? null)
        : rawCell === undefined
          ? null
          : (object(rawCell, "Table cell").value ?? null);
      return {
        column_id: column.id,
        value: raw,
        display_value: displayValue(raw, column, users),
      };
    });
    return { id, cells };
  });
  return { records, hasMore: page.hasMore };
}

function displayValue(
  value: unknown,
  column: TableColumn,
  users: Map<string, string>,
): unknown {
  if (value === null) return null;
  const option = (id: unknown) =>
    column.options?.find((item) => item.id === id)?.value ?? id;
  if (column.type === "select") return option(value);
  if (column.type === "multiSelect" && Array.isArray(value))
    return value.map(option);
  if (column.type === "userId" || column.type === "modifierId")
    return users.get(String(value)) ?? value;
  if (column.type === "mention" && Array.isArray(value))
    return value.map((entry) => {
      const user = object(entry, "Table mention");
      return typeof user.name === "string"
        ? user.name
        : (users.get(String(user.id)) ?? user.id);
    });
  if (column.type === "date" && value && typeof value === "object") {
    const date = value as JsonObject;
    return typeof date.text === "string" ? date.text : value;
  }
  if (
    column.type === "progress" &&
    (typeof value === "number" || typeof value === "string") &&
    String(value).trim() &&
    Number.isFinite(Number(value))
  )
    return `${Number(value)}%`;
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError(`${label} must be an object`);
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new ContractError(`${label} must be a non-empty string`);
  return value;
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ContractError("Invalid Table JSON payload");
  }
}
