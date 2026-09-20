import { describe, expect, it } from "vitest";
import {
  executeTableArchive,
  matchesArchiveValues,
  prepareTableArchive,
  reconcileTableArchive,
} from "../src/table-archive.js";
import { archiveFixture } from "./helpers/archive-fixture.js";

describe("single-record Table archive", () => {
  it("maps all captured field types, preserves exact text and ignores system timestamps", async () => {
    const f = archiveFixture();
    expect(f.plan.fields).toHaveLength(7);
    expect(f.plan.fields.find((v) => v.type === "select")?.value).toBe(
      "target-s1",
    );
    expect(f.plan.fields.find((v) => v.type === "multiSelect")?.value).toEqual([
      "target-s3",
      "target-s2",
    ]);
    const beforeSource = structuredClone(f.source.records[1]),
      beforeTarget = structuredClone(f.target.records[0]);
    await expect(
      executeTableArchive(f.plan, f.io, f.checkpoint),
    ).resolves.toMatchObject({
      state: "succeeded",
      source_count: 1,
      target_count: 2,
    });
    expect(f.writes).toEqual(["create", "populate", "remove"]);
    expect(f.phases).toEqual([
      "creating_target",
      "writing_target",
      "target_verified",
      "removing_source",
      "completed",
    ]);
    expect(f.source.records).toEqual([beforeSource]);
    expect(f.target.records[0]).toEqual(beforeTarget);
    const copy = f.target.records[1]!;
    expect(copy.data["target-text"]).toEqual(f.plan.sourceRecord.data.text);
    expect(copy.data).not.toHaveProperty("createdAt");
    copy.data["target-owner"] = {
      value: [{ id: "7", name: "New display name" }],
    };
    copy.data["target-date"] = {
      value: {
        time: "2026-09-30T00:00:00+08:00",
        text: "Different presentation",
      },
    };
    copy.data["target-progress"] = { value: 100 };
    copy.data["target-multi"] = { value: ["target-s2", "target-s3"] };
    expect(matchesArchiveValues(f.plan, copy)).toBe(true);
    await expect(reconcileTableArchive(f.plan, f.io)).resolves.toMatchObject({
      observed_complete: true,
      automatic_retry_allowed: false,
    });
    expect(f.writes).toHaveLength(3);
  });

  it.each([
    "unknown-field",
    "unsupported",
    "metadata",
    "missing-field",
    "ambiguous-field",
    "wrong-type",
    "missing-option",
    "ambiguous-option",
    "different-book",
    "same-table",
    "duplicate-rows",
    "empty",
    "bad-date",
    "bad-mention",
    "bad-progress",
  ])("rejects lossy or invalid plans: %s", (mode) => {
    const f = archiveFixture(),
      row = f.source.records[0]!;
    switch (mode) {
      case "unknown-field":
        row.data.unknown = { value: "value" };
        break;
      case "unsupported":
        row.data.formula = { value: 3 };
        break;
      case "metadata":
        row.data.text = { value: "value", link: "extra" };
        break;
      case "missing-field":
        f.target.columns = f.target.columns.filter((c) => c.type !== "text");
        break;
      case "ambiguous-field":
        f.target.columns.push({ ...f.target.columns[0]!, id: "second-text" });
        break;
      case "wrong-type":
        f.target.columns[0]!.type = "input";
        break;
      case "missing-option":
        f.target.columns[2]!.options = [];
        break;
      case "ambiguous-option":
        f.target.columns[2]!.options!.push({ id: "second", value: "Done" });
        break;
      case "different-book":
        f.target.bookUrl += "-other";
        break;
      case "same-table":
        f.target.id = f.source.id;
        break;
      case "duplicate-rows":
        f.source.records.push(row);
        break;
      case "empty":
        row.data = {};
        break;
      case "bad-date":
        row.data.date = { value: { time: "invalid" } };
        break;
      case "bad-mention":
        row.data.owner = { value: [{ name: "Alice" }] };
        break;
      case "bad-progress":
        row.data.progress = { value: 101 };
        break;
    }
    expect(() =>
      prepareTableArchive(f.source, f.target, "source-row"),
    ).toThrow();
  });

  it("rejects equivalent copies and oversized records", async () => {
    const f = archiveFixture();
    await f.io.create(f.plan.target, f.plan.targetRecordId);
    await f.io.populate(f.plan);
    expect(() => prepareTableArchive(f.source, f.target, "source-row")).toThrow(
      /equivalent/,
    );
    f.source.records[0]!.data.text = { value: "x".repeat(1024 * 1024) };
    expect(() => prepareTableArchive(f.source, f.target, "source-row")).toThrow(
      /1 MiB/,
    );
  });

  it.each(["source-edit", "target-edit", "source-body", "policy"])(
    "makes no write when preflight changed: %s",
    async (mode) => {
      const f = archiveFixture();
      if (mode === "source-edit")
        f.source.records[0]!.data.text = { value: "concurrent" };
      if (mode === "target-edit")
        f.target.records[0]!.data["target-text"] = { value: "concurrent" };
      if (mode === "source-body")
        f.io.content = async () => ({ text: "description" });
      if (mode === "policy")
        f.io.assertWritable = () => {
          throw new Error("blocked");
        };
      await expect(
        executeTableArchive(f.plan, f.io, f.checkpoint),
      ).rejects.toMatchObject({ state: "conflict" });
      expect(f.writes).toEqual([]);
    },
  );

  it.each([
    "text-truncated",
    "source-edit",
    "target-other-edit",
    "target-body",
    "checkpoint",
    "policy-after-copy",
  ])("preserves source when copy cannot be verified: %s", async (mode) => {
    const f = archiveFixture(),
      populate = f.io.populate;
    f.io.populate = async (plan) => {
      await populate(plan);
      if (mode === "text-truncated")
        f.target.records[1]!.data["target-text"] = { value: "truncated" };
      if (mode === "source-edit")
        f.source.records[0]!.data.text = { value: "concurrent" };
      if (mode === "target-other-edit")
        f.target.records[0]!.data["target-text"] = { value: "concurrent" };
      if (mode === "target-body")
        f.io.content = async (t) => (t.id === f.target.id ? "body" : null);
      if (mode === "policy-after-copy")
        f.io.assertWritable = () => {
          throw new Error("disabled");
        };
    };
    const checkpoint = () => {
      if (mode === "checkpoint" && f.plan.phase === "target_verified")
        throw new Error("disk full");
    };
    await expect(
      executeTableArchive(f.plan, f.io, checkpoint),
    ).rejects.toMatchObject({ state: "partial" });
    expect(f.writes).toEqual(["create", "populate"]);
    expect(f.source.records.some((r) => r.uuid === "source-row")).toBe(true);
  });

  it.each(["create", "populate", "remove"] as const)(
    "does not retry an ambiguous %s response",
    async (operation) => {
      const f = archiveFixture();
      if (operation === "populate") {
        const run = f.io.populate;
        f.io.populate = async (p) => {
          await run(p);
          throw new Error("timeout");
        };
      } else {
        const run = f.io[operation];
        f.io[operation] = async (t, id) => {
          await run(t, id);
          throw new Error("timeout");
        };
      }
      await expect(
        executeTableArchive(f.plan, f.io, f.checkpoint),
      ).rejects.toMatchObject({ state: "unknown" });
      expect(f.writes.filter((v) => v === operation)).toHaveLength(1);
      await expect(reconcileTableArchive(f.plan, f.io)).resolves.toMatchObject({
        observed_complete: operation === "remove",
        automatic_retry_allowed: false,
      });
    },
  );
});
