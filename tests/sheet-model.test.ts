import { describe, expect, it } from "vitest";
import {
  applySheetOperations,
  diffSheetRange,
  parseA1Range,
  sheetSemanticFingerprint,
  type NormalizedWorkbook,
  validateSheetOperations,
} from "../src/sheet-model.js";

describe("safe Sheet model", () => {
  it("validates A1 ranges and limits affected cells", () => {
    expect(parseA1Range("A1:C2")).toEqual({
      startRow: 1,
      startColumn: 1,
      endRow: 2,
      endColumn: 3,
    });
    expect(() => parseA1Range("C2:A1")).toThrow("must not precede");
    expect(() =>
      validateSheetOperations([
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:B1",
          cells: [[{ value: 1 }]],
        },
      ]),
    ).toThrow("dimensions");
  });

  it("allows only the replay-verified empty structural deletion shapes", () => {
    const workbook: NormalizedWorkbook = {
      id: "book-1",
      title: "Sheet",
      revision: "1",
      fingerprint: "base",
      worksheets: [
        {
          id: "sheet-1",
          name: "Sheet1",
          rowCount: 200,
          columnCount: 26,
          cells: { A1: { value: "keep" } },
        },
        {
          id: "sheet-2",
          name: "Empty",
          rowCount: 200,
          columnCount: 26,
          cells: {},
        },
      ],
    };
    const rows = applySheetOperations(workbook, [
      {
        op: "delete_rows",
        worksheet_id: "sheet-2",
        start_row: 11,
        count: 1,
      },
    ]);
    expect(rows.workbook.worksheets[1]?.rowCount).toBe(199);
    expect(rows.diff).toEqual([
      {
        kind: "structure",
        worksheet: "Empty",
        structure: "rows",
        start: 11,
        count: 1,
        deletion: true,
      },
    ]);
    const columns = applySheetOperations(workbook, [
      {
        op: "delete_columns",
        worksheet_id: "sheet-2",
        start_column: 11,
        count: 1,
      },
    ]);
    expect(columns.workbook.worksheets[1]?.columnCount).toBe(25);
    const worksheet = applySheetOperations(workbook, [
      { op: "delete_worksheet", worksheet_id: "sheet-2" },
    ]);
    expect(worksheet.workbook.worksheets.map((entry) => entry.id)).toEqual([
      "sheet-1",
    ]);
    expect(worksheet.diff[0]).toMatchObject({
      kind: "structure",
      structure: "worksheet",
      deletion: true,
    });

    expect(() =>
      applySheetOperations(workbook, [
        { op: "delete_worksheet", worksheet_id: "sheet-1" },
      ]),
    ).toThrow("only for an empty worksheet");
    expect(() =>
      validateSheetOperations([
        {
          op: "delete_rows",
          worksheet_id: "sheet-2",
          start_row: 11,
          count: 2,
        },
      ]),
    ).toThrow("Only count=1");
    expect(() =>
      validateSheetOperations([
        {
          op: "delete_rows",
          worksheet_id: "sheet-2",
          start_row: 10,
          count: 1,
        },
      ]),
    ).toThrow("Only start_row=11");
    expect(() =>
      validateSheetOperations([
        { op: "delete_worksheet", worksheet_id: "sheet-2" },
        {
          op: "delete_columns",
          worksheet_id: "sheet-2",
          start_column: 11,
          count: 1,
        },
      ]),
    ).toThrow("exactly one");
    expect(() =>
      validateSheetOperations(
        [
          {
            op: "set_range",
            worksheet_id: "sheet-1",
            range: "A1:A10001",
            cells: Array.from({ length: 10_001 }, () => [{ value: 1 }]),
          },
        ],
        10_000,
      ),
    ).toThrow("cell limit");
  });

  it("previews one worksheet rename with verified UI name rules", () => {
    const workbook: NormalizedWorkbook = {
      id: "book-1",
      title: "Sheet",
      revision: "1",
      fingerprint: "base",
      worksheets: [
        {
          id: "sheet-1",
          name: "Sheet1",
          rowCount: 200,
          columnCount: 26,
          cells: { A1: { value: "keep" } },
        },
        {
          id: "sheet-2",
          name: "验证工作表",
          rowCount: 200,
          columnCount: 26,
          cells: {
            A1: { value: "text" },
            B1: { value: 42 },
            C1: { value: true },
          },
        },
      ],
    };
    const renamed = applySheetOperations(workbook, [
      {
        op: "rename_worksheet",
        worksheet_id: "sheet-2",
        name: "验证工作表_临时",
      },
    ]);
    expect(renamed.workbook.worksheets[1]?.name).toBe("验证工作表_临时");
    expect(renamed.workbook.worksheets[1]?.cells).toEqual(
      workbook.worksheets[1]?.cells,
    );
    expect(renamed.diff).toEqual([
      {
        kind: "structure",
        worksheet: "验证工作表",
        structure: "worksheet_name",
        before: "验证工作表",
        after: "验证工作表_临时",
        count: 1,
        deletion: false,
      },
    ]);
    for (const name of [
      "History",
      "has space",
      "bad/name",
      "bad:name",
      "'quoted",
      "quoted'",
      "x".repeat(32),
    ]) {
      expect(() =>
        validateSheetOperations([
          {
            op: "rename_worksheet",
            worksheet_id: "sheet-2",
            name,
          },
        ]),
      ).toThrow("Worksheet name");
    }
    expect(() =>
      applySheetOperations(workbook, [
        {
          op: "rename_worksheet",
          worksheet_id: "sheet-2",
          name: "Sheet1",
        },
      ]),
    ).toThrow("already exists");
    expect(() =>
      validateSheetOperations([
        {
          op: "rename_worksheet",
          worksheet_id: "sheet-2",
          name: "Temp",
        },
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:A1",
          cells: [[{ value: "changed" }]],
        },
      ]),
    ).toThrow("exactly one verified worksheet rename");

    const referenced = structuredClone(workbook);
    referenced.worksheets[0]!.cells.D1 = {
      value: 42,
      formula: "='验证工作表'!B1",
      kind: "formula",
    };
    expect(() =>
      applySheetOperations(referenced, [
        {
          op: "rename_worksheet",
          worksheet_id: "sheet-2",
          name: "Renamed",
        },
      ]),
    ).toThrow("formula references");
  });

  it("detects cell clearing as deletion and fingerprints formulas/styles", () => {
    const changes = diffSheetRange(
      "Sheet1",
      "A1:B1",
      [[{ value: "keep" }, { value: 1, formula: "=1" }]],
      [[{ value: null }, { value: 2, formula: "=1+1" }]],
    );
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ cell: "A1", deletion: true });
    expect(changes[1]).toMatchObject({ cell: "B1", deletion: false });

    const first = sheetSemanticFingerprint({
      id: "1",
      title: "Sheet",
      worksheets: [
        {
          id: "sheet-1",
          name: "Sheet1",
          cells: { A1: { value: 1, style: { bold: true } } },
        },
      ],
    });
    const second = sheetSemanticFingerprint({
      id: "1",
      title: "Sheet",
      worksheets: [
        {
          id: "sheet-1",
          name: "Sheet1",
          cells: { A1: { value: 1, style: { bold: false } } },
        },
      ],
    });
    expect(first).not.toBe(second);
  });

  it("calculates only the verified common formula subset and ignores supplied cached values", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A2: { value: "fixture" },
              A3: { value: "other" },
              B2: { value: 2 },
              B3: { value: 7 },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "C1:H1",
          cells: [
            [
              { value: 999, formula: "=SUM(B2:B3)" },
              { formula: "=AVERAGE(B2:B3)" },
              { formula: '=IF(B2>1,"yes","no")' },
              { formula: '=COUNTIF(A2:A3,"fixture")' },
              { formula: "=ROUND(10/3,2)" },
              { formula: "=(B2+B3)*2" },
            ],
          ],
        },
      ],
    );
    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      C1: { value: 9, formula: "=SUM(B2:B3)", kind: "formula" },
      D1: { value: 4.5, formula: "=AVERAGE(B2:B3)" },
      E1: { value: "yes", formula: '=IF(B2>1,"yes","no")' },
      F1: { value: 1, formula: '=COUNTIF(A2:A3,"fixture")' },
      G1: { value: 3.33, formula: "=ROUND(10/3,2)" },
      H1: { value: 18, formula: "=(B2+B3)*2" },
    });
    expect(applied.diff).toHaveLength(6);
  });

  it("calculates the extended verified aggregate, logical and conditional formula subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A1: { value: 2 },
              A2: { value: 7 },
              A3: { value: null },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "B1:J1",
          cells: [
            [
              { formula: "=MIN(A1:A2)" },
              { formula: "=MAX(A1:A2)" },
              { formula: "=COUNT(A1:A3)" },
              { formula: "=COUNTA(A1:A3)" },
              { formula: "=ABS(A1-A2)" },
              { formula: "=AND(A1=2,A2=7)" },
              { formula: "=OR(A1=0,A2=7)" },
              { formula: "=NOT(A1=7)" },
              { formula: '=SUMIF(A1:A2,">2",A1:A2)' },
            ],
          ],
        },
      ],
    );
    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      B1: { value: 2, formula: "=MIN(A1:A2)" },
      C1: { value: 7, formula: "=MAX(A1:A2)" },
      D1: { value: 2, formula: "=COUNT(A1:A3)" },
      E1: { value: 2, formula: "=COUNTA(A1:A3)" },
      F1: { value: 5, formula: "=ABS(A1-A2)" },
      G1: { value: true, formula: "=AND(A1=2,A2=7)" },
      H1: { value: true, formula: "=OR(A1=0,A2=7)" },
      I1: { value: true, formula: "=NOT(A1=7)" },
      J1: { value: 7, formula: '=SUMIF(A1:A2,">2",A1:A2)' },
    });
    expect(applied.diff).toHaveLength(9);
  });

  it("calculates the verified multi-branch logical subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [{ id: "sheet-1", name: "Sheet1", cells: {} }],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:C1",
          cells: [
            [
              { formula: '=IFS(1=0,"no",2=2,"yes")' },
              { formula: '=SWITCH(2,1,"one",2,"two","other")' },
              { value: true, formula: "=XOR(TRUE,FALSE,TRUE)" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: "yes", formula: '=IFS(1=0,"no",2=2,"yes")' },
      B1: {
        value: "two",
        formula: '=SWITCH(2,1,"one",2,"two","other")',
      },
      C1: { value: false, formula: "=XOR(TRUE,FALSE,TRUE)" },
    });
    expect(applied.diff).toHaveLength(3);
  });

  it("calculates the verified text formula subset without trusting cached values", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [{ id: "sheet-1", name: "Sheet1", cells: {} }],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:O1",
          cells: [
            [
              { value: "forged", formula: '=CONCAT("Yu","que")' },
              { formula: '=CONCATENATE("M","C","P")' },
              { formula: '=LEFT("Yuque",2)' },
              { formula: '=RIGHT("Yuque",3)' },
              { formula: '=MID("YuqueMCP",6,3)' },
              { formula: '=LEN("YuqueMCP")' },
              { formula: '=LOWER("MCP")' },
              { formula: '=UPPER("yuque")' },
              { formula: '=TRIM("  yuque mcp  ")' },
              { formula: '=FIND("MCP","YuqueMCP",1)' },
              { formula: '=SEARCH("mcp","YuqueMCP",1)' },
              { formula: '=SUBSTITUTE("a-b-a","a","x")' },
              { formula: '=REPLACE("YuqueMCP",6,3,"Agent")' },
              { formula: '=REPT("ha",3)' },
              { formula: '=EXACT("MCP","mcp")' },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: "Yuque", formula: '=CONCAT("Yu","que")' },
      B1: { value: "MCP", formula: '=CONCATENATE("M","C","P")' },
      C1: { value: "Yu", formula: '=LEFT("Yuque",2)' },
      D1: { value: "que", formula: '=RIGHT("Yuque",3)' },
      E1: { value: "MCP", formula: '=MID("YuqueMCP",6,3)' },
      F1: { value: 8, formula: '=LEN("YuqueMCP")' },
      G1: { value: "mcp", formula: '=LOWER("MCP")' },
      H1: { value: "YUQUE", formula: '=UPPER("yuque")' },
      I1: { value: "yuque mcp", formula: '=TRIM("  yuque mcp  ")' },
      J1: { value: 6, formula: '=FIND("MCP","YuqueMCP",1)' },
      K1: { value: 6, formula: '=SEARCH("mcp","YuqueMCP",1)' },
      L1: { value: "x-b-x", formula: '=SUBSTITUTE("a-b-a","a","x")' },
      M1: {
        value: "YuqueAgent",
        formula: '=REPLACE("YuqueMCP",6,3,"Agent")',
      },
      N1: { value: "hahaha", formula: '=REPT("ha",3)' },
      O1: { value: false, formula: '=EXACT("MCP","mcp")' },
    });
    expect(applied.diff).toHaveLength(15);
  });

  it("calculates the verified text-conversion and range-dimension subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A2: { value: "first" },
              B2: { value: 1 },
              A3: { value: "second" },
              B3: { value: 2 },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:G1",
          cells: [
            [
              { value: "forged", formula: '=PROPER("yuque MCP agent")' },
              { formula: "=CHAR(65)" },
              { formula: '=CODE("ABC")' },
              { formula: '=VALUE("-123.50")' },
              { formula: '=TEXT(1234.5,"0.00")' },
              { formula: "=ROWS(A2:B3)" },
              { formula: "=COLUMNS(A2:B3)" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: "Yuque Mcp Agent", formula: '=PROPER("yuque MCP agent")' },
      B1: { value: "A", formula: "=CHAR(65)" },
      C1: { value: 65, formula: '=CODE("ABC")' },
      D1: { value: -123.5, formula: '=VALUE("-123.50")' },
      E1: { value: "1234.50", formula: '=TEXT(1234.5,"0.00")' },
      F1: { value: 2, formula: "=ROWS(A2:B3)" },
      G1: { value: 2, formula: "=COLUMNS(A2:B3)" },
    });
    expect(applied.diff).toHaveLength(7);
  });

  it("calculates the verified deterministic math and statistical subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [{ id: "sheet-1", name: "Sheet1", cells: {} }],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:L1",
          cells: [
            [
              { value: -999, formula: "=ROUNDUP(10/3,2)" },
              { formula: "=ROUNDDOWN(10/3,2)" },
              { formula: "=INT(-1.2)" },
              { formula: "=MOD(7,3)" },
              { formula: "=SQRT(81)" },
              { formula: "=POWER(2,3)" },
              { formula: "=PRODUCT(2,3,4)" },
              { formula: "=MEDIAN(2,9,4)" },
              { formula: "=ROUNDUP(-1.21,1)" },
              { formula: "=ROUNDDOWN(-1.29,1)" },
              { formula: "=MOD(-7,3)" },
              { formula: "=MOD(7,-3)" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: 3.34, formula: "=ROUNDUP(10/3,2)" },
      B1: { value: 3.33, formula: "=ROUNDDOWN(10/3,2)" },
      C1: { value: -2, formula: "=INT(-1.2)" },
      D1: { value: 1, formula: "=MOD(7,3)" },
      E1: { value: 9, formula: "=SQRT(81)" },
      F1: { value: 8, formula: "=POWER(2,3)" },
      G1: { value: 24, formula: "=PRODUCT(2,3,4)" },
      H1: { value: 4, formula: "=MEDIAN(2,9,4)" },
      I1: { value: -1.3, formula: "=ROUNDUP(-1.21,1)" },
      J1: { value: -1.2, formula: "=ROUNDDOWN(-1.29,1)" },
      K1: { value: 2, formula: "=MOD(-7,3)" },
      L1: { value: -2, formula: "=MOD(7,-3)" },
    });
    expect(applied.diff).toHaveLength(12);
  });

  it("calculates the verified rounding, sum-product, choice and rank subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [{ id: "sheet-1", name: "Sheet1", cells: {} }],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:E4",
          cells: [
            [
              { formula: "=CEILING(7.1,2)" },
              { formula: "=FLOOR(7.9,2)" },
              { formula: "=SUMPRODUCT(C2:C4,D2:D4)" },
              { formula: '=CHOOSE(2,"red","blue","green")' },
              { formula: "=RANK(20,E2:E4,0)" },
            ],
            [
              { value: null },
              { value: null },
              { value: 1 },
              { value: 4 },
              { value: 10 },
            ],
            [
              { value: null },
              { value: null },
              { value: 2 },
              { value: 5 },
              { value: 20 },
            ],
            [
              { value: null },
              { value: null },
              { value: 3 },
              { value: 6 },
              { value: 30 },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: 8, formula: "=CEILING(7.1,2)" },
      B1: { value: 6, formula: "=FLOOR(7.9,2)" },
      C1: { value: 32, formula: "=SUMPRODUCT(C2:C4,D2:D4)" },
      D1: { value: "blue", formula: '=CHOOSE(2,"red","blue","green")' },
      E1: { value: 2, formula: "=RANK(20,E2:E4,0)" },
    });
    expect(applied.diff).toHaveLength(14);
  });

  it("calculates the verified deterministic logarithm and multiple subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [{ id: "sheet-1", name: "Sheet1", cells: {} }],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:J1",
          cells: [
            [
              { formula: "=SIGN(-42)" },
              { formula: "=PI()" },
              { formula: "=EXP(0)" },
              { formula: "=LN(1)" },
              { formula: "=LOG(100,10)" },
              { formula: "=LOG10(1000)" },
              { formula: "=TRUNC(-12.345,2)" },
              { formula: "=MROUND(10,3)" },
              { formula: "=QUOTIENT(-17,5)" },
              { formula: "=LOG10+1" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: -1, formula: "=SIGN(-42)" },
      B1: { value: Math.PI, formula: "=PI()" },
      C1: { value: 1, formula: "=EXP(0)" },
      D1: { value: 0, formula: "=LN(1)" },
      E1: { value: 2, formula: "=LOG(100,10)" },
      F1: { value: 3, formula: "=LOG10(1000)" },
      G1: { value: -12.34, formula: "=TRUNC(-12.345,2)" },
      H1: { value: 9, formula: "=MROUND(10,3)" },
      I1: { value: -3, formula: "=QUOTIENT(-17,5)" },
      J1: { value: 1, formula: "=LOG10+1" },
    });
    expect(applied.diff).toHaveLength(10);
  });

  it("calculates the verified trigonometric and integer math subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [{ id: "sheet-1", name: "Sheet1", cells: {} }],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:J1",
          cells: [
            [
              { formula: "=SIN(0)" },
              { formula: "=COS(0)" },
              { formula: "=TAN(0)" },
              { formula: "=DEGREES(PI())" },
              { formula: "=RADIANS(180)" },
              { formula: "=FACT(5)" },
              { formula: "=GCD(24,18)" },
              { formula: "=LCM(4,6)" },
              { formula: "=COMBIN(5,2)" },
              { formula: "=SUMSQ(3,4)" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: 0, formula: "=SIN(0)" },
      B1: { value: 1, formula: "=COS(0)" },
      C1: { value: 0, formula: "=TAN(0)" },
      D1: { value: 180, formula: "=DEGREES(PI())" },
      E1: { value: Math.PI, formula: "=RADIANS(180)" },
      F1: { value: 120, formula: "=FACT(5)" },
      G1: { value: 6, formula: "=GCD(24,18)" },
      H1: { value: 12, formula: "=LCM(4,6)" },
      I1: { value: 10, formula: "=COMBIN(5,2)" },
      J1: { value: 25, formula: "=SUMSQ(3,4)" },
    });
    expect(applied.diff).toHaveLength(10);
  });

  it("calculates only the verified exact lookup subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A1: { value: "key" },
              B1: { value: 10 },
              A2: { value: "alpha" },
              B2: { value: 20 },
              A3: { value: "beta" },
              B3: { value: 30 },
              D1: { value: "a" },
              E1: { value: "b" },
              F1: { value: "c" },
              D2: { value: 4 },
              E2: { value: 5 },
              F2: { value: 6 },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "H1:K1",
          cells: [
            [
              { value: -999, formula: '=VLOOKUP("beta",A1:B3,2,FALSE)' },
              { formula: '=HLOOKUP("b",D1:F2,2,FALSE)' },
              { formula: '=MATCH("alpha",A1:A3,0)' },
              { formula: "=INDEX(B1:B3,3,1)" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      H1: { value: 30, formula: '=VLOOKUP("beta",A1:B3,2,FALSE)' },
      I1: { value: 5, formula: '=HLOOKUP("b",D1:F2,2,FALSE)' },
      J1: { value: 2, formula: '=MATCH("alpha",A1:A3,0)' },
      K1: { value: 30, formula: "=INDEX(B1:B3,3,1)" },
    });
    expect(applied.diff).toHaveLength(4);
  });

  it("calculates the verified conditional aggregate subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A1: { value: "A" },
              B1: { value: 10 },
              C1: { value: "ok" },
              A2: { value: "A" },
              B2: { value: 20 },
              C2: { value: "hold" },
              A3: { value: "B" },
              B3: { value: 40 },
              C3: { value: "ok" },
              A4: { value: "A" },
              B4: { value: 30 },
              C4: { value: "ok" },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "E1:H1",
          cells: [
            [
              { formula: '=COUNTIFS(A1:A4,"A",C1:C4,"ok")' },
              { formula: '=SUMIFS(B1:B4,A1:A4,"A",C1:C4,"ok")' },
              { formula: '=AVERAGEIF(A1:A4,"A",B1:B4)' },
              {
                value: -999,
                formula: '=AVERAGEIFS(B1:B4,A1:A4,"A",C1:C4,"ok")',
              },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      E1: { value: 2, formula: '=COUNTIFS(A1:A4,"A",C1:C4,"ok")' },
      F1: { value: 40, formula: '=SUMIFS(B1:B4,A1:A4,"A",C1:C4,"ok")' },
      G1: { value: 20, formula: '=AVERAGEIF(A1:A4,"A",B1:B4)' },
      H1: {
        value: 20,
        formula: '=AVERAGEIFS(B1:B4,A1:A4,"A",C1:C4,"ok")',
      },
    });
    expect(applied.diff).toHaveLength(4);
  });

  it("calculates the verified order and type-predicate subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A2: { value: 10 },
              A3: { value: 20 },
              A4: { value: 40 },
              A5: { value: 30 },
              D3: { value: 1 },
              D5: { value: 2 },
              F2: { value: "text" },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:I1",
          cells: [
            [
              { formula: "=COUNTBLANK(D2:D5)" },
              { formula: "=LARGE(A2:A5,2)" },
              { formula: "=SMALL(A2:A5,2)" },
              { formula: "=ISBLANK(D2)" },
              { formula: "=ISNUMBER(A2)" },
              { formula: "=ISTEXT(F2)" },
              { formula: "=ISLOGICAL(1=1)" },
              { formula: "=ISEVEN(4)" },
              { value: false, formula: "=ISODD(5)" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      A1: { value: 2, formula: "=COUNTBLANK(D2:D5)" },
      B1: { value: 30, formula: "=LARGE(A2:A5,2)" },
      C1: { value: 20, formula: "=SMALL(A2:A5,2)" },
      D1: { value: true, formula: "=ISBLANK(D2)" },
      E1: { value: true, formula: "=ISNUMBER(A2)" },
      F1: { value: true, formula: "=ISTEXT(F2)" },
      G1: { value: true, formula: "=ISLOGICAL(1=1)" },
      H1: { value: true, formula: "=ISEVEN(4)" },
      I1: { value: true, formula: "=ISODD(5)" },
    });
    expect(applied.diff).toHaveLength(9);
  });

  it("calculates the verified population and sample variance subset", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A2: { value: 2 },
              A3: { value: 7 },
              A4: { value: "ignored" },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "B1:E1",
          cells: [
            [
              { formula: "=STDEVP(A2:A4)" },
              { formula: "=VARP(A2:A4)" },
              { formula: "=STDEVS(A2:A4)" },
              { value: -1, formula: "=VARS(A2:A4)" },
            ],
          ],
        },
      ],
    );

    expect(applied.workbook.worksheets[0]?.cells).toMatchObject({
      B1: { value: 2.5, formula: "=STDEVP(A2:A4)" },
      C1: { value: 6.25, formula: "=VARP(A2:A4)" },
      D1: { value: Math.sqrt(12.5), formula: "=STDEVS(A2:A4)" },
      E1: { value: 12.5, formula: "=VARS(A2:A4)" },
    });
    expect(applied.diff).toHaveLength(4);
  });

  it("recalculates dependent existing formulas and includes their cache changes in the diff", () => {
    const applied = applySheetOperations(
      {
        id: "book-1",
        title: "Sheet",
        revision: "1",
        fingerprint: "base",
        worksheets: [
          {
            id: "sheet-1",
            name: "Sheet1",
            cells: {
              A1: { value: 2 },
              A2: { value: 7 },
              B1: { value: 9, formula: "=SUM(A1:A2)", kind: "formula" },
            },
          },
        ],
      },
      [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A2:A2",
          cells: [[{ value: 8 }]],
        },
      ],
    );
    expect(applied.workbook.worksheets[0]?.cells.B1?.value).toBe(10);
    expect(applied.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cell: "A2", deletion: false }),
        expect.objectContaining({
          cell: "B1",
          before: expect.objectContaining({ value: 9 }),
          after: expect.objectContaining({ value: 10 }),
          deletion: false,
        }),
      ]),
    );
    expect(applied.diff).toHaveLength(2);
  });

  it("rejects unsupported functions, cycles and oversized formula ranges", () => {
    const workbook = {
      id: "book-1",
      title: "Sheet",
      revision: "1",
      fingerprint: "base",
      worksheets: [{ id: "sheet-1", name: "Sheet1", cells: {} }],
    };
    expect(() =>
      applySheetOperations(workbook, [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:A1",
          cells: [[{ formula: "=NOW()" }]],
        },
      ]),
    ).toThrow("Unsupported Sheet formula function");
    expect(() =>
      applySheetOperations(workbook, [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:B1",
          cells: [[{ formula: "=B1+1" }, { formula: "=A1+1" }]],
        },
      ]),
    ).toThrow("Formula cycle");
    expect(() =>
      applySheetOperations(workbook, [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:A1",
          cells: [[{ formula: "=SUM(A2:A10002)" }]],
        },
      ]),
    ).toThrow("10,000 cell limit");
    expect(() =>
      applySheetOperations(workbook, [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:A1",
          cells: [[{ formula: '=SUMIF(B1:B4,">0",C1:D2)' }]],
        },
      ]),
    ).toThrow("equal dimensions");
    for (const formula of [
      '=COUNTIFS(A1:A2,"x",B1:B3,"y")',
      '=SUMIFS(A1:A2,B1:B3,"x")',
      '=AVERAGEIF(A1:A2,"x",B1:B3)',
      '=AVERAGEIFS(A1:A2,B1:B3,"x")',
      '=COUNTIFS(A1:A2,"*")',
      '=AVERAGEIF(A1:A2,"missing",A1:A2)',
      '=AVERAGEIFS(A1:A2,B1:B2,"missing")',
      "=LARGE(A1:A2,3)",
      "=SMALL(A1:A2,0)",
      "=LARGE(B1:B2,1)",
      "=ISEVEN(1.5)",
      "=ISBLANK(A1:A2)",
      "=STDEVP(A1)",
      "=VARP(B1:B2)",
      "=STDEVS(A1:A1)",
      "=VARS(A1:A1)",
    ]) {
      expect(() =>
        applySheetOperations(workbook, [
          {
            op: "set_range",
            worksheet_id: "sheet-1",
            range: "C1:C1",
            cells: [[{ formula }]],
          },
        ]),
      ).toThrow();
    }
    expect(() =>
      applySheetOperations(workbook, [
        {
          op: "set_range",
          worksheet_id: "sheet-1",
          range: "A1:A1",
          cells: [[{ formula: '=MID("text",0,1)' }]],
        },
      ]),
    ).toThrow("start position must be at least 1");
    expect(() =>
      applySheetOperations(
        {
          ...workbook,
          worksheets: [
            {
              id: "sheet-1",
              name: "Sheet1",
              cells: { B1: { value: "a" }, B2: { value: "b" } },
            },
          ],
        },
        [
          {
            op: "set_range",
            worksheet_id: "sheet-1",
            range: "A1:A1",
            cells: [[{ formula: "=CONCAT(B1:B2)" }]],
          },
        ],
      ),
    ).toThrow("scalar formula value");
    for (const formula of [
      "=MOD(1,0)",
      "=SQRT(-1)",
      "=POWER(0,-1)",
      "=ROUNDUP(1,16)",
      '=PRODUCT("text")',
      '=MEDIAN("text")',
      '=VLOOKUP("x",A1:B2,2,TRUE)',
      '=HLOOKUP("x",A1:B2,3,FALSE)',
      '=MATCH("x",A1:B2,0)',
      '=MATCH("x",A1:A2,1)',
      "=INDEX(A1:B2,3,1)",
      '=FIND("missing","text",1)',
      '=SEARCH("missing","text",1)',
      '=FIND("t","text")',
      '=SUBSTITUTE("text","t","x",1)',
      '=REPLACE("text",0,1,"x")',
      '=REPT("long",2001)',
      '=REPT("123456",2000)',
      `=SUBSTITUTE("${"a".repeat(20)}","a","${"x".repeat(600)}")`,
      '=EXACT("a")',
      "=CEILING(-1,2)",
      "=FLOOR(1,0)",
      "=SUMPRODUCT(A1:A2,B1:B3)",
      "=SUMPRODUCT(A1:A2,B1:B2,C1:C2)",
      "=SUMPRODUCT(C1:C2,D1:D2)",
      '=CHOOSE(0,"a","b")',
      "=CHOOSE(1,A1:A2)",
      "=RANK(1,A1:A2,1)",
      "=SIGN()",
      "=PI(1)",
      "=EXP(1000)",
      "=LN(0)",
      "=LOG(10)",
      "=LOG(10,1)",
      "=LOG10(-1)",
      "=TRUNC(1.2)",
      "=TRUNC(1.2,16)",
      "=MROUND(-1,2)",
      "=MROUND(1,0)",
      "=QUOTIENT(1,0)",
      "=SIN()",
      "=COS(0,1)",
      "=TAN()",
      "=DEGREES()",
      "=RADIANS(1,2)",
      "=FACT(-1)",
      "=FACT(171)",
      "=FACT(1.5)",
      "=GCD(-1,2)",
      "=GCD()",
      "=LCM(1000000000,999999999)",
      "=COMBIN(4,5)",
      "=COMBIN(171,2)",
      "=SUMSQ()",
      "=SUMSQ(A1:A2)",
      '=PROPER("a","b")',
      '=PROPER("中文")',
      "=CHAR(0)",
      "=CHAR(256)",
      "=CHAR(1.5)",
      '=CODE("")',
      '=CODE("你")',
      '=VALUE("1,234.50")',
      '=TEXT(1234.5,"#,##0.00")',
      "=ROWS(A1)",
      "=COLUMNS(A1:B2,1)",
      '=IFS(FALSE,"no")',
      '=IFS(TRUE,"yes",FALSE)',
      '=IFS(A1:A2,"yes")',
      '=SWITCH(3,1,"one",2,"two")',
      '=SWITCH(A1:A2,1,"one","other")',
      '=SWITCH(1,1,A1:A2,"other")',
      "=XOR(TRUE)",
      "=XOR(A1:A2,FALSE)",
    ]) {
      expect(() =>
        applySheetOperations(workbook, [
          {
            op: "set_range",
            worksheet_id: "sheet-1",
            range: "A1:A1",
            cells: [[{ formula }]],
          },
        ]),
      ).toThrow();
    }
  });
});
