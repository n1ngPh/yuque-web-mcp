import { describe, expect, it } from "vitest";
import {
  boundedTableOutput,
  prepareTableQuery,
  tableDistributions,
} from "../src/table-query.js";
import type { TableColumn } from "../src/table-model.js";
const columns: TableColumn[] = [
  { id: "owner", name: "负责人", type: "mention" },
  { id: "status", name: "状态", type: "select" },
  { id: "progress", name: "进度", type: "progress" },
  { id: "tags", name: "标签", type: "multiSelect" },
  { id: "text", name: "内容", type: "text" },
];
const row = {
  id: "r1",
  cells: [
    {
      column_id: "owner",
      value: [
        { id: 7, name: "同名" },
        { id: 8, name: "同名" },
      ],
      display_value: ["同名", "同名"],
    },
    { column_id: "status", value: "done", display_value: "已完成" },
    { column_id: "progress", value: "100.0", display_value: "100%" },
    { column_id: "tags", value: ["a", "b"], display_value: ["甲", "乙"] },
    { column_id: "text", value: null, display_value: null },
  ],
};
describe("Table query semantics", () => {
  it("ANDs filters, matches people/options by ID and arrays by membership", () => {
    expect(
      prepareTableQuery(columns, {
        filter: {
          负责人: { id: "7" },
          状态: "已完成",
          进度: 100,
          标签: "乙",
          内容: null,
        },
      }).matches(row),
    ).toBe(true);
    expect(
      prepareTableQuery(columns, { filter: { owner: { id: "9" } } }).matches(
        row,
      ),
    ).toBe(false);
    expect(
      prepareTableQuery(columns, {
        filter: { status: { id: "done" }, progress: "100%" },
      }).matches(row),
    ).toBe(true);
    expect(
      prepareTableQuery(columns, { filter: { status: "done" } }).matches(row),
    ).toBe(false);
    expect(
      prepareTableQuery(columns, { filter: { progress: 0 } }).matches({
        ...row,
        cells: row.cells.map((c) =>
          c.column_id === "progress" ? { ...c, value: null } : c,
        ),
      }),
    ).toBe(false);
  });
  it("rejects unknown/ambiguous fields, duplicate projection and malformed inputs", () => {
    for (const input of [
      { filter: [] },
      { filter: { missing: 1 } },
      { filter: { owner: { id: 7 } } },
      { filter: { text: { id: "x" } } },
      { filter: { text: [] } },
      { raw: "false" },
      { columns: [] },
      { columns: ["text", "内容"] },
      { groupBy: [] },
    ])
      expect(() => prepareTableQuery(columns, input)).toThrow();
    expect(() =>
      prepareTableQuery(
        [...columns, { id: "other", name: "内容", type: "text" }],
        { columns: ["内容"] },
      ),
    ).toThrow(/ambiguous/);
    expect(
      prepareTableQuery(columns, { columns: ["状态", "text"] }).selected.map(
        (c) => c.id,
      ),
    ).toEqual(["status", "text"]);
  });
  it("keeps same-name people separate and counts each member once per row", () => {
    const result = tableDistributions([row], columns.slice(0, 4));
    expect(result[0]!.buckets).toEqual([
      { value: "7", label: "同名", count: 1 },
      { value: "8", label: "同名", count: 1 },
    ]);
    expect(result[2]!.buckets[0]!.value).toBe(100);
    expect(result[3]!.buckets).toHaveLength(2);
  });
  it("reports omitted high-cardinality groups", () => {
    const rows = Array.from({ length: 110 }, (_, i) => ({
      id: String(i),
      cells: [
        { column_id: "text", value: String(i), display_value: String(i) },
      ],
    }));
    const dist = tableDistributions(rows, [columns[4]!])[0]!;
    expect(dist).toMatchObject({
      distinct_count: 110,
      truncated: true,
      omitted_memberships: 10,
    });
    expect(dist.buckets).toHaveLength(100);
  });
  it("bounds UTF-8 output and advances by returned rows without silently cutting a cell", () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      value: "中".repeat(1000),
    }));
    const result = boundedTableOutput(
      { records, complete: true, has_more: false },
      records,
      10,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      40960,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        }),
      ),
    ).toBeLessThanOrEqual(40960);
    expect(result).toMatchObject({
      has_more: true,
      complete: false,
      output_limited: true,
      next_offset: 10 + records.length,
    });
    expect(() =>
      boundedTableOutput({ records: ["x".repeat(50000)] }, ["x".repeat(50000)]),
    ).toThrow(/40 KiB/);
  });
});
