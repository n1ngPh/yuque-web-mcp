/**
 * Chart types that completed a personal-host write, read-back and exact
 * restoration probe in the dedicated `test_Node创建表格_v2` fixture.
 *
 * These values may be used by the local-only chart Preview encoder. Remote
 * Confirm remains disabled until atomic conflict protection and timeout
 * reconciliation are independently accepted.
 */
export const VERIFIED_PERSONAL_SHEET_CHART_TYPES = [
  "column",
  "stackColumn",
  "bar",
  "stackBar",
  "line",
  "smoothLine",
  "pie",
  "ring",
] as const;

/**
 * Safe read-only projection paths that completed a personal-host write,
 * read-back and exact restoration probe on a column chart. These paths are
 * not a chart editing allowlist.
 */
export const VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_PATHS = [
  "theme",
  "layout",
  "border",
  "hiddenData",
  "showEmptyData",
  "grid",
  "formatter",
  "prefix",
  "suffix",
  "title.visible",
  "titles.title",
  "titles.xAxis",
  "titles.yAxis",
  "legend.position",
  "label.visible",
  "xAxis.title.visible",
  "xAxis.label.visible",
  "xAxis.label.rotate",
  "yAxis.title.visible",
  "yAxis.minLimit",
  "yAxis.maxLimit",
] as const;

export const VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPES = [
  "column",
] as const;

export const VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES = [
  0, 1, 2, 3, 4, 5,
] as const;

export const VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES = [
  0, 1, 2, 3, 4, 5,
] as const;

export const VERIFIED_PERSONAL_SHEET_CHART_PREVIEW_OPERATIONS = [
  "create_column_chart",
  "set_chart_type",
  "update_column_chart_display",
  "delete_chart",
] as const;

const VERIFIED_PERSONAL_SHEET_CHART_TYPE_SET = new Set<string>(
  VERIFIED_PERSONAL_SHEET_CHART_TYPES,
);
const VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPE_SET = new Set<string>(
  VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPES,
);
const VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEX_SET = new Set<number>(
  VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES,
);
const VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEX_SET = new Set<number>(
  VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES,
);

export type VerifiedPersonalSheetChartType =
  (typeof VERIFIED_PERSONAL_SHEET_CHART_TYPES)[number];

export interface VerifiedColumnChartDisplayPatch {
  themeIndex?: (typeof VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES)[number];
  layoutIndex?: (typeof VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES)[number];
  border?: boolean;
  showHiddenData?: boolean;
  showEmptyData?: boolean;
  gridlinesVisible?: boolean;
  yAxisFormatter?: "custom";
  yAxisPrefix?: string;
  yAxisSuffix?: string;
  titleVisible?: boolean;
  titleText?: string;
  xAxisTitleText?: string;
  yAxisTitleText?: string;
  legendPosition?: "right";
  dataLabelsVisible?: boolean;
  xAxisTitleVisible?: boolean;
  xAxisLabelVisible?: boolean;
  xAxisLabelRotation?: -45;
  yAxisTitleVisible?: boolean;
  yAxisMinLimit?: number;
  yAxisMaxLimit?: number;
}

export type SheetChartOperation =
  | {
      op: "create_column_chart";
      worksheetId: string;
      range: "A1:B3";
    }
  | {
      op: "set_chart_type";
      chartId: string;
      chartType: VerifiedPersonalSheetChartType;
    }
  | {
      op: "update_column_chart_display";
      chartId: string;
      changes: VerifiedColumnChartDisplayPatch;
    }
  | {
      op: "delete_chart";
      chartId: string;
    };

const CHART_OPERATION_NAMES = new Set<string>(
  VERIFIED_PERSONAL_SHEET_CHART_PREVIEW_OPERATIONS,
);

export function isSheetChartOperationName(
  value: unknown,
): value is (typeof VERIFIED_PERSONAL_SHEET_CHART_PREVIEW_OPERATIONS)[number] {
  return typeof value === "string" && CHART_OPERATION_NAMES.has(value);
}

export function validateSheetChartOperations(
  value: unknown,
): SheetChartOperation[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("A chart preview requires exactly one chart operation");
  }
  const record = strictRecord(value[0], "chart operation");
  const op = requiredString(record, "op");
  if (!isSheetChartOperationName(op)) {
    throw new Error(`Unsupported Sheet chart operation: ${op}`);
  }
  if (op === "create_column_chart") {
    assertOnlyKeys(record, new Set(["op", "worksheet_id", "range"]), op);
    const range = requiredString(record, "range").toUpperCase();
    if (range !== "A1:B3") {
      throw new Error(
        "create_column_chart is verified only for the exact A1:B3 source range",
      );
    }
    return [
      {
        op,
        worksheetId: requiredIdentifier(record, "worksheet_id"),
        range,
      },
    ];
  }
  if (op === "set_chart_type") {
    assertOnlyKeys(record, new Set(["op", "chart_id", "chart_type"]), op);
    const chartType = requiredString(record, "chart_type");
    if (!isVerifiedPersonalSheetChartType(chartType)) {
      throw new Error(
        `Chart type has no personal-host write evidence: ${chartType}`,
      );
    }
    return [
      {
        op,
        chartId: requiredIdentifier(record, "chart_id"),
        chartType,
      },
    ];
  }
  if (op === "delete_chart") {
    assertOnlyKeys(record, new Set(["op", "chart_id"]), op);
    return [
      {
        op,
        chartId: requiredIdentifier(record, "chart_id"),
      },
    ];
  }

  assertOnlyKeys(record, new Set(["op", "chart_id", "changes"]), op);
  return [
    {
      op,
      chartId: requiredIdentifier(record, "chart_id"),
      changes: validateColumnChartDisplayPatch(record.changes),
    },
  ];
}

function validateColumnChartDisplayPatch(
  value: unknown,
): VerifiedColumnChartDisplayPatch {
  const record = strictRecord(value, "chart display changes");
  const allowed = new Set([
    "theme_index",
    "layout_index",
    "border",
    "show_hidden_data",
    "show_empty_data",
    "gridlines_visible",
    "y_axis_formatter",
    "y_axis_prefix",
    "y_axis_suffix",
    "title_visible",
    "title_text",
    "x_axis_title_text",
    "y_axis_title_text",
    "legend_position",
    "data_labels_visible",
    "x_axis_title_visible",
    "x_axis_label_visible",
    "x_axis_label_rotation",
    "y_axis_title_visible",
    "y_axis_min_limit",
    "y_axis_max_limit",
  ]);
  assertOnlyKeys(record, allowed, "update_column_chart_display.changes");
  if (Object.keys(record).length === 0) {
    throw new Error("Chart display changes must not be empty");
  }

  const patch: VerifiedColumnChartDisplayPatch = {};
  if (record.theme_index !== undefined) {
    if (!isVerifiedPersonalSheetChartThemeIndex(record.theme_index)) {
      throw new Error("theme_index must be one of the verified indexes 0..5");
    }
    patch.themeIndex = record.theme_index;
  }
  if (record.layout_index !== undefined) {
    if (!isVerifiedPersonalSheetChartLayoutIndex(record.layout_index)) {
      throw new Error("layout_index must be one of the verified indexes 0..5");
    }
    patch.layoutIndex = record.layout_index;
  }
  assignBoolean(record, "border", patch, "border");
  assignBoolean(record, "show_hidden_data", patch, "showHiddenData");
  assignBoolean(record, "show_empty_data", patch, "showEmptyData");
  assignBoolean(record, "gridlines_visible", patch, "gridlinesVisible");
  assignBoolean(record, "title_visible", patch, "titleVisible");
  assignBoolean(record, "data_labels_visible", patch, "dataLabelsVisible");
  assignBoolean(record, "x_axis_title_visible", patch, "xAxisTitleVisible");
  assignBoolean(record, "x_axis_label_visible", patch, "xAxisLabelVisible");
  assignBoolean(record, "y_axis_title_visible", patch, "yAxisTitleVisible");
  if (record.y_axis_formatter !== undefined) {
    if (record.y_axis_formatter !== "custom") {
      throw new Error(
        "Only y_axis_formatter='custom' has write/read-back evidence",
      );
    }
    patch.yAxisFormatter = "custom";
  }
  assignText(record, "y_axis_prefix", patch, "yAxisPrefix", 16);
  assignText(record, "y_axis_suffix", patch, "yAxisSuffix", 16);
  assignText(record, "title_text", patch, "titleText", 200);
  assignText(record, "x_axis_title_text", patch, "xAxisTitleText", 200);
  assignText(record, "y_axis_title_text", patch, "yAxisTitleText", 200);
  if (record.legend_position !== undefined) {
    if (record.legend_position !== "right") {
      throw new Error(
        "Only legend_position='right' has write/read-back evidence",
      );
    }
    patch.legendPosition = "right";
  }
  if (record.x_axis_label_rotation !== undefined) {
    if (record.x_axis_label_rotation !== -45) {
      throw new Error(
        "Only x_axis_label_rotation=-45 has write/read-back evidence",
      );
    }
    patch.xAxisLabelRotation = -45;
  }
  assignFiniteNumber(record, "y_axis_min_limit", patch, "yAxisMinLimit");
  assignFiniteNumber(record, "y_axis_max_limit", patch, "yAxisMaxLimit");
  if (
    patch.yAxisMinLimit !== undefined &&
    patch.yAxisMaxLimit !== undefined &&
    patch.yAxisMinLimit > patch.yAxisMaxLimit
  ) {
    throw new Error("y_axis_min_limit must not exceed y_axis_max_limit");
  }
  return patch;
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(
      `${label} contains unverified fields: ${unknown.join(",")}`,
    );
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== "string" || !record[key].trim()) {
    throw new Error(`${key} is required`);
  }
  return record[key].trim();
}

function requiredIdentifier(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = requiredString(record, key);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${key} has an invalid identifier shape`);
  }
  return value;
}

function assignBoolean<K extends keyof VerifiedColumnChartDisplayPatch>(
  source: Record<string, unknown>,
  sourceKey: string,
  target: VerifiedColumnChartDisplayPatch,
  targetKey: K,
): void {
  if (source[sourceKey] === undefined) return;
  if (typeof source[sourceKey] !== "boolean") {
    throw new Error(`${sourceKey} must be boolean`);
  }
  target[targetKey] = source[sourceKey] as VerifiedColumnChartDisplayPatch[K];
}

function assignText<K extends keyof VerifiedColumnChartDisplayPatch>(
  source: Record<string, unknown>,
  sourceKey: string,
  target: VerifiedColumnChartDisplayPatch,
  targetKey: K,
  maximumLength: number,
): void {
  if (source[sourceKey] === undefined) return;
  const value = source[sourceKey];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      `${sourceKey} must be non-empty text of at most ${String(maximumLength)} characters`,
    );
  }
  target[targetKey] = value as VerifiedColumnChartDisplayPatch[K];
}

function assignFiniteNumber<K extends keyof VerifiedColumnChartDisplayPatch>(
  source: Record<string, unknown>,
  sourceKey: string,
  target: VerifiedColumnChartDisplayPatch,
  targetKey: K,
): void {
  if (source[sourceKey] === undefined) return;
  const value = source[sourceKey];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1_000_000_000_000
  ) {
    throw new Error(`${sourceKey} must be a bounded finite number`);
  }
  target[targetKey] = value as VerifiedColumnChartDisplayPatch[K];
}

export function isVerifiedPersonalSheetChartType(
  value: unknown,
): value is VerifiedPersonalSheetChartType {
  return (
    typeof value === "string" &&
    VERIFIED_PERSONAL_SHEET_CHART_TYPE_SET.has(value)
  );
}

export function isVerifiedPersonalSheetChartDisplayConfigType(
  value: unknown,
): value is (typeof VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPES)[number] {
  return (
    typeof value === "string" &&
    VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPE_SET.has(value)
  );
}

export function isVerifiedPersonalSheetChartThemeIndex(
  value: unknown,
): value is (typeof VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES)[number] {
  return (
    typeof value === "number" &&
    VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEX_SET.has(value)
  );
}

export function isVerifiedPersonalSheetChartLayoutIndex(
  value: unknown,
): value is (typeof VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES)[number] {
  return (
    typeof value === "number" &&
    VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEX_SET.has(value)
  );
}
