import { fingerprint } from "./crypto.js";
import { recalculateSheetFormulas } from "./sheet-formula.js";

export type SheetScalar = string | number | boolean | null;

export interface SheetCellStyle {
  numberFormat?: string;
  bold?: boolean;
  italic?: boolean;
  textColor?: string;
  fillColor?: string;
  horizontalAlign?: "left" | "center" | "right";
}

export interface SheetCell {
  value: SheetScalar;
  formula?: string;
  style?: SheetCellStyle;
  kind?: string;
  unsupported?: boolean;
}

export interface SheetWorksheet {
  id: string;
  name: string;
  rowCount?: number;
  columnCount?: number;
  cells: Record<string, SheetCell>;
}

export interface NormalizedWorkbook {
  id: string;
  title: string;
  revision?: string;
  opaqueStructureFingerprint?: string;
  worksheets: SheetWorksheet[];
  fingerprint: string;
}

export type SheetOperation =
  | {
      op: "set_range";
      worksheetId: string;
      range: string;
      cells: SheetCell[][];
    }
  | {
      op: "append_rows";
      worksheetId: string;
      rows: SheetCell[][];
    }
  | {
      op: "add_worksheet";
      name: string;
      rows?: SheetCell[][];
    }
  | {
      op: "rename_worksheet";
      worksheetId: string;
      name: string;
    }
  | {
      op: "delete_rows";
      worksheetId: string;
      startRow: number;
      count: 1;
    }
  | {
      op: "delete_columns";
      worksheetId: string;
      startColumn: number;
      count: 1;
    }
  | {
      op: "delete_worksheet";
      worksheetId: string;
    };

export type SheetDiffEntry =
  | {
      kind: "cell";
      worksheet: string;
      cell: string;
      before?: SheetCell;
      after?: SheetCell;
      deletion: boolean;
    }
  | {
      kind: "structure";
      worksheet: string;
      structure: "rows" | "columns" | "worksheet";
      start?: number;
      count: 1;
      deletion: true;
    }
  | {
      kind: "structure";
      worksheet: string;
      structure: "worksheet_name";
      before: string;
      after: string;
      count: 1;
      deletion: false;
    };

export interface AppliedSheetChange {
  workbook: NormalizedWorkbook;
  diff: SheetDiffEntry[];
}

export function validateSheetOperations(
  operations: unknown,
  maxCells = 10_000,
): SheetOperation[] {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  let affectedCells = 0;
  let structuralDeletionCount = 0;
  let worksheetRenameCount = 0;
  const validated = operations.map((value, index) => {
    const record = asRecord(value, `operations[${index}]`);
    const op = requireString(record, "op");
    if (op === "set_range") {
      const worksheetId = requireWorksheetId(record);
      const range = requireString(record, "range");
      const cells = validateCellMatrix(record.cells, `${op}.cells`);
      const parsed = parseA1Range(range);
      const expectedRows = parsed.endRow - parsed.startRow + 1;
      const expectedColumns = parsed.endColumn - parsed.startColumn + 1;
      if (
        cells.length !== expectedRows ||
        cells.some((row) => row.length !== expectedColumns)
      ) {
        throw new Error("set_range cell matrix dimensions do not match range");
      }
      affectedCells += expectedRows * expectedColumns;
      return { op, worksheetId, range, cells } satisfies SheetOperation;
    }
    if (op === "append_rows") {
      const worksheetId = requireWorksheetId(record);
      const rows = validateCellMatrix(record.rows, `${op}.rows`);
      affectedCells += rows.reduce((count, row) => count + row.length, 0);
      return { op, worksheetId, rows } satisfies SheetOperation;
    }
    if (op === "add_worksheet") {
      const name = validateWorksheetName(requireString(record, "name"));
      const rows =
        record.rows === undefined
          ? undefined
          : validateCellMatrix(record.rows, `${op}.rows`);
      affectedCells += rows?.reduce((count, row) => count + row.length, 0) ?? 0;
      return { op, name, ...(rows ? { rows } : {}) } satisfies SheetOperation;
    }
    if (op === "rename_worksheet") {
      worksheetRenameCount += 1;
      return {
        op,
        worksheetId: requireWorksheetId(record),
        name: validateWorksheetName(requireString(record, "name")),
      } satisfies SheetOperation;
    }
    if (op === "delete_rows") {
      structuralDeletionCount += 1;
      const worksheetId = requireWorksheetId(record);
      const startRow = requirePositiveIntegerAlias(
        record,
        "start_row",
        "startRow",
      );
      if (startRow !== 11) {
        throw new Error("Only start_row=11 has completed structural replay");
      }
      const count = requireVerifiedSingleDeletionCount(record);
      return { op, worksheetId, startRow, count } satisfies SheetOperation;
    }
    if (op === "delete_columns") {
      structuralDeletionCount += 1;
      const worksheetId = requireWorksheetId(record);
      const startColumn = requirePositiveIntegerAlias(
        record,
        "start_column",
        "startColumn",
      );
      if (startColumn !== 11) {
        throw new Error("Only start_column=11 has completed structural replay");
      }
      const count = requireVerifiedSingleDeletionCount(record);
      return {
        op,
        worksheetId,
        startColumn,
        count,
      } satisfies SheetOperation;
    }
    if (op === "delete_worksheet") {
      structuralDeletionCount += 1;
      return {
        op,
        worksheetId: requireWorksheetId(record),
      } satisfies SheetOperation;
    }
    throw new Error(`Unsupported Sheet operation: ${op}`);
  });
  if (
    structuralDeletionCount > 1 ||
    (structuralDeletionCount && operations.length > 1)
  ) {
    throw new Error(
      "A preview may contain exactly one verified structural deletion operation",
    );
  }
  if (
    worksheetRenameCount > 1 ||
    (worksheetRenameCount && operations.length > 1)
  ) {
    throw new Error(
      "A preview may contain exactly one verified worksheet rename operation",
    );
  }
  if (affectedCells > maxCells) {
    throw new Error(`Sheet change exceeds the ${maxCells} cell limit`);
  }
  return validated;
}

export function applySheetOperations(
  workbook: NormalizedWorkbook,
  values: unknown,
): AppliedSheetChange {
  const operations = validateSheetOperations(values);
  const worksheets = workbook.worksheets.map((worksheet) => ({
    ...worksheet,
    cells: Object.fromEntries(
      Object.entries(worksheet.cells).map(([address, cell]) => [
        address,
        cloneCell(cell),
      ]),
    ),
  }));
  const touched = new Map<
    string,
    { worksheetId: string; worksheetName: string; address: string }
  >();
  const touchedWorksheetIds = new Set<string>();
  const structuralDiff: SheetDiffEntry[] = [];
  for (const operation of operations) {
    if (operation.op === "add_worksheet") {
      if (worksheets.some((worksheet) => worksheet.name === operation.name)) {
        throw new Error(`Worksheet name already exists: ${operation.name}`);
      }
      const id = `local-${fingerprint({
        workbook: workbook.id,
        name: operation.name,
        index: worksheets.length,
      }).slice(0, 16)}`;
      const worksheet: SheetWorksheet = {
        id,
        name: operation.name,
        rowCount: 200,
        columnCount: 26,
        cells: {},
      };
      worksheets.push(worksheet);
      if (operation.rows) {
        const range = matrixRange(1, 1, operation.rows);
        writeMatrix(worksheet, range, operation.rows, touched);
        touchedWorksheetIds.add(worksheet.id);
      }
      continue;
    }
    if (operation.op === "rename_worksheet") {
      const worksheet = worksheets.find(
        (candidate) => candidate.id === operation.worksheetId,
      );
      if (!worksheet) {
        throw new Error(`Worksheet was not found: ${operation.worksheetId}`);
      }
      if (worksheet.name === operation.name) {
        throw new Error("Worksheet rename must change the name");
      }
      assertVerifiedWorksheetRenameCells(worksheet);
      if (
        worksheets.some((candidate) =>
          Object.values(candidate.cells).some((cell) =>
            formulaReferencesWorksheet(cell.formula, worksheet.name),
          ),
        )
      ) {
        throw new Error(
          "Worksheet rename with formula references has not completed replay verification",
        );
      }
      if (
        worksheets.some(
          (candidate) =>
            candidate.id !== worksheet.id && candidate.name === operation.name,
        )
      ) {
        throw new Error(`Worksheet name already exists: ${operation.name}`);
      }
      const before = worksheet.name;
      worksheet.name = operation.name;
      structuralDiff.push({
        kind: "structure",
        worksheet: before,
        structure: "worksheet_name",
        before,
        after: operation.name,
        count: 1,
        deletion: false,
      });
      continue;
    }
    if (operation.op === "delete_worksheet") {
      if (worksheets.length === 1) {
        throw new Error("The last worksheet cannot be deleted");
      }
      const worksheetIndex = worksheets.findIndex(
        (candidate) => candidate.id === operation.worksheetId,
      );
      if (worksheetIndex < 0) {
        throw new Error(`Worksheet was not found: ${operation.worksheetId}`);
      }
      const worksheet = worksheets[worksheetIndex]!;
      assertEmptyStructuralDeletionTarget(worksheet);
      worksheets.splice(worksheetIndex, 1);
      structuralDiff.push({
        kind: "structure",
        worksheet: worksheet.name,
        structure: "worksheet",
        count: 1,
        deletion: true,
      });
      continue;
    }
    const worksheet = worksheets.find(
      (candidate) => candidate.id === operation.worksheetId,
    );
    if (!worksheet) {
      throw new Error(`Worksheet was not found: ${operation.worksheetId}`);
    }
    if (operation.op === "delete_rows") {
      assertEmptyStructuralDeletionTarget(worksheet);
      if (
        !worksheet.rowCount ||
        operation.startRow > worksheet.rowCount ||
        worksheet.rowCount <= operation.count
      ) {
        throw new Error("delete_rows is outside the verified worksheet bounds");
      }
      worksheet.rowCount -= operation.count;
      structuralDiff.push({
        kind: "structure",
        worksheet: worksheet.name,
        structure: "rows",
        start: operation.startRow,
        count: operation.count,
        deletion: true,
      });
      continue;
    }
    if (operation.op === "delete_columns") {
      assertEmptyStructuralDeletionTarget(worksheet);
      if (
        !worksheet.columnCount ||
        operation.startColumn > worksheet.columnCount ||
        worksheet.columnCount <= operation.count
      ) {
        throw new Error(
          "delete_columns is outside the verified worksheet bounds",
        );
      }
      worksheet.columnCount -= operation.count;
      structuralDiff.push({
        kind: "structure",
        worksheet: worksheet.name,
        structure: "columns",
        start: operation.startColumn,
        count: operation.count,
        deletion: true,
      });
      continue;
    }
    if (operation.op === "set_range") {
      writeMatrix(worksheet, operation.range, operation.cells, touched);
      touchedWorksheetIds.add(worksheet.id);
      continue;
    }
    const startRow = lastUsedRow(worksheet) + 1;
    const range = matrixRange(startRow, 1, operation.rows);
    writeMatrix(worksheet, range, operation.rows, touched);
    touchedWorksheetIds.add(worksheet.id);
  }
  for (const worksheet of worksheets) {
    if (!touchedWorksheetIds.has(worksheet.id)) continue;
    const formulaAddresses = Object.entries(worksheet.cells)
      .filter(([, cell]) => Boolean(cell.formula))
      .map(([address]) => address);
    if (formulaAddresses.length) {
      recalculateSheetFormulas(worksheet, formulaAddresses);
    }
    for (const address of formulaAddresses) {
      const before = workbook.worksheets.find(
        (candidate) => candidate.id === worksheet.id,
      )?.cells[address];
      const after = worksheet.cells[address];
      if (
        fingerprint(before ?? { value: null }) ===
        fingerprint(after ?? { value: null })
      )
        continue;
      touched.set(`${worksheet.id}:${address}`, {
        worksheetId: worksheet.id,
        worksheetName: worksheet.name,
        address,
      });
    }
  }
  const diff = Array.from(touched.values()).flatMap(
    ({ worksheetId, worksheetName, address }): SheetDiffEntry[] => {
      const before = workbook.worksheets.find(
        (worksheet) => worksheet.id === worksheetId,
      )?.cells[address];
      const after = worksheets.find((worksheet) => worksheet.id === worksheetId)
        ?.cells[address];
      if (
        fingerprint(before ?? { value: null }) ===
        fingerprint(after ?? { value: null })
      ) {
        return [];
      }
      return [
        {
          kind: "cell",
          worksheet: worksheetName,
          cell: address,
          ...(before ? { before: cloneCell(before) } : {}),
          ...(after ? { after: cloneCell(after) } : {}),
          deletion: !isEmptyCell(before) && isEmptyCell(after),
        },
      ];
    },
  );
  const partial = {
    id: workbook.id,
    title: workbook.title,
    revision: workbook.revision,
    ...(workbook.opaqueStructureFingerprint
      ? { opaqueStructureFingerprint: workbook.opaqueStructureFingerprint }
      : {}),
    worksheets,
  };
  return {
    workbook: { ...partial, fingerprint: sheetSemanticFingerprint(partial) },
    diff: [...diff, ...structuralDiff],
  };
}

export function sheetOperationTargetFingerprint(
  workbook: NormalizedWorkbook,
  values: unknown,
): string {
  const operations = validateSheetOperations(values);
  return fingerprint(
    operations.map((operation) => {
      if (operation.op === "add_worksheet") {
        return {
          op: operation.op,
          name: operation.name,
          existingNames: workbook.worksheets.map((worksheet) => worksheet.name),
        };
      }
      const worksheet = workbook.worksheets.find(
        (candidate) => candidate.id === operation.worksheetId,
      );
      if (!worksheet) {
        return {
          op: operation.op,
          worksheetId: operation.worksheetId,
          missing: true,
        };
      }
      if (operation.op === "delete_worksheet") {
        return {
          op: operation.op,
          worksheetId: worksheet.id,
          worksheetName: worksheet.name,
          rowCount: worksheet.rowCount,
          columnCount: worksheet.columnCount,
          cells: worksheet.cells,
          workbookWorksheetIds: workbook.worksheets.map(
            (candidate) => candidate.id,
          ),
        };
      }
      if (operation.op === "rename_worksheet") {
        return {
          op: operation.op,
          worksheetId: worksheet.id,
          worksheetName: worksheet.name,
          proposedName: operation.name,
          existingNames: workbook.worksheets.map((candidate) => candidate.name),
        };
      }
      if (operation.op === "delete_rows") {
        return {
          op: operation.op,
          worksheetId: worksheet.id,
          startRow: operation.startRow,
          count: operation.count,
          rowCount: worksheet.rowCount,
          cells: worksheet.cells,
        };
      }
      if (operation.op === "delete_columns") {
        return {
          op: operation.op,
          worksheetId: worksheet.id,
          startColumn: operation.startColumn,
          count: operation.count,
          columnCount: worksheet.columnCount,
          cells: worksheet.cells,
        };
      }
      if (operation.op === "set_range") {
        return {
          op: operation.op,
          worksheetId: worksheet.id,
          range: operation.range,
          cells: readSheetRange(worksheet, operation.range).cells,
        };
      }
      const endRow = lastUsedRow(worksheet);
      return {
        op: operation.op,
        worksheetId: worksheet.id,
        endRow,
        tail:
          endRow > 0
            ? readSheetRange(
                worksheet,
                `A${String(endRow)}:${toA1Cell(endRow, lastUsedColumn(worksheet))}`,
              ).cells
            : [],
      };
    }),
  );
}

export function sheetSemanticFingerprint(
  workbook: Omit<NormalizedWorkbook, "fingerprint">,
): string {
  return fingerprint({
    id: workbook.id,
    title: workbook.title,
    revision: workbook.revision,
    opaqueStructureFingerprint: workbook.opaqueStructureFingerprint,
    worksheets: workbook.worksheets.map((worksheet) => ({
      id: worksheet.id,
      name: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      cells: Object.fromEntries(
        Object.entries(worksheet.cells)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([address, cell]) => [address, canonicalCell(cell)]),
      ),
    })),
  });
}

function canonicalCell(cell: SheetCell): SheetCell {
  const style = cell.style
    ? {
        ...(cell.style.numberFormat
          ? { numberFormat: cell.style.numberFormat }
          : {}),
        ...(cell.style.bold ? { bold: true } : {}),
        ...(cell.style.italic ? { italic: true } : {}),
        ...(cell.style.textColor ? { textColor: cell.style.textColor } : {}),
        ...(cell.style.fillColor ? { fillColor: cell.style.fillColor } : {}),
        ...(cell.style.horizontalAlign
          ? { horizontalAlign: cell.style.horizontalAlign }
          : {}),
      }
    : undefined;
  return {
    value: cell.value,
    ...(cell.formula ? { formula: cell.formula } : {}),
    ...(style && Object.keys(style).length > 0 ? { style } : {}),
    ...(cell.kind ? { kind: cell.kind } : {}),
    ...(cell.unsupported ? { unsupported: true } : {}),
  };
}

export function diffSheetRange(
  worksheetName: string,
  range: string,
  before: SheetCell[][],
  after: SheetCell[][],
): SheetDiffEntry[] {
  const parsed = parseA1Range(range);
  const rows = Math.max(before.length, after.length);
  const columns = Math.max(
    ...before.map((row) => row.length),
    ...after.map((row) => row.length),
    0,
  );
  const changes: SheetDiffEntry[] = [];
  for (let rowOffset = 0; rowOffset < rows; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < columns; columnOffset += 1) {
      const previous = before[rowOffset]?.[columnOffset];
      const next = after[rowOffset]?.[columnOffset];
      if (fingerprint(previous ?? null) === fingerprint(next ?? null)) continue;
      changes.push({
        kind: "cell",
        worksheet: worksheetName,
        cell: `${columnName(parsed.startColumn + columnOffset)}${parsed.startRow + rowOffset}`,
        ...(previous ? { before: previous } : {}),
        ...(next ? { after: next } : {}),
        deletion: !isEmptyCell(previous) && isEmptyCell(next),
      });
    }
  }
  return changes;
}

export function parseA1Range(range: string): {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
} {
  const match = /^([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)$/i.exec(
    range.trim(),
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
    throw new Error("range must use A1 notation such as A1:C10");
  }
  const startColumn = columnIndex(match[1]);
  const startRow = Number.parseInt(match[2], 10);
  const endColumn = columnIndex(match[3]);
  const endRow = Number.parseInt(match[4], 10);
  if (endColumn < startColumn || endRow < startRow) {
    throw new Error("range end must not precede range start");
  }
  return { startRow, startColumn, endRow, endColumn };
}

export function readSheetRange(
  worksheet: SheetWorksheet,
  requestedRange?: string,
  maxCells = 10_000,
): { range: string; cells: SheetCell[][] } {
  const range = requestedRange || usedRange(worksheet);
  const parsed = parseA1Range(range);
  const rows = parsed.endRow - parsed.startRow + 1;
  const columns = parsed.endColumn - parsed.startColumn + 1;
  if (rows * columns > maxCells) {
    throw new Error(`Sheet range exceeds the ${String(maxCells)} cell limit`);
  }
  return {
    range,
    cells: Array.from({ length: rows }, (_row, rowOffset) =>
      Array.from({ length: columns }, (_column, columnOffset) =>
        cloneCell(
          worksheet.cells[
            toA1Cell(
              parsed.startRow + rowOffset,
              parsed.startColumn + columnOffset,
            )
          ] ?? { value: null },
        ),
      ),
    ),
  };
}

export function usedRange(worksheet: SheetWorksheet): string {
  const addresses = Object.keys(worksheet.cells);
  if (addresses.length === 0) return "A1:A1";
  let maxRow = 1;
  let maxColumn = 1;
  for (const address of addresses) {
    const parsed = parseA1Range(`${address}:${address}`);
    maxRow = Math.max(maxRow, parsed.endRow);
    maxColumn = Math.max(maxColumn, parsed.endColumn);
  }
  return `A1:${toA1Cell(maxRow, maxColumn)}`;
}

export function toA1Cell(row: number, column: number): string {
  if (!Number.isSafeInteger(row) || row < 1) {
    throw new Error("A1 row must be a positive integer");
  }
  if (!Number.isSafeInteger(column) || column < 1) {
    throw new Error("A1 column must be a positive integer");
  }
  return `${columnName(column)}${String(row)}`;
}

function cloneCell(cell: SheetCell): SheetCell {
  return {
    ...cell,
    ...(cell.style ? { style: { ...cell.style } } : {}),
  };
}

function writeMatrix(
  worksheet: SheetWorksheet,
  range: string,
  cells: SheetCell[][],
  touched: Map<
    string,
    { worksheetId: string; worksheetName: string; address: string }
  >,
): void {
  const parsed = parseA1Range(range);
  for (let rowOffset = 0; rowOffset < cells.length; rowOffset += 1) {
    for (
      let columnOffset = 0;
      columnOffset < (cells[rowOffset]?.length ?? 0);
      columnOffset += 1
    ) {
      const address = toA1Cell(
        parsed.startRow + rowOffset,
        parsed.startColumn + columnOffset,
      );
      const before = worksheet.cells[address];
      const after = cloneCell(cells[rowOffset]![columnOffset]!);
      if (before?.unsupported && fingerprint(before) !== fingerprint(after)) {
        throw new Error(
          `Cell ${worksheet.name}!${address} contains an unsupported rich value and cannot be overwritten`,
        );
      }
      if (fingerprint(before ?? { value: null }) === fingerprint(after))
        continue;
      touched.set(`${worksheet.id}:${address}`, {
        worksheetId: worksheet.id,
        worksheetName: worksheet.name,
        address,
      });
      if (isEmptyCell(after)) delete worksheet.cells[address];
      else worksheet.cells[address] = after;
    }
  }
}

function matrixRange(
  startRow: number,
  startColumn: number,
  rows: SheetCell[][],
): string {
  const width = Math.max(...rows.map((row) => row.length));
  return `${toA1Cell(startRow, startColumn)}:${toA1Cell(
    startRow + rows.length - 1,
    startColumn + width - 1,
  )}`;
}

function lastUsedRow(worksheet: SheetWorksheet): number {
  return Object.keys(worksheet.cells).reduce((maximum, address) => {
    const parsed = parseA1Range(`${address}:${address}`);
    return Math.max(maximum, parsed.endRow);
  }, 0);
}

function lastUsedColumn(worksheet: SheetWorksheet): number {
  return Object.keys(worksheet.cells).reduce((maximum, address) => {
    const parsed = parseA1Range(`${address}:${address}`);
    return Math.max(maximum, parsed.endColumn);
  }, 1);
}

function validateCellMatrix(value: unknown, label: string): SheetCell[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty two-dimensional array`);
  }
  return value.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length === 0) {
      throw new Error(`${label}[${rowIndex}] must be a non-empty array`);
    }
    return row.map((cell, columnIndexValue) =>
      validateCell(cell, `${label}[${rowIndex}][${columnIndexValue}]`),
    );
  });
}

function validateWorksheetName(value: string): string {
  if (
    value === "History" ||
    value.length > 31 ||
    /[\/\\?*\[\]:\s]/u.test(value) ||
    value.startsWith("'") ||
    value.endsWith("'")
  ) {
    throw new Error(
      "Worksheet name must be 1-31 characters and cannot be History, contain whitespace or \\ / ? * [ ] :, or start/end with an apostrophe",
    );
  }
  return value;
}

function formulaReferencesWorksheet(
  formula: string | undefined,
  worksheetName: string,
): boolean {
  if (!formula) return false;
  const quoted = `'${worksheetName.replaceAll("'", "''")}'!`;
  return formula.includes(quoted) || formula.includes(`${worksheetName}!`);
}

function assertVerifiedWorksheetRenameCells(worksheet: SheetWorksheet): void {
  const cells = Object.values(worksheet.cells);
  if (cells.length > 10_000) {
    throw new Error("Worksheet rename exceeds the verified 10,000-cell limit");
  }
  if (
    cells.some(
      (cell) =>
        Boolean(cell.formula) ||
        Boolean(cell.kind) ||
        Boolean(cell.unsupported) ||
        Boolean(cell.style && Object.keys(cell.style).length > 0) ||
        (cell.value !== null &&
          typeof cell.value !== "string" &&
          typeof cell.value !== "number" &&
          typeof cell.value !== "boolean"),
    )
  ) {
    throw new Error(
      "Worksheet rename is verified only for empty or simple scalar, unformatted, formula-free worksheets",
    );
  }
}

function validateCell(value: unknown, label: string): SheetCell {
  const record = asRecord(value, label);
  const formula = optionalString(record.formula, `${label}.formula`);
  const scalar = record.value === undefined && formula ? null : record.value;
  if (
    scalar !== null &&
    typeof scalar !== "string" &&
    typeof scalar !== "number" &&
    typeof scalar !== "boolean"
  ) {
    throw new Error(`${label}.value must be string, number, boolean or null`);
  }
  const style =
    record.style === undefined
      ? undefined
      : validateStyle(record.style, `${label}.style`);
  return {
    value: formula ? null : scalar,
    ...(formula
      ? {
          formula: formula.startsWith("=") ? formula : `=${formula}`,
          kind: "formula",
        }
      : {}),
    ...(style ? { style } : {}),
  };
}

function validateStyle(value: unknown, label: string): SheetCellStyle {
  const record = asRecord(value, label);
  const allowed = new Set([
    "number_format",
    "numberFormat",
    "bold",
    "italic",
    "text_color",
    "textColor",
    "fill_color",
    "fillColor",
    "horizontal_align",
    "horizontalAlign",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not a supported basic style`);
    }
  }
  const numberFormat = optionalAliasString(
    record,
    "number_format",
    "numberFormat",
    label,
  );
  if (numberFormat && !/^number(?::[0-9]+)?$/.test(numberFormat)) {
    throw new Error(
      `${label}.number_format must use the verified number or number:<decimal-places> form`,
    );
  }
  const textColor = optionalAliasColor(
    record,
    "text_color",
    "textColor",
    label,
  );
  const fillColor = optionalAliasColor(
    record,
    "fill_color",
    "fillColor",
    label,
  );
  const align = optionalString(
    aliasValue(record, "horizontal_align", "horizontalAlign", label),
    `${label}.horizontal_align`,
  );
  if (align && !["left", "center", "right"].includes(align)) {
    throw new Error(`${label}.horizontal_align is invalid`);
  }
  return {
    ...(numberFormat ? { numberFormat } : {}),
    ...(typeof record.bold === "boolean" ? { bold: record.bold } : {}),
    ...(typeof record.italic === "boolean" ? { italic: record.italic } : {}),
    ...(textColor ? { textColor } : {}),
    ...(fillColor ? { fillColor } : {}),
    ...(align ? { horizontalAlign: align as "left" | "center" | "right" } : {}),
  };
}

function aliasValue(
  record: Record<string, unknown>,
  externalName: string,
  normalizedName: string,
  label: string,
): unknown {
  if (
    record[externalName] !== undefined &&
    record[normalizedName] !== undefined
  ) {
    throw new Error(
      `${label} must not provide both ${externalName} and ${normalizedName}`,
    );
  }
  return record[externalName] ?? record[normalizedName];
}

function optionalAliasString(
  record: Record<string, unknown>,
  externalName: string,
  normalizedName: string,
  label: string,
): string | undefined {
  return optionalString(
    aliasValue(record, externalName, normalizedName, label),
    `${label}.${externalName}`,
  );
}

function optionalAliasColor(
  record: Record<string, unknown>,
  externalName: string,
  normalizedName: string,
  label: string,
): string | undefined {
  return optionalColor(
    aliasValue(record, externalName, normalizedName, label),
    `${label}.${externalName}`,
  );
}

function optionalColor(value: unknown, label: string): string | undefined {
  const color = optionalString(value, label);
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error(`${label} must be a six-digit hex color`);
  }
  return color;
}

function isEmptyCell(cell: SheetCell | undefined): boolean {
  return (
    !cell ||
    (cell.value === null &&
      !cell.formula &&
      Object.keys(cell.style ?? {}).length === 0)
  );
}

function columnIndex(value: string): number {
  let result = 0;
  for (const character of value.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function columnName(value: number): string {
  let remaining = value;
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function requireWorksheetId(record: Record<string, unknown>): string {
  if (typeof record.worksheetId === "string" && record.worksheetId.trim()) {
    return record.worksheetId.trim();
  }
  return requireString(record, "worksheet_id");
}

function requirePositiveIntegerAlias(
  record: Record<string, unknown>,
  key: string,
  alias: string,
): number {
  const value = record[key] ?? record[alias];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return Number(value);
}

function requireVerifiedSingleDeletionCount(
  record: Record<string, unknown>,
): 1 {
  if (record.count !== 1) {
    throw new Error("Only count=1 has completed structural deletion replay");
  }
  return 1;
}

function assertEmptyStructuralDeletionTarget(worksheet: SheetWorksheet): void {
  if (Object.keys(worksheet.cells).length > 0) {
    throw new Error(
      "Structural deletion is currently verified only for an empty worksheet",
    );
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}
