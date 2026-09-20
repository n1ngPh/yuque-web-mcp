import type { TableColumn } from "../../src/table-model.js";
import {
  prepareTableArchive,
  type TableArchiveIO,
  type TableArchiveSnapshot,
} from "../../src/table-archive.js";

// Entirely synthetic; never load browser captures or real account data in tests.
export function archiveFixture() {
  const columns: TableColumn[] = [
    { id: "text", name: "Task", type: "text" },
    { id: "input", name: "Notes", type: "input" },
    {
      id: "select",
      name: "Status",
      type: "select",
      options: [{ id: "s1", value: "Done" }],
    },
    {
      id: "multi",
      name: "Tags",
      type: "multiSelect",
      options: [
        { id: "s2", value: "Alpha" },
        { id: "s3", value: "Beta" },
      ],
    },
    { id: "owner", name: "Owner", type: "mention" },
    { id: "date", name: "Date", type: "date" },
    { id: "progress", name: "Progress", type: "progress" },
    { id: "formula", name: "Empty formula", type: "formula" },
  ];
  const source: TableArchiveSnapshot = {
    url: "https://example-team.yuque.com/team/book/source",
    displayPath: "Team / Book / Source",
    id: "12",
    bookUrl: "https://example-team.yuque.com/team/book",
    sheetId: "sheet-a",
    view: { id: "grid", type: "GRID" },
    columns,
    records: [
      {
        uuid: "source-row",
        data: {
          text: { value: "Exact text\n" + "long text ".repeat(200) },
          input: { value: "  preserve spaces  " },
          select: { value: "s1" },
          multi: { value: ["s3", "s2"] },
          owner: { value: [{ id: 7, name: "Alice" }] },
          date: {
            value: {
              time: "2026-09-29T16:00:00Z",
              text: "2026-09-30",
              seconds: 1790697600,
            },
          },
          progress: { value: "100.000000000" },
          formula: { value: null },
          createdAt: "system-original",
        },
      },
      { uuid: "keep-source", data: { text: { value: "Other source record" } } },
    ],
  };
  const target: TableArchiveSnapshot = {
    ...structuredClone(source),
    url: "https://example-team.yuque.com/team/book/target",
    displayPath: "Team / Book / Target",
    id: "13",
    columns: columns.map((c) => ({
      ...c,
      id: `target-${c.id}`,
      ...(c.options
        ? { options: c.options.map((o) => ({ ...o, id: `target-${o.id}` })) }
        : {}),
    })),
    records: [
      {
        uuid: "keep-target",
        data: { "target-text": { value: "Other archive record" } },
      },
    ],
  };
  const plan = prepareTableArchive(source, target, "source-row");
  const writes: string[] = [];
  const phases: string[] = [];
  const io: TableArchiveIO = {
    assertWritable: () => {},
    read: async (t) => structuredClone(t.id === source.id ? source : target),
    content: async () => null,
    create: async (_t, id) => {
      writes.push("create");
      target.records.push({ uuid: id, data: {} });
    },
    populate: async (p) => {
      writes.push("populate");
      target.records.find((r) => r.uuid === p.targetRecordId)!.data =
        Object.fromEntries(
          p.fields.map((f) => [
            f.targetId,
            { value: structuredClone(f.value) },
          ]),
        );
    },
    remove: async (_t, id) => {
      writes.push("remove");
      source.records = source.records.filter((r) => r.uuid !== id);
    },
  };
  return {
    source,
    target,
    plan,
    io,
    writes,
    phases,
    checkpoint: () => {
      phases.push(plan.phase);
    },
  };
}
