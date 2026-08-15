import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeLakeSheetDraft,
  encodeLakeSheetDraft,
} from "../src/sheet-codec.js";
import { applySheetOperations, readSheetRange } from "../src/sheet-model.js";

describe("verified LakeSheet draft codec", () => {
  it("represents a newly created empty Sheet without inventing a worksheet", () => {
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "test_创建表格",
      draftVersion: 0,
      bodyDraft: "",
    });

    expect(decoded.workbook).toMatchObject({
      id: "10",
      title: "test_创建表格",
      revision: "0",
      worksheets: [],
    });
    expect(decoded.workbook.fingerprint).toHaveLength(64);
  });

  it("decodes sparse values and formulas and supports bounded A1 reads", () => {
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 3,
      bodyDraft: draft([
        {
          id: "sheet-1",
          name: "Sheet1",
          rowCount: 200,
          colCount: 26,
          data: {
            0: { 0: { v: "name" }, 1: { v: "value" } },
            1: {
              0: { v: "fixture" },
              1: { v: 2 },
              2: {
                v: {
                  class: "formula",
                  formula: "B2*2",
                  value: 4,
                  error: null,
                },
              },
            },
          },
          mergeCells: {},
          filter: {},
        },
      ]),
    });

    expect(decoded.workbook.revision).toBe("3");
    expect(decoded.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: "name" },
      B2: { value: 2 },
      C2: { value: 4, formula: "=B2*2", kind: "formula" },
    });
    expect(
      readSheetRange(decoded.workbook.worksheets[0]!, "A1:C2"),
    ).toMatchObject({
      range: "A1:C2",
      cells: [
        [{ value: "name" }, { value: "value" }, { value: null }],
        [{ value: "fixture" }, { value: 2 }, { value: 4, formula: "=B2*2" }],
      ],
    });
    expect(() =>
      readSheetRange(decoded.workbook.worksheets[0]!, "A1:A10001"),
    ).toThrow("cell limit");
  });

  it("marks unverified rich cells and structural features without dropping them silently", () => {
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "rich",
      draftVersion: 1,
      bodyDraft: draft(
        [
          {
            id: "sheet-1",
            name: "Sheet1",
            data: {
              0: {
                0: { v: { class: "image", value: null }, s: "opaque" },
              },
            },
            mergeCells: { "0:0": { rowCount: 1, colCount: 2 } },
            filter: {},
          },
        ],
        {
          vessels: {
            chart: {
              type: "chart",
              chartConfigs: { chartType: "column" },
              selections: { row: 0, col: 1, rowCount: 3, colCount: 2 },
              sheet: "sheet-1",
              dataSheet: 7,
            },
          },
        },
      ),
    });

    expect(decoded.workbook.worksheets[0]?.cells.A1).toMatchObject({
      value: null,
      kind: "image",
      unsupported: true,
    });
    expect(decoded.unsupportedFeatures).toEqual(
      expect.arrayContaining([
        "cell_kind:image",
        "charts_or_vessels",
        "invalid_cell_style_token",
        "merged_cells",
      ]),
    );
    expect(decoded.chartSummaries).toEqual([
      {
        chartId: null,
        chartType: "column",
        chartTypeVerifiedOnPersonalHost: true,
        displayConfigProjectionVerifiedOnPersonalHost: true,
        displayConfig: {
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
        },
        sourceRange: {
          startRow: 0,
          startColumn: 1,
          rowCount: 3,
          columnCount: 2,
        },
        worksheetId: "sheet-1",
        dataWorksheetId: "7",
      },
    ]);
    const changedChart = decodeLakeSheetDraft({
      id: "10",
      title: "rich",
      draftVersion: 1,
      bodyDraft: draft(
        [
          {
            id: "sheet-1",
            name: "Sheet1",
            data: {
              0: {
                0: { v: { class: "image", value: null }, s: "opaque" },
              },
            },
            mergeCells: { "0:0": { rowCount: 1, colCount: 2 } },
            filter: {},
          },
        ],
        { vessels: { chart: { chartConfigs: { chartType: "line" } } } },
      ),
    });
    expect(decoded.workbook.opaqueStructureFingerprint).toHaveLength(64);
    expect(changedChart.workbook.fingerprint).not.toBe(
      decoded.workbook.fingerprint,
    );
  });

  it("marks only the eight personal-host chart types with live evidence", () => {
    const chartTypes = [
      "column",
      "stackColumn",
      "bar",
      "stackBar",
      "line",
      "smoothLine",
      "pie",
      "ring",
      "radar",
    ];
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "charts",
      draftVersion: 10,
      bodyDraft: draft(
        [
          {
            id: "sheet-1",
            name: "Sheet1",
            data: {},
            mergeCells: {},
            filter: {},
          },
        ],
        {
          vessels: Object.fromEntries(
            chartTypes.map((chartType, index) => [
              `chart-${String(index)}`,
              { type: "chart", chartConfigs: { chartType } },
            ]),
          ),
        },
      ),
    });

    expect(
      decoded.chartSummaries.map((summary) => [
        summary.chartType,
        summary.chartTypeVerifiedOnPersonalHost,
      ]),
    ).toEqual([
      ["column", true],
      ["stackColumn", true],
      ["bar", true],
      ["stackBar", true],
      ["line", true],
      ["smoothLine", true],
      ["pie", true],
      ["ring", true],
      ["radar", false],
    ]);
  });

  it("projects only the verified column-chart display config fields", () => {
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "configured-chart",
      draftVersion: 11,
      bodyDraft: draft(
        [
          {
            id: "sheet-1",
            name: "Sheet1",
            data: {},
            mergeCells: {},
            filter: {},
          },
        ],
        {
          vessels: {
            chart: {
              type: "chart",
              chartConfigs: {
                chartType: "column",
                theme: 5,
                layout: 4,
                border: true,
                hiddenData: false,
                showEmptyData: true,
                grid: false,
                formatter: "custom",
                prefix: "¥",
                suffix: "元",
                title: { visible: true },
                titles: {
                  title: "MCP 图表配置验证",
                  xAxis: "类别",
                  yAxis: "数值",
                },
                legend: { position: "right" },
                label: { visible: true },
                xAxis: {
                  title: { visible: true },
                  label: { visible: true, rotate: -45 },
                },
                yAxis: {
                  title: { visible: true },
                  minLimit: 0,
                  maxLimit: 50,
                },
                unverifiedSecretShape: { nested: "not projected" },
              },
            },
          },
        },
      ),
    });

    expect(decoded.chartSummaries).toEqual([
      expect.objectContaining({
        chartType: "column",
        displayConfigProjectionVerifiedOnPersonalHost: true,
        displayConfig: {
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
        },
      }),
    ]);
    expect(JSON.stringify(decoded.chartSummaries)).not.toContain(
      "unverifiedSecretShape",
    );

    const invalidIndexes = decodeLakeSheetDraft({
      id: "10",
      title: "invalid-chart-indexes",
      draftVersion: 11,
      bodyDraft: draft(
        [
          {
            id: "sheet-1",
            name: "Sheet1",
            data: {},
            mergeCells: {},
            filter: {},
          },
        ],
        {
          vessels: {
            chart: {
              type: "chart",
              chartConfigs: { chartType: "column", theme: 6, layout: -1 },
            },
          },
        },
      ),
    });
    expect(invalidIndexes.chartSummaries[0]?.displayConfig).toMatchObject({
      themeIndex: null,
      layoutIndex: null,
    });
  });

  it("fails closed instead of projecting display config for other chart types", () => {
    const decoded = decodeLakeSheetDraft({
      id: "11",
      title: "unverified-chart-config-type",
      draftVersion: 1,
      bodyDraft: draft(
        [
          {
            id: "sheet-1",
            name: "Sheet1",
            data: {},
            mergeCells: {},
            filter: {},
          },
        ],
        {
          vessels: {
            chart: {
              type: "chart",
              chartConfigs: {
                chartType: "line",
                border: true,
                titles: { title: "not verified for line" },
                xAxis: { label: { rotate: -45 } },
              },
            },
          },
        },
      ),
    });

    expect(decoded.chartSummaries).toEqual([
      expect.objectContaining({
        chartType: "line",
        chartTypeVerifiedOnPersonalHost: true,
        displayConfigProjectionVerifiedOnPersonalHost: false,
        displayConfig: {
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
        },
      }),
    ]);
    expect(JSON.stringify(decoded.chartSummaries)).not.toContain(
      "not verified for line",
    );
  });

  it("decodes the verified basic-style token store", () => {
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "styled",
      draftVersion: 3,
      bodyDraft: draft([
        {
          id: "sheet-1",
          name: "Sheet1",
          data: {
            0: { 3: { v: "styled-cell", s: 0 } },
            2: { 1: { v: 7, t: 0 } },
          },
          mergeCells: {},
          filter: {},
          vStore: {
            style_color: ["#1677ff"],
            style_backColor: ["#e6f4ff"],
            style: ["w7_s2_c0_b0_h2"],
            type: ["n3_d2"],
          },
        },
      ]),
    });

    expect(decoded.workbook.worksheets[0]?.cells.D1).toEqual({
      value: "styled-cell",
      style: {
        bold: true,
        italic: true,
        textColor: "#1677ff",
        fillColor: "#e6f4ff",
        horizontalAlign: "center",
      },
    });
    expect(decoded.workbook.worksheets[0]?.cells.B3).toEqual({
      value: 7,
      style: { numberFormat: "number:2" },
    });
    expect(decoded.unsupportedFeatures).toEqual([]);
  });

  it("fails closed for malformed or oversized workbook structures", () => {
    expect(() =>
      decodeLakeSheetDraft({
        id: "1",
        title: "bad",
        draftVersion: 1,
        bodyDraft: JSON.stringify({ format: "lakesheet", sheet: "bad" }),
      }),
    ).toThrow();
  });

  it("round-trips a value, formula and verified styles semantically", () => {
    const bodyDraft = draft(
      [
        {
          id: "sheet-1",
          name: "Sheet1",
          data: { 0: { 0: { v: "old" } } },
          mergeCells: {},
          filter: {},
          untouchedWorksheetField: { keep: true },
        },
      ],
      { untouchedEnvelopeField: "keep" },
    );
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 7,
      bodyDraft,
    });
    const applied = applySheetOperations(decoded.workbook, [
      {
        op: "set_range",
        worksheet_id: "sheet-1",
        range: "A1:C1",
        cells: [
          [
            { value: "new" },
            { value: 4, formula: "=2+2" },
            {
              value: 8,
              style: {
                number_format: "number:2",
                bold: true,
                italic: true,
                text_color: "#1677ff",
                fill_color: "#e6f4ff",
                horizontal_align: "right",
              },
            },
          ],
        ],
      },
    ]);
    const encoded = encodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 7,
      bodyDraft,
      workbook: applied.workbook,
    });

    expect(encoded.workbook.fingerprint).toBe(applied.workbook.fingerprint);
    expect(encoded.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: "new" },
      B1: { value: 4, formula: "=2+2", kind: "formula" },
      C1: {
        value: 8,
        style: {
          numberFormat: "number:2",
          bold: true,
          italic: true,
          textColor: "#1677ff",
          fillColor: "#e6f4ff",
          horizontalAlign: "right",
        },
      },
    });
    const envelope = JSON.parse(encoded.bodyDraft) as Record<string, unknown>;
    const worksheets = JSON.parse(
      inflateSync(Buffer.from(String(envelope.sheet), "latin1")).toString(
        "utf8",
      ),
    ) as Array<Record<string, unknown>>;
    expect(envelope.untouchedEnvelopeField).toBe("keep");
    expect(worksheets[0]?.untouchedWorksheetField).toEqual({ keep: true });
  });

  it("encodes a confirmed cell clear as an absent sparse cell", () => {
    const bodyDraft = draft([
      {
        id: "sheet-1",
        name: "Sheet1",
        data: { 0: { 0: { v: "remove" }, 1: { v: "keep" } } },
        mergeCells: {},
        filter: {},
      },
    ]);
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 1,
      bodyDraft,
    });
    const applied = applySheetOperations(decoded.workbook, [
      {
        op: "set_range",
        worksheet_id: "sheet-1",
        range: "A1:A1",
        cells: [[{ value: null }]],
      },
    ]);
    expect(applied.diff).toMatchObject([{ cell: "A1", deletion: true }]);
    const encoded = encodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 1,
      bodyDraft,
      workbook: applied.workbook,
    });
    expect(encoded.workbook.worksheets[0]?.cells.A1).toBeUndefined();
    expect(encoded.workbook.worksheets[0]?.cells.B1).toEqual({ value: "keep" });
  });

  it("encodes only replay-verified empty row, column and worksheet deletion", () => {
    const bodyDraft = draft([
      {
        id: "sheet-1",
        name: "Sheet1",
        index: 0,
        rowCount: 200,
        colCount: 26,
        data: { 0: { 0: { v: "keep" } } },
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: {},
        vStore: {},
      },
      {
        id: "sheet-2",
        name: "Empty",
        index: 1,
        rowCount: 200,
        colCount: 26,
        data: {},
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: {},
        vStore: {},
      },
    ]);
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 1,
      bodyDraft,
    });

    for (const fixture of [
      {
        operation: {
          op: "delete_rows",
          worksheet_id: "sheet-2",
          start_row: 11,
          count: 1,
        },
        assertRaw: (worksheets: Array<Record<string, unknown>>) => {
          expect(worksheets).toHaveLength(2);
          expect(worksheets[1]?.rowCount).toBe(199);
          expect(worksheets[1]?.colCount).toBe(26);
        },
      },
      {
        operation: {
          op: "delete_columns",
          worksheet_id: "sheet-2",
          start_column: 11,
          count: 1,
        },
        assertRaw: (worksheets: Array<Record<string, unknown>>) => {
          expect(worksheets).toHaveLength(2);
          expect(worksheets[1]?.rowCount).toBe(200);
          expect(worksheets[1]?.colCount).toBe(25);
        },
      },
      {
        operation: { op: "delete_worksheet", worksheet_id: "sheet-2" },
        assertRaw: (worksheets: Array<Record<string, unknown>>) => {
          expect(worksheets).toHaveLength(1);
          expect(worksheets[0]?.id).toBe("sheet-1");
        },
      },
    ]) {
      const applied = applySheetOperations(decoded.workbook, [
        fixture.operation,
      ]);
      expect(applied.diff).toMatchObject([
        { kind: "structure", deletion: true },
      ]);
      const encoded = encodeLakeSheetDraft({
        id: "10",
        title: "test_表格",
        draftVersion: 1,
        bodyDraft,
        workbook: applied.workbook,
      });
      const envelope = JSON.parse(encoded.bodyDraft) as Record<string, unknown>;
      const worksheets = JSON.parse(
        inflateSync(Buffer.from(String(envelope.sheet), "latin1")).toString(
          "utf8",
        ),
      ) as Array<Record<string, unknown>>;
      fixture.assertRaw(worksheets);
      expect(encoded.workbook.worksheets[0]?.cells.A1?.value).toBe("keep");
    }

    const filteredDraft = draft([
      {
        id: "sheet-1",
        name: "Sheet1",
        index: 0,
        rowCount: 200,
        colCount: 26,
        data: {},
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: { range: { row: 0, col: 0, rowCount: 1, colCount: 1 } },
        vStore: {},
      },
      {
        id: "sheet-2",
        name: "Other",
        index: 1,
        rowCount: 200,
        colCount: 26,
        data: {},
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: {},
        vStore: {},
      },
    ]);
    const filtered = decodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 1,
      bodyDraft: filteredDraft,
    });
    const deletedFiltered = applySheetOperations(filtered.workbook, [
      { op: "delete_worksheet", worksheet_id: "sheet-1" },
    ]);
    expect(() =>
      encodeLakeSheetDraft({
        id: "10",
        title: "test_表格",
        draftVersion: 1,
        bodyDraft: filteredDraft,
        workbook: deletedFiltered.workbook,
      }),
    ).toThrow("requires empty 'filter'");
  });

  it("encodes one replay-verified simple unreferenced worksheet rename", () => {
    const bodyDraft = draft([
      {
        id: "sheet-1",
        name: "Sheet1",
        index: 0,
        rowCount: 200,
        colCount: 26,
        data: { 0: { 0: { v: "keep" } } },
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: {},
        vStore: {},
      },
      {
        id: "sheet-2",
        name: "验证工作表",
        index: 1,
        rowCount: 200,
        colCount: 26,
        data: {
          0: {
            0: { v: "text" },
            1: { v: 42 },
            2: { v: true },
          },
        },
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: {},
        vStore: {},
      },
    ]);
    const decoded = decodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 1,
      bodyDraft,
    });
    const renamed = applySheetOperations(decoded.workbook, [
      {
        op: "rename_worksheet",
        worksheet_id: "sheet-2",
        name: "验证工作表_临时",
      },
    ]);
    const encoded = encodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 1,
      bodyDraft,
      workbook: renamed.workbook,
    });
    expect(
      encoded.workbook.worksheets.map((worksheet) => worksheet.name),
    ).toEqual(["Sheet1", "验证工作表_临时"]);
    expect(encoded.workbook.worksheets[0]?.cells.A1?.value).toBe("keep");
    expect(encoded.workbook.worksheets[1]?.cells).toEqual({
      A1: { value: "text" },
      B1: { value: 42 },
      C1: { value: true },
    });
    const envelope = JSON.parse(encoded.bodyDraft) as { sheet: string };
    const raw = JSON.parse(
      inflateSync(Buffer.from(envelope.sheet, "latin1")).toString("utf8"),
    ) as Array<Record<string, unknown>>;
    expect(raw[1]?.name).toBe("验证工作表_临时");

    const nonEmpty = structuredClone(decoded.workbook);
    nonEmpty.worksheets[1]!.name = "Renamed";
    nonEmpty.worksheets[1]!.cells.A1 = { value: "content" };
    expect(() =>
      encodeLakeSheetDraft({
        id: "10",
        title: "test_表格",
        draftVersion: 1,
        bodyDraft,
        workbook: nonEmpty,
      }),
    ).toThrow("cannot be combined with cell changes");

    const referencedBody = draft([
      {
        id: "sheet-1",
        name: "Sheet1",
        index: 0,
        rowCount: 200,
        colCount: 26,
        data: {
          0: {
            0: {
              v: {
                class: "formula",
                formula: "='验证工作表'!A1",
                value: null,
              },
            },
          },
        },
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: {},
        vStore: {},
      },
      {
        id: "sheet-2",
        name: "验证工作表",
        index: 1,
        rowCount: 200,
        colCount: 26,
        data: {},
        rows: {},
        columns: {},
        selections: {},
        mergeCells: {},
        filter: {},
        vStore: {},
      },
    ]);
    const referenced = decodeLakeSheetDraft({
      id: "10",
      title: "test_表格",
      draftVersion: 1,
      bodyDraft: referencedBody,
    });
    expect(() =>
      applySheetOperations(referenced.workbook, [
        {
          op: "rename_worksheet",
          worksheet_id: "sheet-2",
          name: "Renamed",
        },
      ]),
    ).toThrow("formula references");
  });

  it("encodes the verified first native worksheet while keeping later worksheet creation disabled", () => {
    const empty = decodeLakeSheetDraft({
      id: "10",
      title: "empty",
      draftVersion: 0,
      bodyDraft: "",
    });
    const firstWorksheet = applySheetOperations(empty.workbook, [
      { op: "add_worksheet", name: "Sheet1", rows: [[{ value: "x" }]] },
    ]);
    const initialized = encodeLakeSheetDraft({
      id: "10",
      title: "empty",
      draftVersion: 0,
      bodyDraft: "",
      workbook: firstWorksheet.workbook,
    });
    expect(initialized.workbook.worksheets).toHaveLength(1);
    expect(initialized.workbook.worksheets[0]).toMatchObject({
      id: firstWorksheet.workbook.worksheets[0]?.id,
      name: "Sheet1",
      cells: { A1: { value: "x" } },
    });
    const initializedEnvelope = JSON.parse(initialized.bodyDraft) as {
      format: string;
      version: string;
      versionId: string;
      meta: unknown;
      sheet: string;
    };
    expect(initializedEnvelope).toMatchObject({
      format: "lakesheet",
      version: "3.5.5",
      meta: { sort: 0, shareFilter: 0 },
    });
    expect(initializedEnvelope.versionId).toHaveLength(16);
    const initializedWorksheets = JSON.parse(
      inflateSync(Buffer.from(initializedEnvelope.sheet, "latin1")).toString(
        "utf8",
      ),
    ) as Array<Record<string, unknown>>;
    expect(initializedWorksheets[0]).toMatchObject({
      name: "Sheet1",
      rowCount: 200,
      colCount: 26,
      index: 0,
      selections: {},
      rows: {},
      columns: {},
      filter: {},
      mergeCells: {},
    });

    const existingDraft = draft([
      { id: "sheet-1", name: "Sheet1", data: {}, mergeCells: {}, filter: {} },
    ]);
    const existing = decodeLakeSheetDraft({
      id: "10",
      title: "existing",
      draftVersion: 1,
      bodyDraft: existingDraft,
    });
    const added = applySheetOperations(existing.workbook, [
      { op: "add_worksheet", name: "Sheet2" },
    ]);
    expect(() =>
      encodeLakeSheetDraft({
        id: "10",
        title: "existing",
        draftVersion: 1,
        bodyDraft: existingDraft,
        workbook: added.workbook,
      }),
    ).toThrow("raw worksheet template");
  });
});

it("reuses an equivalent existing style token and restores the original body exactly", () => {
  const bodyDraft = draft([
    {
      id: "sheet-1",
      name: "Sheet1",
      data: { 0: { 3: { v: "styled", s: 0 } } },
      vStore: {
        style: ["c0_b0_h2_s2_w6"],
        style_color: ["#1677ff"],
        style_backColor: ["#e6f4ff"],
        type: ["n3_d2"],
      },
      mergeCells: {},
      filter: {},
    },
  ]);
  const decoded = decodeLakeSheetDraft({
    id: "10",
    title: "test_表格",
    draftVersion: 7,
    bodyDraft,
  });
  const added = applySheetOperations(decoded.workbook, [
    {
      op: "set_range",
      worksheet_id: "sheet-1",
      range: "K1:K1",
      cells: [
        [
          {
            value: 12.34,
            style: {
              number_format: "number:2",
              bold: true,
              italic: true,
              text_color: "#1677ff",
              fill_color: "#e6f4ff",
              horizontal_align: "center",
            },
          },
        ],
      ],
    },
  ]);
  const encoded = encodeLakeSheetDraft({
    id: "10",
    title: "test_表格",
    draftVersion: 7,
    bodyDraft,
    workbook: added.workbook,
  });
  const encodedEnvelope = JSON.parse(encoded.bodyDraft) as {
    sheet: string;
  };
  const encodedWorksheets = JSON.parse(
    inflateSync(Buffer.from(encodedEnvelope.sheet, "latin1")).toString("utf8"),
  ) as Array<{
    data: Record<string, Record<string, { s?: number; t?: number }>>;
    vStore: { style: string[]; type: string[] };
  }>;
  expect(encodedWorksheets[0]?.vStore.style).toEqual(["c0_b0_h2_s2_w6"]);
  expect(encodedWorksheets[0]?.vStore.type).toEqual(["n3_d2"]);
  expect(encodedWorksheets[0]?.data["0"]?.["10"]).toMatchObject({
    s: 0,
    t: 0,
  });

  const cleared = applySheetOperations(encoded.workbook, [
    {
      op: "set_range",
      worksheet_id: "sheet-1",
      range: "K1:K1",
      cells: [[{ value: null }]],
    },
  ]);
  const restored = encodeLakeSheetDraft({
    id: "10",
    title: "test_表格",
    draftVersion: 7,
    bodyDraft: encoded.bodyDraft,
    workbook: cleared.workbook,
  });
  expect(restored.bodyDraft).toBe(bodyDraft);
});

function draft(
  worksheets: unknown[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    format: "lakesheet",
    version: "3.5.5",
    larkJson: true,
    sheet: deflateSync(JSON.stringify(worksheets)).toString("latin1"),
    calcChain: [],
    vessels: {},
    ...overrides,
  });
}
