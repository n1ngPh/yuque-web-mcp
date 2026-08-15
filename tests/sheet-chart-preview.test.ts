import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyLakeSheetChartOperations,
  decodeLakeSheetDraft,
} from "../src/sheet-codec.js";
import { validateSheetChartOperations } from "../src/sheet-chart.js";

describe("verified local-only LakeSheet chart Preview", () => {
  it("creates only the exact replay-verified A1:B3 column chart", () => {
    const bodyDraft = chartDraft(false);
    const applied = applyLakeSheetChartOperations({
      id: "10",
      title: "chart fixture",
      draftVersion: 2,
      bodyDraft,
      operations: [
        {
          op: "create_column_chart",
          worksheet_id: "0",
          range: "A1:B3",
        },
      ],
    });

    expect(applied.baseTargetFingerprint).toHaveLength(64);
    expect(applied.candidateFingerprint).toHaveLength(64);
    expect(applied.diff).toEqual([
      expect.objectContaining({
        action: "create",
        chartId: "chart0",
        worksheetId: "0",
        sourceRange: {
          startRow: 0,
          startColumn: 0,
          rowCount: 3,
          columnCount: 2,
        },
      }),
    ]);
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "chart fixture",
      draftVersion: 2,
      bodyDraft: applied.bodyDraft,
    });
    expect(decoded.chartSummaries).toEqual([
      expect.objectContaining({
        chartId: "chart0",
        chartType: "column",
        worksheetId: "0",
        dataWorksheetId: "0",
      }),
    ]);
    expect(decoded.workbook.worksheets[0]?.cells).toEqual(
      decodeLakeSheetDraft({
        id: "10",
        title: "chart fixture",
        draftVersion: 2,
        bodyDraft,
      }).workbook.worksheets[0]?.cells,
    );
  });

  it("previews the eight verified type values without accepting raw config", () => {
    const bodyDraft = chartDraft(true);
    const applied = applyLakeSheetChartOperations({
      id: "10",
      title: "chart fixture",
      draftVersion: 2,
      bodyDraft,
      operations: [
        {
          op: "set_chart_type",
          chart_id: "chart0",
          chart_type: "line",
        },
      ],
    });
    expect(applied.diff[0]?.changes).toEqual([
      {
        path: "chart_type",
        before: "column",
        after: "line",
        deletion: false,
      },
    ]);
    expect(applied.afterCharts[0]).toMatchObject({
      chartId: "chart0",
      chartType: "line",
      sourceRange: {
        startRow: 0,
        startColumn: 0,
        rowCount: 3,
        columnCount: 2,
      },
    });
    expect(() =>
      validateSheetChartOperations([
        {
          op: "set_chart_type",
          chart_id: "chart0",
          chart_type: "line",
          chartConfigs: { arbitrary: true },
        },
      ]),
    ).toThrow("unverified fields");
  });

  it("maps only typed column-display fields and preserves cells", () => {
    const bodyDraft = chartDraft(true);
    const applied = applyLakeSheetChartOperations({
      id: "10",
      title: "chart fixture",
      draftVersion: 2,
      bodyDraft,
      operations: [
        {
          op: "update_column_chart_display",
          chart_id: "chart0",
          changes: {
            theme_index: 5,
            layout_index: 4,
            border: true,
            show_hidden_data: true,
            show_empty_data: true,
            gridlines_visible: false,
            y_axis_formatter: "custom",
            y_axis_prefix: "¥",
            y_axis_suffix: "元",
            title_visible: true,
            title_text: "MCP 图表配置验证",
            x_axis_title_text: "类别",
            y_axis_title_text: "数值",
            legend_position: "right",
            data_labels_visible: true,
            x_axis_title_visible: true,
            x_axis_label_visible: true,
            x_axis_label_rotation: -45,
            y_axis_title_visible: true,
            y_axis_min_limit: 0,
            y_axis_max_limit: 50,
          },
        },
      ],
    });
    expect(applied.afterCharts[0]?.displayConfig).toEqual({
      themeIndex: 5,
      layoutIndex: 4,
      border: true,
      showHiddenData: true,
      showEmptyData: true,
      gridlinesVisible: false,
      yAxisFormatter: "custom",
      yAxisPrefix: "¥",
      yAxisSuffix: "元",
      titleVisible: true,
      titleText: "MCP 图表配置验证",
      xAxisTitleText: "类别",
      yAxisTitleText: "数值",
      legendPosition: "right",
      dataLabelsVisible: true,
      xAxisTitleVisible: true,
      xAxisLabelVisible: true,
      xAxisLabelRotation: -45,
      yAxisTitleVisible: true,
      yAxisMinLimit: 0,
      yAxisMaxLimit: 50,
    });
    expect(applied.diff[0]?.changes).toHaveLength(21);
    expect(applied.diff[0]?.changes.every((entry) => !entry.deletion)).toBe(
      true,
    );
    expect(worksheetPayload(applied.bodyDraft)).toEqual(
      worksheetPayload(bodyDraft),
    );
  });

  it("deletes only the replay-verified chart and marks a deletion Diff", () => {
    const bodyDraft = chartDraft(true);
    const applied = applyLakeSheetChartOperations({
      id: "10",
      title: "chart fixture",
      draftVersion: 34,
      bodyDraft,
      operations: [{ op: "delete_chart", chart_id: "chart0" }],
    });
    expect(applied.afterCharts).toEqual([]);
    expect(applied.diff).toEqual([
      {
        kind: "chart",
        action: "delete",
        chartId: "chart0",
        worksheetId: "0",
        sourceRange: {
          startRow: 0,
          startColumn: 0,
          rowCount: 3,
          columnCount: 2,
        },
        changes: [
          {
            path: "chart",
            before: {
              chartType: "column",
              worksheetId: "0",
              sourceRange: {
                startRow: 0,
                startColumn: 0,
                rowCount: 3,
                columnCount: 2,
              },
            },
            after: null,
            deletion: true,
          },
        ],
      },
    ]);
    expect(worksheetPayload(applied.bodyDraft)).toEqual(
      worksheetPayload(bodyDraft),
    );
  });

  it("fails closed for unverified creation shapes, mixed operations and configs", () => {
    expect(() =>
      validateSheetChartOperations([
        {
          op: "create_column_chart",
          worksheet_id: "0",
          range: "A1:C3",
        },
      ]),
    ).toThrow("exact A1:B3");
    expect(() =>
      validateSheetChartOperations([
        {
          op: "set_chart_type",
          chart_id: "chart0",
          chart_type: "line",
        },
        {
          op: "set_range",
          worksheet_id: "0",
          range: "A1:A1",
          cells: [[{ value: 1 }]],
        },
      ]),
    ).toThrow("exactly one");
    expect(() =>
      validateSheetChartOperations([
        {
          op: "update_column_chart_display",
          chart_id: "chart0",
          changes: { legend_position: "left" },
        },
      ]),
    ).toThrow("right");
    expect(() =>
      validateSheetChartOperations([
        {
          op: "delete_chart",
          chart_id: "chart0",
          force: true,
        },
      ]),
    ).toThrow("unverified fields");

    const extraCellEnvelope = JSON.parse(chartDraft(false)) as {
      sheet: string;
    };
    const extraCellWorksheets = JSON.parse(
      inflateSync(Buffer.from(extraCellEnvelope.sheet, "latin1")).toString(
        "utf8",
      ),
    ) as Array<{ data: Record<string, Record<string, unknown>> }>;
    extraCellWorksheets[0]!.data[0]!["2"] = { v: "extra" };
    extraCellEnvelope.sheet = deflateSync(
      JSON.stringify(extraCellWorksheets),
    ).toString("latin1");
    expect(() =>
      applyLakeSheetChartOperations({
        id: "10",
        title: "chart fixture",
        draftVersion: 2,
        bodyDraft: JSON.stringify(extraCellEnvelope),
        operations: [
          {
            op: "create_column_chart",
            worksheet_id: "0",
            range: "A1:B3",
          },
        ],
      }),
    ).toThrow("replay-verified A1:B3 shape");

    const envelope = JSON.parse(chartDraft(true)) as Record<string, unknown>;
    const chart = (envelope.vessels as Record<string, Record<string, unknown>>)
      .chart0!;
    chart.chartConfigs = {
      chartType: "column",
      arbitraryFutureField: true,
    };
    expect(() =>
      applyLakeSheetChartOperations({
        id: "10",
        title: "chart fixture",
        draftVersion: 2,
        bodyDraft: JSON.stringify(envelope),
        operations: [
          {
            op: "update_column_chart_display",
            chart_id: "chart0",
            changes: { border: true },
          },
        ],
      }),
    ).toThrow("unverified config fields");
  });
});

function chartDraft(withChart: boolean): string {
  const worksheet = {
    id: "0",
    name: "Sheet1",
    rowCount: 200,
    colCount: 26,
    index: 0,
    data: {
      0: { 0: { v: "项目" }, 1: { v: "数量" } },
      1: { 0: { v: "测试A" }, 1: { v: 4 } },
      2: { 0: { v: "测试B" }, 1: { v: 5 } },
    },
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
  return JSON.stringify({
    format: "lakesheet",
    version: "3.5.5",
    larkJson: true,
    sheet: deflateSync(JSON.stringify([worksheet])).toString("latin1"),
    calcChain: [],
    vessels: withChart
      ? {
          chart0: {
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
            bbox: {
              left: 306.29999999999995,
              top: 142.36666666666665,
              width: 408.40000000000003,
              height: 282.2666666666667,
            },
            chartConfigs: { chartType: "column" },
            sheet: 0,
            dataSheet: 0,
            dataType: { name: "number" },
          },
        }
      : {},
    customColors: [],
    formulaCalclated: true,
    useIndex: true,
    useUTC: true,
    versionId: "chartfixture0001",
    meta: { sort: 0, shareFilter: 0 },
  });
}

function worksheetPayload(bodyDraft: string): unknown {
  const envelope = JSON.parse(bodyDraft) as { sheet: string };
  return JSON.parse(
    inflateSync(Buffer.from(envelope.sheet, "latin1")).toString("utf8"),
  ) as unknown;
}
