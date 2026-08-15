import { deflateSync, inflateSync } from "node:zlib";
import { fingerprint } from "./crypto.js";
import {
  sheetSemanticFingerprint,
  toA1Cell,
  type NormalizedWorkbook,
  type SheetCell,
  type SheetScalar,
} from "./sheet-model.js";
import {
  isVerifiedPersonalSheetChartDisplayConfigType,
  isVerifiedPersonalSheetChartLayoutIndex,
  isVerifiedPersonalSheetChartThemeIndex,
  isVerifiedPersonalSheetChartType,
  validateSheetChartOperations,
  type SheetChartOperation,
  type VerifiedColumnChartDisplayPatch,
} from "./sheet-chart.js";

const MAX_DRAFT_BYTES = 10 * 1024 * 1024;
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_CELLS = 1_000_000;

export interface DecodedLakeSheet {
  workbook: NormalizedWorkbook;
  unsupportedFeatures: string[];
  chartSummaries: SheetChartSummary[];
}

export interface SheetChartSummary {
  chartId: string | null;
  chartType: string | null;
  chartTypeVerifiedOnPersonalHost: boolean;
  displayConfigProjectionVerifiedOnPersonalHost: boolean;
  displayConfig: {
    themeIndex: number | null;
    layoutIndex: number | null;
    border: boolean | null;
    showHiddenData: boolean | null;
    showEmptyData: boolean | null;
    gridlinesVisible: boolean | null;
    yAxisFormatter: "auto" | "custom" | "none" | null;
    yAxisPrefix: string | null;
    yAxisSuffix: string | null;
    titleVisible: boolean | null;
    titleText: string | null;
    xAxisTitleText: string | null;
    yAxisTitleText: string | null;
    legendPosition: string | null;
    dataLabelsVisible: boolean | null;
    xAxisTitleVisible: boolean | null;
    xAxisLabelVisible: boolean | null;
    xAxisLabelRotation: number | null;
    yAxisTitleVisible: boolean | null;
    yAxisMinLimit: number | null;
    yAxisMaxLimit: number | null;
  };
  sourceRange: {
    startRow: number;
    startColumn: number;
    rowCount: number;
    columnCount: number;
  } | null;
  worksheetId: string | null;
  dataWorksheetId: string | null;
}

export interface EncodedLakeSheet {
  bodyDraft: string;
  workbook: NormalizedWorkbook;
}

export interface SheetChartDiffEntry {
  kind: "chart";
  action: "create" | "update" | "delete";
  chartId: string;
  worksheetId: string | null;
  sourceRange: SheetChartSummary["sourceRange"];
  changes: Array<{
    path: string;
    before: unknown;
    after: unknown;
    deletion: boolean;
  }>;
}

export interface AppliedLakeSheetChartChange {
  bodyDraft: string;
  operations: SheetChartOperation[];
  beforeCharts: SheetChartSummary[];
  afterCharts: SheetChartSummary[];
  diff: SheetChartDiffEntry[];
  baseTargetFingerprint: string;
  candidateFingerprint: string;
}

export function decodeLakeSheetDraft(input: {
  id: string;
  title: string;
  draftVersion: number;
  bodyDraft: string;
}): DecodedLakeSheet {
  if (Buffer.byteLength(input.bodyDraft, "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("LakeSheet draft exceeds the 10 MiB compressed limit");
  }
  if (input.bodyDraft === "") {
    const partial = {
      id: input.id,
      title: input.title,
      revision: String(input.draftVersion),
      opaqueStructureFingerprint: fingerprint({
        envelope: null,
        worksheets: [],
      }),
      worksheets: [],
    };
    return {
      workbook: {
        ...partial,
        fingerprint: sheetSemanticFingerprint(partial),
      },
      unsupportedFeatures: [],
      chartSummaries: [],
    };
  }
  const envelope = asRecord(parseJson(input.bodyDraft, "LakeSheet draft"));
  if (envelope.format !== "lakesheet" || typeof envelope.sheet !== "string") {
    throw new Error("LakeSheet draft envelope no longer matches the contract");
  }
  const inflated = inflateSync(Buffer.from(envelope.sheet, "latin1"), {
    maxOutputLength: MAX_INFLATED_BYTES,
  }).toString("utf8");
  const rawWorksheets = parseJson(inflated, "LakeSheet worksheet payload");
  if (!Array.isArray(rawWorksheets) || rawWorksheets.length === 0) {
    throw new Error("LakeSheet worksheet payload is not a non-empty array");
  }

  const unsupported = new Set<string>();
  const opaqueStructureFingerprint = fingerprint(
    canonicalize({
      envelope: omitRecordKeys(envelope, new Set(["sheet"])),
      worksheets: rawWorksheets.map((value) =>
        omitRecordKeys(asRecord(value), new Set(["data", "vStore"])),
      ),
    }),
  );
  let decodedCells = 0;
  const worksheets = rawWorksheets.map((value, worksheetIndex) => {
    const worksheet = asRecord(value);
    const styleStore = decodeStyleStore(worksheet.vStore, unsupported);
    const id = scalarIdentifier(
      worksheet.id,
      `worksheet-${String(worksheetIndex)}`,
    );
    const name =
      typeof worksheet.name === "string" && worksheet.name.trim()
        ? worksheet.name
        : `Sheet${String(worksheetIndex + 1)}`;
    const rowCount = positiveInteger(worksheet.rowCount);
    const columnCount = positiveInteger(worksheet.colCount);
    const data = asOptionalRecord(worksheet.data);
    const cells: Record<string, SheetCell> = {};
    for (const [rowKey, rowValue] of Object.entries(data)) {
      const row = integerIndex(rowKey, "row");
      const columns = asRecord(rowValue);
      for (const [columnKey, cellValue] of Object.entries(columns)) {
        const column = integerIndex(columnKey, "column");
        decodedCells += 1;
        if (decodedCells > MAX_DECODED_CELLS) {
          throw new Error(
            `LakeSheet exceeds the ${String(MAX_DECODED_CELLS)} decoded-cell limit`,
          );
        }
        const cell = decodeCell(cellValue, unsupported, styleStore);
        cells[toA1Cell(row + 1, column + 1)] = cell;
      }
    }
    if (hasEntries(worksheet.mergeCells)) unsupported.add("merged_cells");
    if (hasEntries(worksheet.filter)) unsupported.add("filters");
    return {
      id,
      name,
      ...(rowCount !== undefined ? { rowCount } : {}),
      ...(columnCount !== undefined ? { columnCount } : {}),
      cells,
    };
  });
  const chartSummaries = decodeChartSummaries(envelope.vessels);
  if (hasEntries(envelope.vessels)) unsupported.add("charts_or_vessels");

  const partial = {
    id: input.id,
    title: input.title,
    revision: String(input.draftVersion),
    opaqueStructureFingerprint,
    worksheets,
  };
  return {
    workbook: {
      ...partial,
      fingerprint: sheetSemanticFingerprint(partial),
    },
    unsupportedFeatures: [...unsupported].sort(),
    chartSummaries,
  };
}

export function encodeLakeSheetDraft(input: {
  id: string;
  title: string;
  draftVersion: number;
  bodyDraft: string;
  workbook: NormalizedWorkbook;
}): EncodedLakeSheet {
  const original = decodeLakeSheetDraft(input);
  if (input.bodyDraft === "") {
    if (input.workbook.worksheets.length === 0) {
      return { bodyDraft: "", workbook: original.workbook };
    }
    return encodeFirstWorksheetDraft(input);
  }
  const envelope = asRecord(parseJson(input.bodyDraft, "LakeSheet draft"));
  const inflated = inflateSync(Buffer.from(String(envelope.sheet), "latin1"), {
    maxOutputLength: MAX_INFLATED_BYTES,
  }).toString("utf8");
  const parsed = parseJson(inflated, "LakeSheet worksheet payload");
  if (!Array.isArray(parsed)) {
    throw new Error("LakeSheet worksheet payload is not an array");
  }
  const rawWorksheets = structuredClone(parsed) as unknown[];
  applyVerifiedEmptyStructuralDeletion({
    envelope,
    rawWorksheets,
    original: original.workbook,
    proposed: input.workbook,
  });
  const verifiedRenamedWorksheetIds = applyVerifiedSimpleWorksheetRename({
    envelope,
    rawWorksheets,
    original: original.workbook,
    proposed: input.workbook,
  });
  for (const worksheet of input.workbook.worksheets) {
    const originalIndex = original.workbook.worksheets.findIndex(
      (candidate) => candidate.id === worksheet.id,
    );
    if (originalIndex < 0) {
      throw new Error("LakeSheet worksheet identity changed unexpectedly");
    }
    const originalWorksheet = original.workbook.worksheets[originalIndex]!;
    const rawWorksheetIndex = rawWorksheets.findIndex(
      (candidate) =>
        scalarIdentifier(asRecord(candidate).id, "") === worksheet.id,
    );
    if (rawWorksheetIndex < 0) {
      throw new Error("LakeSheet raw worksheet identity changed unexpectedly");
    }
    const rawWorksheet = asRecord(rawWorksheets[rawWorksheetIndex]);
    if (
      worksheet.name !== originalWorksheet.name &&
      !verifiedRenamedWorksheetIds.has(worksheet.id)
    ) {
      throw new Error("Renaming a worksheet is not an enabled operation");
    }
    const data = asOptionalRecord(rawWorksheet.data);
    rawWorksheet.data = data;
    const addresses = new Set([
      ...Object.keys(originalWorksheet.cells),
      ...Object.keys(worksheet.cells),
    ]);
    for (const address of addresses) {
      const before = originalWorksheet.cells[address];
      const after = worksheet.cells[address];
      if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) {
        continue;
      }
      if (before?.unsupported) {
        throw new Error(`Unsupported cell cannot be encoded: ${address}`);
      }
      const indices = cellIndices(address);
      const rowKey = String(indices.row);
      const columnKey = String(indices.column);
      const row = asOptionalRecord(data[rowKey]);
      data[rowKey] = row;
      if (!after || emptyCell(after)) {
        delete row[columnKey];
        if (Object.keys(row).length === 0) delete data[rowKey];
        continue;
      }
      row[columnKey] = encodeCell(after, rawWorksheet);
    }
  }
  const nextEnvelope = structuredClone(envelope);
  nextEnvelope.sheet = deflateSync(JSON.stringify(rawWorksheets)).toString(
    "latin1",
  );
  const bodyDraft = JSON.stringify(nextEnvelope);
  if (Buffer.byteLength(bodyDraft, "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("Encoded LakeSheet draft exceeds the 10 MiB limit");
  }
  const verified = decodeLakeSheetDraft({ ...input, bodyDraft });
  if (
    workbookCellFingerprint(verified.workbook) !==
    workbookCellFingerprint(input.workbook)
  ) {
    throw new Error(
      "LakeSheet encode/decode semantic round-trip did not match",
    );
  }
  return { bodyDraft, workbook: verified.workbook };
}

function applyVerifiedSimpleWorksheetRename(input: {
  envelope: Record<string, unknown>;
  rawWorksheets: unknown[];
  original: NormalizedWorkbook;
  proposed: NormalizedWorkbook;
}): Set<string> {
  const renamed = input.proposed.worksheets.filter((worksheet) => {
    const original = input.original.worksheets.find(
      (candidate) => candidate.id === worksheet.id,
    );
    return original && original.name !== worksheet.name;
  });
  if (renamed.length === 0) return new Set();
  if (renamed.length !== 1) {
    throw new Error("Only one verified worksheet rename may be encoded");
  }
  if (
    input.original.worksheets.length !== input.proposed.worksheets.length ||
    input.original.worksheets.some(
      (worksheet, index) =>
        input.proposed.worksheets[index]?.id !== worksheet.id ||
        input.proposed.worksheets[index]?.rowCount !== worksheet.rowCount ||
        input.proposed.worksheets[index]?.columnCount !== worksheet.columnCount,
    )
  ) {
    throw new Error(
      "Worksheet rename cannot be combined with membership, order or dimension changes",
    );
  }
  const target = renamed[0]!;
  const before = input.original.worksheets.find(
    (worksheet) => worksheet.id === target.id,
  )!;
  assertVerifiedWorksheetName(target.name);
  if (
    input.proposed.worksheets.some(
      (worksheet) =>
        worksheet.id !== target.id && worksheet.name === target.name,
    )
  ) {
    throw new Error(`Worksheet name already exists: ${target.name}`);
  }
  if (
    input.original.worksheets.some((worksheet, index) => {
      const proposed = input.proposed.worksheets[index]!;
      return (
        worksheet.id !== proposed.id ||
        fingerprint(canonicalize(worksheet.cells)) !==
          fingerprint(canonicalize(proposed.cells))
      );
    })
  ) {
    throw new Error("Worksheet rename cannot be combined with cell changes");
  }
  assertVerifiedSimpleWorksheetRenameCells(before);
  const rawIndex = rawWorksheetIndex(input.rawWorksheets, target.id);
  if (rawIndex < 0) {
    throw new Error("Renamed worksheet identity is missing from raw data");
  }
  const rawWorksheet = asRecord(input.rawWorksheets[rawIndex]);
  assertVerifiedSimpleRawRenameTarget(
    input.envelope,
    input.rawWorksheets,
    rawWorksheet,
    before,
  );
  if (
    input.rawWorksheets.some((worksheet) =>
      rawWorksheetReferencesName(asRecord(worksheet), before.name),
    )
  ) {
    throw new Error(
      "Worksheet rename with formula references has not completed replay verification",
    );
  }
  rawWorksheet.name = target.name;
  return new Set([target.id]);
}

function assertVerifiedSimpleWorksheetRenameCells(
  worksheet: NormalizedWorkbook["worksheets"][number],
): void {
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
        Boolean(cell.style && Object.keys(cell.style).length > 0),
    )
  ) {
    throw new Error(
      "Worksheet rename is verified only for empty or simple scalar, unformatted, formula-free worksheets",
    );
  }
}

function assertVerifiedSimpleRawRenameTarget(
  envelope: Record<string, unknown>,
  rawWorksheets: unknown[],
  rawWorksheet: Record<string, unknown>,
  worksheet: NormalizedWorkbook["worksheets"][number],
): void {
  const allowedFields = new Set([
    "id",
    "name",
    "rowCount",
    "colCount",
    "index",
    "data",
    "selections",
    "rows",
    "columns",
    "filter",
    "mergeCells",
    "vStore",
    "protectSelections",
  ]);
  const unknownFields = Object.keys(rawWorksheet).filter(
    (field) => !allowedFields.has(field),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `Worksheet rename target has unverified fields: ${unknownFields.join(",")}`,
    );
  }
  for (const field of [
    "rows",
    "columns",
    "filter",
    "mergeCells",
    "protectSelections",
  ]) {
    if (hasEntries(rawWorksheet[field])) {
      throw new Error(
        `Worksheet rename requires empty unverified structure '${field}'`,
      );
    }
  }
  assertSelectionBeforeVerifiedProbe(rawWorksheet.selections);
  if (hasNestedEntries(rawWorksheet.vStore)) {
    throw new Error("Worksheet rename with styles is not replay-verified");
  }
  const sheetIndex = rawWorksheet.index;
  if (!Number.isSafeInteger(sheetIndex)) {
    throw new Error("Worksheet rename target has no stable numeric index");
  }
  const vessels = asOptionalRecord(envelope.vessels);
  if (
    Object.values(vessels).some((value) => {
      const vessel = asOptionalRecord(value);
      return vessel.sheet === sheetIndex || vessel.dataSheet === sheetIndex;
    })
  ) {
    throw new Error(
      "Worksheet rename with chart or vessel references is not replay-verified",
    );
  }
  if (
    Array.isArray(envelope.calcChain) &&
    envelope.calcChain.some(
      (entry) => Array.isArray(entry) && entry[2] === sheetIndex,
    )
  ) {
    throw new Error("Worksheet rename target still owns a formula entry");
  }
  if (
    rawWorksheets.some((value) =>
      rawWorksheetReferencesName(asRecord(value), worksheet.name),
    )
  ) {
    throw new Error(
      "Worksheet rename with formula references has not completed replay verification",
    );
  }
}

function assertVerifiedWorksheetName(value: string): void {
  if (
    !value ||
    value === "History" ||
    value.length > 31 ||
    /[\/\\?*\[\]:\s]/u.test(value) ||
    value.startsWith("'") ||
    value.endsWith("'")
  ) {
    throw new Error("Worksheet name does not match the verified UI rules");
  }
}

/**
 * Builds a local-only chart candidate from the verified chart operations that
 * have independent personal-host evidence. This function never performs I/O
 * and never accepts a raw vessel or arbitrary chartConfigs object.
 */
export function applyLakeSheetChartOperations(input: {
  id: string;
  title: string;
  draftVersion: number;
  bodyDraft: string;
  operations: unknown;
}): AppliedLakeSheetChartChange {
  const operations = validateSheetChartOperations(input.operations);
  if (!input.bodyDraft) {
    throw new Error(
      "Chart Preview requires an initialized LakeSheet worksheet payload",
    );
  }
  const before = decodeLakeSheetDraft(input);
  const envelope = asRecord(parseJson(input.bodyDraft, "LakeSheet draft"));
  if (envelope.format !== "lakesheet") {
    throw new Error("Chart Preview requires the verified LakeSheet format");
  }
  const vessels = asRecord(envelope.vessels);
  const worksheets = decodeRawWorksheets(envelope);
  const operation = operations[0]!;
  const envelopeOutsideVessels = fingerprint(
    canonicalize(omitRecordKeys(envelope, new Set(["vessels"]))),
  );
  const beforeWorksheetSemantics = worksheetSemanticProjection(before.workbook);
  let baseTargetFingerprint: string;

  if (operation.op === "create_column_chart") {
    if (Object.keys(vessels).length !== 0) {
      throw new Error(
        "create_column_chart is verified only when the workbook has no existing vessel",
      );
    }
    if (
      before.workbook.worksheets.length !== 1 ||
      before.unsupportedFeatures.length !== 0
    ) {
      throw new Error(
        "create_column_chart is verified only for one worksheet with no unsupported feature",
      );
    }
    const worksheet = before.workbook.worksheets.find(
      (candidate) => candidate.id === operation.worksheetId,
    );
    const rawWorksheet = worksheets.find(
      (candidate) =>
        scalarIdentifier(asRecord(candidate).id, "") === operation.worksheetId,
    );
    if (!worksheet || !rawWorksheet) {
      throw new Error("Chart source worksheet was not found");
    }
    assertVerifiedColumnChartSource(worksheet);
    const rawWorksheetId = asRecord(rawWorksheet).id;
    if (
      typeof rawWorksheetId !== "string" &&
      typeof rawWorksheetId !== "number"
    ) {
      throw new Error("Chart source worksheet has an invalid native id");
    }
    baseTargetFingerprint = fingerprint({
      operation: operation.op,
      vessels: canonicalize(vessels),
      worksheetId: operation.worksheetId,
      sourceCells: verifiedColumnSourceCells(worksheet),
    });
    vessels.chart0 = {
      type: "chart",
      id: "chart0",
      selections: {
        row: 0,
        col: 0,
        rowCount: 3,
        colCount: 2,
        activeRow: 0,
        activeCol: 0,
      },
      // Values are the sanitized default bbox used by the independently
      // replayed personal-host chart creation contract.
      bbox: {
        left: 306.29999999999995,
        top: 142.36666666666665,
        width: 408.40000000000003,
        height: 282.2666666666667,
      },
      chartConfigs: { chartType: "column" },
      sheet: rawWorksheetId,
      dataSheet: rawWorksheetId,
      dataType: { name: "number" },
    };
  } else {
    const target = requireEditableChart(vessels, operation.chartId);
    baseTargetFingerprint = fingerprint({
      operation: operation.op,
      chartId: operation.chartId,
      chart: canonicalize(target.vessel),
    });
    if (operation.op === "delete_chart") {
      assertVerifiedChartDeleteTarget(
        before,
        vessels,
        operation.chartId,
        target,
      );
      delete vessels[operation.chartId];
    } else if (operation.op === "set_chart_type") {
      assertTypeOnlyChartConfig(target.configs);
      target.configs.chartType = operation.chartType;
    } else {
      assertVerifiedColumnChartConfig(target.configs);
      applyVerifiedColumnChartDisplayPatch(target.configs, operation.changes);
    }
  }

  const candidateEnvelope = structuredClone(envelope);
  candidateEnvelope.vessels = vessels;
  const bodyDraft = JSON.stringify(candidateEnvelope);
  if (Buffer.byteLength(bodyDraft, "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("Chart candidate exceeds the 10 MiB LakeSheet limit");
  }
  const after = decodeLakeSheetDraft({ ...input, bodyDraft });
  if (
    fingerprint(worksheetSemanticProjection(after.workbook)) !==
    fingerprint(beforeWorksheetSemantics)
  ) {
    throw new Error("Chart Preview changed worksheet or cell semantics");
  }
  if (
    fingerprint(
      canonicalize(omitRecordKeys(candidateEnvelope, new Set(["vessels"]))),
    ) !== envelopeOutsideVessels
  ) {
    throw new Error("Chart Preview changed data outside the vessel map");
  }
  const diff = chartDiffForOperation(
    operation,
    before.chartSummaries,
    after.chartSummaries,
  );
  if (diff.length !== 1 || diff[0]!.changes.length === 0) {
    throw new Error("Chart Preview contains no semantic changes");
  }
  return {
    bodyDraft,
    operations,
    beforeCharts: before.chartSummaries,
    afterCharts: after.chartSummaries,
    diff,
    baseTargetFingerprint,
    candidateFingerprint: fingerprint(canonicalize(candidateEnvelope)),
  };
}

export function sheetChartOperationTargetFingerprint(input: {
  id: string;
  title: string;
  draftVersion: number;
  bodyDraft: string;
  operations: unknown;
}): string {
  return applyLakeSheetChartOperations(input).baseTargetFingerprint;
}

function encodeFirstWorksheetDraft(input: {
  id: string;
  title: string;
  draftVersion: number;
  bodyDraft: string;
  workbook: NormalizedWorkbook;
}): EncodedLakeSheet {
  if (input.workbook.worksheets.length !== 1) {
    throw new Error(
      "Initializing LakeSheet supports exactly one verified native worksheet",
    );
  }
  const worksheet = input.workbook.worksheets[0]!;
  const rawWorksheet: Record<string, unknown> = {
    id: worksheet.id,
    name: worksheet.name,
    rowCount: 200,
    colCount: 26,
    index: 0,
    data: {},
    selections: {},
    rows: {},
    columns: {},
    filter: {},
    mergeCells: {},
    vStore: {
      style: [],
      style_backColor: [],
      style_color: [],
      type: [],
    },
  };
  const data = rawWorksheet.data as Record<string, Record<string, unknown>>;
  let maximumRow = 0;
  let maximumColumn = 0;
  for (const [address, cell] of Object.entries(worksheet.cells)) {
    if (cell.unsupported) {
      throw new Error(`Unsupported cell cannot be encoded: ${address}`);
    }
    const indices = cellIndices(address);
    maximumRow = Math.max(maximumRow, indices.row);
    maximumColumn = Math.max(maximumColumn, indices.column);
    const rowKey = String(indices.row);
    data[rowKey] ??= {};
    data[rowKey][String(indices.column)] = encodeCell(cell, rawWorksheet);
  }
  rawWorksheet.rowCount = Math.max(200, maximumRow + 1);
  rawWorksheet.colCount = Math.max(26, maximumColumn + 1);
  const envelope = {
    format: "lakesheet",
    version: "3.5.5",
    larkJson: true,
    sheet: deflateSync(JSON.stringify([rawWorksheet])).toString("latin1"),
    calcChain: [],
    vessels: {},
    customColors: [],
    formulaCalclated: true,
    useIndex: true,
    useUTC: true,
    versionId: `sheet${fingerprint({
      id: input.id,
      title: input.title,
      worksheetId: worksheet.id,
    }).slice(0, 11)}`,
    meta: { sort: 0, shareFilter: 0 },
  };
  const bodyDraft = JSON.stringify(envelope);
  if (Buffer.byteLength(bodyDraft, "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("Encoded LakeSheet draft exceeds the 10 MiB limit");
  }
  const verified = decodeLakeSheetDraft({ ...input, bodyDraft });
  if (
    workbookCellFingerprint(verified.workbook) !==
    workbookCellFingerprint(input.workbook)
  ) {
    throw new Error(
      "LakeSheet first-worksheet encode/decode semantic round-trip did not match",
    );
  }
  return { bodyDraft, workbook: verified.workbook };
}

function workbookCellFingerprint(workbook: NormalizedWorkbook): string {
  return fingerprint({
    id: workbook.id,
    title: workbook.title,
    worksheets: workbook.worksheets.map((worksheet) => ({
      id: worksheet.id,
      name: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount,
      cells: canonicalize(worksheet.cells),
    })),
  });
}

function applyVerifiedEmptyStructuralDeletion(input: {
  envelope: Record<string, unknown>;
  rawWorksheets: unknown[];
  original: NormalizedWorkbook;
  proposed: NormalizedWorkbook;
}): void {
  const originalIds = input.original.worksheets.map(
    (worksheet) => worksheet.id,
  );
  const proposedIds = input.proposed.worksheets.map(
    (worksheet) => worksheet.id,
  );
  const addedIds = proposedIds.filter((id) => !originalIds.includes(id));
  if (addedIds.length > 0) {
    throw new Error(
      "Adding LakeSheet worksheets requires a verified raw worksheet template",
    );
  }
  const removedIds = originalIds.filter((id) => !proposedIds.includes(id));
  const countChanges = input.proposed.worksheets.flatMap((worksheet) => {
    const original = input.original.worksheets.find(
      (candidate) => candidate.id === worksheet.id,
    );
    if (!original) return [];
    const changes: Array<"rows" | "columns"> = [];
    if (worksheet.rowCount !== original.rowCount) changes.push("rows");
    if (worksheet.columnCount !== original.columnCount) changes.push("columns");
    return changes.map((structure) => ({ worksheet, original, structure }));
  });
  if (removedIds.length === 0 && countChanges.length === 0) return;
  if (
    removedIds.length > 1 ||
    countChanges.length > 1 ||
    (removedIds.length > 0 && countChanges.length > 0)
  ) {
    throw new Error(
      "Only one verified empty structural deletion may be encoded at a time",
    );
  }

  if (removedIds.length === 1) {
    if (input.original.worksheets.length <= 1) {
      throw new Error("The last worksheet cannot be deleted");
    }
    const removedId = removedIds[0]!;
    const expectedIds = originalIds.filter((id) => id !== removedId);
    if (!isSameStringArray(expectedIds, proposedIds)) {
      throw new Error("Worksheet order changed during structural deletion");
    }
    const originalWorksheet = input.original.worksheets.find(
      (worksheet) => worksheet.id === removedId,
    );
    const rawIndex = rawWorksheetIndex(input.rawWorksheets, removedId);
    if (!originalWorksheet || rawIndex < 0) {
      throw new Error(
        "Deleted worksheet identity is missing from the baseline",
      );
    }
    assertVerifiedEmptyRawTarget(
      input.envelope,
      input.rawWorksheets,
      asRecord(input.rawWorksheets[rawIndex]),
      originalWorksheet,
    );
    input.rawWorksheets.splice(rawIndex, 1);
    return;
  }

  const change = countChanges[0]!;
  const rawIndex = rawWorksheetIndex(input.rawWorksheets, change.worksheet.id);
  if (rawIndex < 0) {
    throw new Error("Structurally changed worksheet is missing from raw data");
  }
  const rawWorksheet = asRecord(input.rawWorksheets[rawIndex]);
  assertVerifiedEmptyRawTarget(
    input.envelope,
    input.rawWorksheets,
    rawWorksheet,
    change.original,
  );
  if (change.structure === "rows") {
    if (
      change.original.rowCount === undefined ||
      change.worksheet.rowCount !== change.original.rowCount - 1 ||
      change.worksheet.rowCount < 1
    ) {
      throw new Error("Only one verified empty row deletion may be encoded");
    }
    rawWorksheet.rowCount = change.worksheet.rowCount;
  } else {
    if (
      change.original.columnCount === undefined ||
      change.worksheet.columnCount !== change.original.columnCount - 1 ||
      change.worksheet.columnCount < 1
    ) {
      throw new Error("Only one verified empty column deletion may be encoded");
    }
    rawWorksheet.colCount = change.worksheet.columnCount;
  }
}

function assertVerifiedEmptyRawTarget(
  envelope: Record<string, unknown>,
  rawWorksheets: unknown[],
  rawWorksheet: Record<string, unknown>,
  worksheet: NormalizedWorkbook["worksheets"][number],
): void {
  if (Object.keys(worksheet.cells).length > 0) {
    throw new Error(
      "Structural deletion is verified only for an empty worksheet",
    );
  }
  const allowedFields = new Set([
    "id",
    "name",
    "rowCount",
    "colCount",
    "index",
    "data",
    "selections",
    "rows",
    "columns",
    "filter",
    "mergeCells",
    "vStore",
    "protectSelections",
  ]);
  const unknownFields = Object.keys(rawWorksheet).filter(
    (field) => !allowedFields.has(field),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `Empty worksheet has unverified structural fields: ${unknownFields.join(",")}`,
    );
  }
  for (const field of [
    "data",
    "rows",
    "columns",
    "filter",
    "mergeCells",
    "protectSelections",
  ]) {
    if (hasEntries(rawWorksheet[field])) {
      throw new Error(
        `Empty worksheet structural deletion requires empty '${field}'`,
      );
    }
  }
  assertSelectionBeforeVerifiedProbe(rawWorksheet.selections);
  if (hasNestedEntries(rawWorksheet.vStore)) {
    throw new Error(
      "Empty worksheet structural deletion requires an empty value/style store",
    );
  }
  const sheetIndex = rawWorksheet.index;
  if (!Number.isSafeInteger(sheetIndex)) {
    throw new Error("Empty worksheet has no stable numeric index");
  }
  const vessels = asOptionalRecord(envelope.vessels);
  if (
    Object.values(vessels).some((value) => {
      const vessel = asOptionalRecord(value);
      return vessel.sheet === sheetIndex || vessel.dataSheet === sheetIndex;
    })
  ) {
    throw new Error("Empty worksheet is still referenced by a chart or vessel");
  }
  if (
    Array.isArray(envelope.calcChain) &&
    envelope.calcChain.some(
      (entry) => Array.isArray(entry) && entry[2] === sheetIndex,
    )
  ) {
    throw new Error("Empty worksheet still owns a formula calculation entry");
  }
  if (
    rawWorksheets.some((value) =>
      rawWorksheetReferencesName(asRecord(value), worksheet.name),
    )
  ) {
    throw new Error("Empty worksheet is referenced by another formula");
  }
}

function assertSelectionBeforeVerifiedProbe(value: unknown): void {
  if (!hasEntries(value)) return;
  const selection = asRecord(value);
  const allowedFields = new Set([
    "row",
    "col",
    "rowCount",
    "colCount",
    "activeRow",
    "activeCol",
  ]);
  if (Object.keys(selection).some((field) => !allowedFields.has(field))) {
    throw new Error("Empty worksheet selection has unverified fields");
  }
  for (const field of allowedFields) {
    if (!Number.isSafeInteger(selection[field])) {
      throw new Error("Empty worksheet selection is not fully numeric");
    }
  }
  const row = Number(selection.row);
  const column = Number(selection.col);
  const rowCount = Number(selection.rowCount);
  const columnCount = Number(selection.colCount);
  const activeRow = Number(selection.activeRow);
  const activeColumn = Number(selection.activeCol);
  if (
    row < 0 ||
    column < 0 ||
    rowCount < 1 ||
    columnCount < 1 ||
    row + rowCount > 10 ||
    column + columnCount > 10 ||
    activeRow < row ||
    activeRow >= row + rowCount ||
    activeColumn < column ||
    activeColumn >= column + columnCount
  ) {
    throw new Error(
      "Empty worksheet selection intersects or follows the verified row/column deletion probe",
    );
  }
}

function rawWorksheetReferencesName(
  worksheet: Record<string, unknown>,
  targetName: string,
): boolean {
  const quoted = `'${targetName.replaceAll("'", "''")}'!`;
  const unquoted = `${targetName}!`;
  for (const row of Object.values(asOptionalRecord(worksheet.data))) {
    for (const encodedCell of Object.values(asOptionalRecord(row))) {
      const cell = asOptionalRecord(encodedCell);
      const value =
        cell.v && typeof cell.v === "object" && !Array.isArray(cell.v)
          ? asRecord(cell.v)
          : {};
      if (
        value.class === "formula" &&
        typeof value.formula === "string" &&
        (value.formula.includes(quoted) || value.formula.includes(unquoted))
      ) {
        return true;
      }
    }
  }
  return false;
}

function rawWorksheetIndex(rawWorksheets: unknown[], id: string): number {
  return rawWorksheets.findIndex(
    (value) => scalarIdentifier(asRecord(value).id, "") === id,
  );
}

function hasNestedEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((entry) =>
    Array.isArray(entry)
      ? entry.length > 0
      : entry && typeof entry === "object"
        ? Object.keys(entry).length > 0
        : entry !== undefined && entry !== null,
  );
}

function isSameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

interface DecodedStyleStore {
  styles: string[];
  colors: string[];
  backColors: string[];
  types: string[];
}

function encodeCell(
  cell: SheetCell,
  rawWorksheet: Record<string, unknown>,
): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  encoded.v = cell.formula
    ? {
        class: "formula",
        formula: cell.formula.replace(/^=/, ""),
        value: cell.value,
      }
    : cell.value;
  if (cell.style) {
    const store = ensureStyleStore(rawWorksheet);
    const styleTokens: string[] = [];
    if (cell.style.bold) styleTokens.push("w6");
    if (cell.style.italic) styleTokens.push("s2");
    if (cell.style.horizontalAlign) {
      styleTokens.push(
        `h${String({ left: 1, center: 2, right: 3 }[cell.style.horizontalAlign])}`,
      );
    }
    if (cell.style.textColor) {
      styleTokens.push(
        `c${String(storeValue(store.style_color, cell.style.textColor))}`,
      );
    }
    if (cell.style.fillColor) {
      styleTokens.push(
        `b${String(storeValue(store.style_backColor, cell.style.fillColor))}`,
      );
    }
    if (styleTokens.length) {
      encoded.s = storeStyleValue(store.style, styleTokens);
    }
    if (cell.style.numberFormat) {
      const match = /^number(?::([0-9]+))?$/.exec(cell.style.numberFormat);
      if (!match) {
        throw new Error(
          `Unsupported number format for encoding: ${cell.style.numberFormat}`,
        );
      }
      const type = `n3${match[1] === undefined ? "" : `_d${match[1]}`}`;
      encoded.t = storeValue(store.type, type);
    }
  }
  return encoded;
}

function ensureStyleStore(rawWorksheet: Record<string, unknown>): {
  style: string[];
  style_color: string[];
  style_backColor: string[];
  type: string[];
} {
  const raw = asOptionalRecord(rawWorksheet.vStore);
  rawWorksheet.vStore = raw;
  return {
    style: ensureStringArray(raw, "style"),
    style_color: ensureStringArray(raw, "style_color"),
    style_backColor: ensureStringArray(raw, "style_backColor"),
    type: ensureStringArray(raw, "type"),
  };
}

function ensureStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  if (record[key] === undefined) record[key] = [];
  if (
    !Array.isArray(record[key]) ||
    (record[key] as unknown[]).some((value) => typeof value !== "string")
  ) {
    throw new Error(`LakeSheet style store '${key}' is not a string array`);
  }
  return record[key] as string[];
}

function storeValue(values: string[], value: string): number {
  const existing = values.indexOf(value);
  if (existing >= 0) return existing;
  values.push(value);
  return values.length - 1;
}

function storeStyleValue(values: string[], tokens: string[]): number {
  const normalized = [...tokens].sort().join("_");
  const existing = values.findIndex(
    (value) => value.split("_").sort().join("_") === normalized,
  );
  if (existing >= 0) return existing;
  values.push(tokens.join("_"));
  return values.length - 1;
}

function cellIndices(address: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/i.exec(address);
  if (!match?.[1] || !match[2])
    throw new Error(`Invalid cell address: ${address}`);
  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number.parseInt(match[2], 10) - 1, column: column - 1 };
}

function emptyCell(cell: SheetCell): boolean {
  return (
    cell.value === null &&
    !cell.formula &&
    Object.keys(cell.style ?? {}).length === 0
  );
}

function decodeCell(
  value: unknown,
  unsupported: Set<string>,
  styleStore: DecodedStyleStore,
): SheetCell {
  const record = asRecord(value);
  for (const key of Object.keys(record)) {
    if (!new Set(["v", "s", "t"]).has(key)) {
      unsupported.add(`unverified_cell_field:${key}`);
    }
  }
  const visualStyle = decodeCellStyle(record.s, styleStore, unsupported);
  const numberFormat = decodeNumberFormat(record.t, styleStore, unsupported);
  const style =
    visualStyle || numberFormat
      ? { ...visualStyle, ...(numberFormat ? { numberFormat } : {}) }
      : undefined;
  const rawValue = record.v;
  if (isScalar(rawValue))
    return { value: rawValue, ...(style ? { style } : {}) };
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    unsupported.add("unknown_cell_value");
    return {
      value: null,
      kind: "unknown",
      unsupported: true,
      ...(style ? { style } : {}),
    };
  }
  const rich = rawValue as Record<string, unknown>;
  const kind = typeof rich.class === "string" ? rich.class : "rich";
  if (kind === "formula" && typeof rich.formula === "string") {
    return {
      value: isScalar(rich.value) ? rich.value : null,
      formula: rich.formula.startsWith("=") ? rich.formula : `=${rich.formula}`,
      kind,
      ...(style ? { style } : {}),
    };
  }
  unsupported.add(`cell_kind:${kind}`);
  return {
    value: isScalar(rich.value) ? rich.value : `[Unsupported ${kind} cell]`,
    kind,
    unsupported: true,
    ...(style ? { style } : {}),
  };
}

function decodeStyleStore(
  value: unknown,
  unsupported: Set<string>,
): DecodedStyleStore {
  if (value === undefined || value === null) {
    return { styles: [], colors: [], backColors: [], types: [] };
  }
  const store = asRecord(value);
  for (const key of Object.keys(store)) {
    if (!["style", "style_color", "style_backColor", "type"].includes(key)) {
      unsupported.add(`unverified_style_store:${key}`);
    }
  }
  return {
    styles: stringArray(store.style, "style", unsupported),
    colors: stringArray(store.style_color, "style_color", unsupported),
    backColors: stringArray(
      store.style_backColor,
      "style_backColor",
      unsupported,
    ),
    types: stringArray(store.type, "type", unsupported),
  };
}

function decodeNumberFormat(
  value: unknown,
  store: DecodedStyleStore,
  unsupported: Set<string>,
): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    unsupported.add("invalid_cell_type_token");
    return undefined;
  }
  const serialized = store.types[value as number];
  if (serialized === undefined) {
    unsupported.add("missing_cell_type_token");
    return undefined;
  }
  let name: string | undefined;
  let decimal: number | undefined;
  for (const token of serialized.split("_")) {
    const match = /^([A-Za-z]+)([0-9]+)$/.exec(token);
    if (!match?.[1] || match[2] === undefined) {
      unsupported.add("invalid_cell_type_encoding");
      continue;
    }
    const key = match[1];
    const value = Number.parseInt(match[2], 10);
    if (key === "n" && value === 3) name = "number";
    else if (key === "d") decimal = value;
    else unsupported.add(`unverified_cell_type:${key}${String(value)}`);
  }
  if (name !== "number") {
    unsupported.add("unverified_cell_type_name");
    return undefined;
  }
  return decimal === undefined ? name : `${name}:${String(decimal)}`;
}

function stringArray(
  value: unknown,
  label: string,
  unsupported: Set<string>,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    unsupported.add(`invalid_style_store:${label}`);
    return [];
  }
  return value as string[];
}

function decodeCellStyle(
  value: unknown,
  store: DecodedStyleStore,
  unsupported: Set<string>,
): SheetCell["style"] | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    unsupported.add("invalid_cell_style_token");
    return undefined;
  }
  const serialized = store.styles[value as number];
  if (serialized === undefined) {
    unsupported.add("missing_cell_style_token");
    return undefined;
  }
  const style: NonNullable<SheetCell["style"]> = {};
  for (const token of serialized.split("_")) {
    const match = /^([A-Za-z]+)([0-9]+)$/.exec(token);
    if (!match?.[1] || match[2] === undefined) {
      unsupported.add("invalid_cell_style_encoding");
      continue;
    }
    const key = match[1];
    const index = Number.parseInt(match[2], 10);
    if (key === "w" && index >= 1 && index <= 9) {
      style.bold = index >= 6;
    } else if (key === "s" && [1, 2].includes(index)) {
      style.italic = index === 2;
    } else if (key === "h" && [1, 2, 3].includes(index)) {
      style.horizontalAlign = (["left", "center", "right"] as const)[index - 1];
    } else if (key === "c" && store.colors[index]) {
      style.textColor = store.colors[index];
    } else if (key === "b" && store.backColors[index]) {
      style.fillColor = store.backColors[index];
    } else {
      unsupported.add(`unverified_cell_style:${key}`);
    }
  }
  return Object.keys(style).length ? style : undefined;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function integerIndex(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`LakeSheet ${label} index is invalid`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`LakeSheet ${label} index exceeds the safe limit`);
  }
  return parsed;
}

function scalarIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function isScalar(value: unknown): value is SheetScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function hasEntries(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (Array.isArray(value)
      ? value.length > 0
      : Object.keys(value as Record<string, unknown>).length > 0),
  );
}

function decodeChartSummaries(value: unknown): SheetChartSummary[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const vessel = entry as Record<string, unknown>;
      if (vessel.type !== "chart") return [];
      const configs = asOptionalRecord(vessel.chartConfigs);
      const selection = asOptionalRecord(vessel.selections);
      const chartType =
        typeof configs.chartType === "string" ? configs.chartType : null;
      const displayConfigProjectionVerified =
        isVerifiedPersonalSheetChartDisplayConfigType(chartType);
      const row = nonNegativeInteger(selection.row);
      const column = nonNegativeInteger(selection.col);
      const rowCount = positiveInteger(selection.rowCount);
      const columnCount = positiveInteger(selection.colCount);
      return [
        {
          chartId:
            typeof vessel.id === "string" && vessel.id === key ? key : null,
          chartType,
          chartTypeVerifiedOnPersonalHost:
            isVerifiedPersonalSheetChartType(chartType),
          displayConfigProjectionVerifiedOnPersonalHost:
            displayConfigProjectionVerified,
          displayConfig: displayConfigProjectionVerified
            ? projectVerifiedChartDisplayConfig(configs)
            : emptyChartDisplayConfig(),
          sourceRange:
            row !== undefined &&
            column !== undefined &&
            rowCount !== undefined &&
            columnCount !== undefined
              ? {
                  startRow: row,
                  startColumn: column,
                  rowCount,
                  columnCount,
                }
              : null,
          worksheetId: optionalScalarIdentifier(vessel.sheet),
          dataWorksheetId: optionalScalarIdentifier(vessel.dataSheet),
        },
      ];
    })
    .sort((left, right) =>
      (left.chartId ?? "").localeCompare(right.chartId ?? ""),
    );
}

function decodeRawWorksheets(envelope: Record<string, unknown>): unknown[] {
  if (typeof envelope.sheet !== "string") {
    throw new Error("LakeSheet chart payload is missing native worksheets");
  }
  const inflated = inflateSync(Buffer.from(envelope.sheet, "latin1"), {
    maxOutputLength: MAX_INFLATED_BYTES,
  }).toString("utf8");
  const parsed = parseJson(inflated, "LakeSheet worksheet payload");
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("LakeSheet chart payload has no native worksheet");
  }
  return parsed;
}

function worksheetSemanticProjection(workbook: NormalizedWorkbook): unknown {
  return workbook.worksheets.map((worksheet) => ({
    id: worksheet.id,
    name: worksheet.name,
    rowCount: worksheet.rowCount,
    columnCount: worksheet.columnCount,
    cells: canonicalize(worksheet.cells),
  }));
}

function verifiedColumnSourceCells(
  worksheet: NormalizedWorkbook["worksheets"][number],
): Record<string, SheetCell> {
  return Object.fromEntries(
    ["A1", "B1", "A2", "B2", "A3", "B3"].map((address) => [
      address,
      worksheet.cells[address]!,
    ]),
  );
}

function assertVerifiedColumnChartSource(
  worksheet: NormalizedWorkbook["worksheets"][number],
): void {
  const cells = verifiedColumnSourceCells(worksheet);
  if (
    Object.keys(worksheet.cells).length !== 6 ||
    Object.values(cells).some((cell) => !cell || cell.unsupported) ||
    Object.values(cells).some(
      (cell) =>
        Boolean(cell.formula) ||
        Boolean(cell.kind) ||
        Object.keys(cell.style ?? {}).length > 0,
    ) ||
    typeof cells.A1?.value !== "string" ||
    typeof cells.B1?.value !== "string" ||
    typeof cells.A2?.value !== "string" ||
    typeof cells.B2?.value !== "number" ||
    typeof cells.A3?.value !== "string" ||
    typeof cells.B3?.value !== "number"
  ) {
    throw new Error(
      "create_column_chart requires the replay-verified A1:B3 shape: text headers, text categories and numeric values",
    );
  }
}

function assertVerifiedChartDeleteTarget(
  decoded: DecodedLakeSheet,
  vessels: Record<string, unknown>,
  chartId: string,
  target: { vessel: Record<string, unknown>; configs: Record<string, unknown> },
): void {
  if (
    Object.keys(vessels).length !== 1 ||
    decoded.workbook.worksheets.length !== 1 ||
    decoded.unsupportedFeatures.length !== 1 ||
    decoded.unsupportedFeatures[0] !== "charts_or_vessels"
  ) {
    throw new Error(
      "delete_chart is verified only for one chart, one worksheet and no other unsupported feature",
    );
  }
  assertTypeOnlyChartConfig(target.configs);
  if (target.configs.chartType !== "column") {
    throw new Error("delete_chart is verified only for the column fixture");
  }
  const worksheet = decoded.workbook.worksheets[0]!;
  assertVerifiedColumnChartSource(worksheet);
  const summary = decoded.chartSummaries.find(
    (candidate) => candidate.chartId === chartId,
  );
  if (
    !summary ||
    summary.worksheetId !== worksheet.id ||
    summary.dataWorksheetId !== worksheet.id ||
    summary.sourceRange?.startRow !== 0 ||
    summary.sourceRange.startColumn !== 0 ||
    summary.sourceRange.rowCount !== 3 ||
    summary.sourceRange.columnCount !== 2
  ) {
    throw new Error(
      "delete_chart target does not match the replay-verified A1:B3 fixture",
    );
  }
}

function requireEditableChart(
  vessels: Record<string, unknown>,
  chartId: string,
): {
  vessel: Record<string, unknown>;
  configs: Record<string, unknown>;
} {
  const entry = vessels[chartId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Chart was not found: ${chartId}`);
  }
  const vessel = entry as Record<string, unknown>;
  if (vessel.type !== "chart" || vessel.id !== chartId) {
    throw new Error("Chart identity does not match the verified vessel shape");
  }
  const allowedRootFields = new Set([
    "type",
    "id",
    "selections",
    "bbox",
    "chartConfigs",
    "sheet",
    "dataSheet",
    "dataType",
  ]);
  const unknownRootFields = Object.keys(vessel).filter(
    (key) => !allowedRootFields.has(key),
  );
  if (unknownRootFields.length) {
    throw new Error(
      `Chart contains unverified vessel fields: ${unknownRootFields.join(",")}`,
    );
  }
  const selection = asRecord(vessel.selections);
  const selectionKeys = [
    "row",
    "col",
    "rowCount",
    "colCount",
    "activeRow",
    "activeCol",
  ];
  if (
    Object.keys(selection).some((key) => !selectionKeys.includes(key)) ||
    selectionKeys.some((key) => !Number.isSafeInteger(selection[key])) ||
    Number(selection.row) < 0 ||
    Number(selection.col) < 0 ||
    Number(selection.rowCount) < 1 ||
    Number(selection.colCount) < 1 ||
    Number(selection.rowCount) * Number(selection.colCount) > 10_000
  ) {
    throw new Error(
      "Chart source selection no longer matches the verified shape",
    );
  }
  const bbox = asRecord(vessel.bbox);
  if (
    Object.keys(bbox).sort().join(",") !== "height,left,top,width" ||
    Object.values(bbox).some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    throw new Error("Chart bbox no longer matches the verified shape");
  }
  const dataType = asRecord(vessel.dataType);
  if (Object.keys(dataType).length !== 1 || dataType.name !== "number") {
    throw new Error("Chart dataType no longer matches the verified shape");
  }
  if (
    vessel.sheet !== vessel.dataSheet ||
    (typeof vessel.sheet !== "string" && typeof vessel.sheet !== "number")
  ) {
    throw new Error(
      "Chart worksheet binding no longer matches the verified shape",
    );
  }
  return { vessel, configs: asRecord(vessel.chartConfigs) };
}

function assertTypeOnlyChartConfig(configs: Record<string, unknown>): void {
  if (
    Object.keys(configs).length !== 1 ||
    !isVerifiedPersonalSheetChartType(configs.chartType)
  ) {
    throw new Error(
      "set_chart_type is verified only when chartConfigs contains chartType alone",
    );
  }
}

function assertVerifiedColumnChartConfig(
  configs: Record<string, unknown>,
): void {
  if (configs.chartType !== "column") {
    throw new Error(
      "Display configuration Preview is verified only for a column chart",
    );
  }
  const allowed = new Set([
    "chartType",
    "theme",
    "layout",
    "border",
    "hiddenData",
    "showEmptyData",
    "grid",
    "formatter",
    "prefix",
    "suffix",
    "title",
    "titles",
    "legend",
    "label",
    "xAxis",
    "yAxis",
  ]);
  const unknown = Object.keys(configs).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(
      `Column chart contains unverified config fields: ${unknown.join(",")}`,
    );
  }
  assertExistingColumnDisplayValues(configs);
}

function assertExistingColumnDisplayValues(
  configs: Record<string, unknown>,
): void {
  if (
    configs.theme !== undefined &&
    !isVerifiedPersonalSheetChartThemeIndex(configs.theme)
  ) {
    throw new Error("Column chart has an unverified theme index");
  }
  if (
    configs.layout !== undefined &&
    !isVerifiedPersonalSheetChartLayoutIndex(configs.layout)
  ) {
    throw new Error("Column chart has an unverified layout index");
  }
  for (const key of ["border", "hiddenData", "showEmptyData", "grid"]) {
    if (configs[key] !== undefined && typeof configs[key] !== "boolean") {
      throw new Error(`Column chart config '${key}' is not boolean`);
    }
  }
  if (configs.formatter !== undefined && configs.formatter !== "custom") {
    throw new Error("Column chart has an unverified formatter value");
  }
  for (const key of ["prefix", "suffix"]) {
    if (configs[key] !== undefined && typeof configs[key] !== "string") {
      throw new Error(`Column chart config '${key}' is not text`);
    }
  }
  assertNestedRecord(configs.title, new Set(["visible"]), {
    visible: "boolean",
  });
  assertNestedRecord(configs.titles, new Set(["title", "xAxis", "yAxis"]), {
    title: "string",
    xAxis: "string",
    yAxis: "string",
  });
  assertNestedRecord(configs.legend, new Set(["position"]), {
    position: "string",
  });
  const legend = optionalStrictRecord(configs.legend, "legend");
  if (legend?.position !== undefined && legend.position !== "right") {
    throw new Error("Column chart has an unverified legend position");
  }
  assertNestedRecord(configs.label, new Set(["visible"]), {
    visible: "boolean",
  });
  const xAxis = optionalStrictRecord(configs.xAxis, "xAxis");
  if (xAxis) {
    const unknown = Object.keys(xAxis).filter(
      (key) => !new Set(["title", "label"]).has(key),
    );
    if (unknown.length)
      throw new Error("Column chart xAxis has unknown fields");
    assertNestedRecord(xAxis.title, new Set(["visible"]), {
      visible: "boolean",
    });
    assertNestedRecord(xAxis.label, new Set(["visible", "rotate"]), {
      visible: "boolean",
      rotate: "number",
    });
    const label = optionalStrictRecord(xAxis.label, "xAxis.label");
    if (label?.rotate !== undefined && label.rotate !== -45) {
      throw new Error("Column chart has an unverified x-axis label rotation");
    }
  }
  const yAxis = optionalStrictRecord(configs.yAxis, "yAxis");
  if (yAxis) {
    const unknown = Object.keys(yAxis).filter(
      (key) => !new Set(["title", "minLimit", "maxLimit"]).has(key),
    );
    if (unknown.length)
      throw new Error("Column chart yAxis has unknown fields");
    assertNestedRecord(yAxis.title, new Set(["visible"]), {
      visible: "boolean",
    });
    for (const key of ["minLimit", "maxLimit"]) {
      if (
        yAxis[key] !== undefined &&
        (typeof yAxis[key] !== "number" || !Number.isFinite(yAxis[key]))
      ) {
        throw new Error(`Column chart yAxis.${key} is not finite`);
      }
    }
  }
}

function optionalStrictRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Column chart config '${label}' is not an object`);
  }
  return value as Record<string, unknown>;
}

function assertNestedRecord(
  value: unknown,
  allowed: Set<string>,
  types: Record<string, "boolean" | "string" | "number">,
): void {
  const record = optionalStrictRecord(value, "nested");
  if (!record) return;
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(
      `Column chart nested config has unknown fields: ${unknown.join(",")}`,
    );
  }
  for (const [key, expected] of Object.entries(types)) {
    if (record[key] === undefined) continue;
    if (
      typeof record[key] !== expected ||
      (expected === "number" && !Number.isFinite(record[key]))
    ) {
      throw new Error(
        `Column chart nested config '${key}' has an invalid type`,
      );
    }
  }
}

function applyVerifiedColumnChartDisplayPatch(
  configs: Record<string, unknown>,
  patch: VerifiedColumnChartDisplayPatch,
): void {
  if (patch.themeIndex !== undefined) configs.theme = patch.themeIndex;
  if (patch.layoutIndex !== undefined) configs.layout = patch.layoutIndex;
  if (patch.border !== undefined) configs.border = patch.border;
  if (patch.showHiddenData !== undefined) {
    configs.hiddenData = !patch.showHiddenData;
  }
  if (patch.showEmptyData !== undefined) {
    configs.showEmptyData = patch.showEmptyData;
  }
  if (patch.gridlinesVisible !== undefined) {
    configs.grid = patch.gridlinesVisible;
  }
  if (patch.yAxisFormatter !== undefined) {
    configs.formatter = patch.yAxisFormatter;
  }
  if (patch.yAxisPrefix !== undefined) configs.prefix = patch.yAxisPrefix;
  if (patch.yAxisSuffix !== undefined) configs.suffix = patch.yAxisSuffix;
  setNestedValue(configs, ["title", "visible"], patch.titleVisible);
  setNestedValue(configs, ["titles", "title"], patch.titleText);
  setNestedValue(configs, ["titles", "xAxis"], patch.xAxisTitleText);
  setNestedValue(configs, ["titles", "yAxis"], patch.yAxisTitleText);
  setNestedValue(configs, ["legend", "position"], patch.legendPosition);
  setNestedValue(configs, ["label", "visible"], patch.dataLabelsVisible);
  setNestedValue(
    configs,
    ["xAxis", "title", "visible"],
    patch.xAxisTitleVisible,
  );
  setNestedValue(
    configs,
    ["xAxis", "label", "visible"],
    patch.xAxisLabelVisible,
  );
  setNestedValue(
    configs,
    ["xAxis", "label", "rotate"],
    patch.xAxisLabelRotation,
  );
  setNestedValue(
    configs,
    ["yAxis", "title", "visible"],
    patch.yAxisTitleVisible,
  );
  setNestedValue(configs, ["yAxis", "minLimit"], patch.yAxisMinLimit);
  setNestedValue(configs, ["yAxis", "maxLimit"], patch.yAxisMaxLimit);
}

function setNestedValue(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (value === undefined) return;
  let current = root;
  for (const key of path.slice(0, -1)) {
    const existing = current[key];
    if (existing === undefined) current[key] = {};
    else if (
      !existing ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      throw new Error(
        `Chart config path cannot be updated safely: ${path.join(".")}`,
      );
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function chartDiffForOperation(
  operation: SheetChartOperation,
  beforeCharts: SheetChartSummary[],
  afterCharts: SheetChartSummary[],
): SheetChartDiffEntry[] {
  if (operation.op === "create_column_chart") {
    const created = afterCharts.find(
      (candidate) =>
        !beforeCharts.some((before) => before.chartId === candidate.chartId),
    );
    if (!created?.chartId || created.chartType !== "column") {
      throw new Error("Created chart did not survive semantic decode");
    }
    return [
      {
        kind: "chart",
        action: "create",
        chartId: created.chartId,
        worksheetId: created.worksheetId,
        sourceRange: created.sourceRange,
        changes: [
          {
            path: "chart",
            before: null,
            after: {
              chartType: created.chartType,
              worksheetId: created.worksheetId,
              sourceRange: created.sourceRange,
            },
            deletion: false,
          },
        ],
      },
    ];
  }
  const before = beforeCharts.find(
    (candidate) => candidate.chartId === operation.chartId,
  );
  if (operation.op === "delete_chart") {
    if (
      !before ||
      afterCharts.some((candidate) => candidate.chartId === operation.chartId)
    ) {
      throw new Error("Deleted chart did not survive semantic validation");
    }
    return [
      {
        kind: "chart",
        action: "delete",
        chartId: operation.chartId,
        worksheetId: before.worksheetId,
        sourceRange: before.sourceRange,
        changes: [
          {
            path: "chart",
            before: {
              chartType: before.chartType,
              worksheetId: before.worksheetId,
              sourceRange: before.sourceRange,
            },
            after: null,
            deletion: true,
          },
        ],
      },
    ];
  }
  const after = afterCharts.find(
    (candidate) => candidate.chartId === operation.chartId,
  );
  if (!before || !after) {
    throw new Error("Target chart disappeared during local Preview");
  }
  const changes = flattenChartSummary(before).flatMap((entry) => {
    const next = flattenChartSummary(after).find(
      (candidate) => candidate.path === entry.path,
    );
    return next && fingerprint(next.value) !== fingerprint(entry.value)
      ? [
          {
            path: entry.path,
            before: entry.value,
            after: next.value,
            deletion: false as const,
          },
        ]
      : [];
  });
  return [
    {
      kind: "chart",
      action: "update",
      chartId: operation.chartId,
      worksheetId: after.worksheetId,
      sourceRange: after.sourceRange,
      changes,
    },
  ];
}

function flattenChartSummary(
  summary: SheetChartSummary,
): Array<{ path: string; value: unknown }> {
  return [
    { path: "chart_type", value: summary.chartType },
    ...Object.entries(summary.displayConfig).map(([key, value]) => ({
      path: `display.${key}`,
      value,
    })),
  ];
}

function projectVerifiedChartDisplayConfig(
  configs: Record<string, unknown>,
): SheetChartSummary["displayConfig"] {
  const title = asOptionalRecord(configs.title);
  const titles = asOptionalRecord(configs.titles);
  const legend = asOptionalRecord(configs.legend);
  const label = asOptionalRecord(configs.label);
  const xAxis = asOptionalRecord(configs.xAxis);
  const xAxisTitle = asOptionalRecord(xAxis.title);
  const xAxisLabel = asOptionalRecord(xAxis.label);
  const yAxis = asOptionalRecord(configs.yAxis);
  const yAxisTitle = asOptionalRecord(yAxis.title);
  return {
    themeIndex: isVerifiedPersonalSheetChartThemeIndex(configs.theme)
      ? configs.theme
      : null,
    layoutIndex: isVerifiedPersonalSheetChartLayoutIndex(configs.layout)
      ? configs.layout
      : null,
    border: optionalBoolean(configs.border),
    showHiddenData: invertOptionalBoolean(configs.hiddenData),
    showEmptyData: optionalBoolean(configs.showEmptyData),
    gridlinesVisible: optionalBoolean(configs.grid),
    yAxisFormatter: optionalChartFormatter(configs.formatter),
    yAxisPrefix: optionalText(configs.prefix),
    yAxisSuffix: optionalText(configs.suffix),
    titleVisible: optionalBoolean(title.visible),
    titleText: optionalText(titles.title),
    xAxisTitleText: optionalText(titles.xAxis),
    yAxisTitleText: optionalText(titles.yAxis),
    legendPosition: optionalText(legend.position),
    dataLabelsVisible: optionalBoolean(label.visible),
    xAxisTitleVisible: optionalBoolean(xAxisTitle.visible),
    xAxisLabelVisible: optionalBoolean(xAxisLabel.visible),
    xAxisLabelRotation: optionalFiniteNumber(xAxisLabel.rotate),
    yAxisTitleVisible: optionalBoolean(yAxisTitle.visible),
    yAxisMinLimit: optionalFiniteNumber(yAxis.minLimit),
    yAxisMaxLimit: optionalFiniteNumber(yAxis.maxLimit),
  };
}

function emptyChartDisplayConfig(): SheetChartSummary["displayConfig"] {
  return {
    themeIndex: null,
    layoutIndex: null,
    border: null,
    showHiddenData: null,
    showEmptyData: null,
    gridlinesVisible: null,
    yAxisFormatter: null,
    yAxisPrefix: null,
    yAxisSuffix: null,
    titleVisible: null,
    titleText: null,
    xAxisTitleText: null,
    yAxisTitleText: null,
    legendPosition: null,
    dataLabelsVisible: null,
    xAxisTitleVisible: null,
    xAxisLabelVisible: null,
    xAxisLabelRotation: null,
    yAxisTitleVisible: null,
    yAxisMinLimit: null,
    yAxisMaxLimit: null,
  };
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function invertOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? !value : null;
}

function optionalChartFormatter(
  value: unknown,
): "auto" | "custom" | "none" | null {
  return value === "auto" || value === "custom" || value === "none"
    ? value
    : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function optionalScalarIdentifier(value: unknown): string | null {
  return typeof value === "string" || Number.isSafeInteger(value)
    ? String(value)
    : null;
}

function omitRecordKeys(
  value: Record<string, unknown>,
  excluded: Set<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.has(key)),
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function asOptionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : asRecord(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LakeSheet payload contains a non-object record");
  }
  return value as Record<string, unknown>;
}
