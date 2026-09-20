import test from "node:test";
import assert from "node:assert/strict";
import { ArchiveMove } from "./table-archive-core.mjs";
function setup() {
  const columns = [
    { id: "text", name: "具体工作内容", type: "text" },
    { id: "owner", name: "负责人", type: "mention" },
  ];
  const plan = {
    accountId: "1",
    accountName: "Test",
    sourceUrl: "https://example.yuque.com/a/b/source",
    targetUrl: "https://example.yuque.com/a/b/archive",
    sourceRecordId: "source-test",
    targetRecordId: "new-target",
    expectedText: "Local test",
  };
  const row = (uuid, body, user = 1) => ({
    uuid,
    user_id: user,
    modifier_id: user,
    data: JSON.stringify({
      ...body,
      createdAt: "old",
      updatedAt: "old",
      userId: user,
      modifierId: user,
    }),
  });
  const source = {
    url: plan.sourceUrl,
    id: 1,
    bookId: 4,
    columns,
    records: [
      row("source-test", {
        text: { value: plan.expectedText },
        owner: { value: [{ id: 1, name: "Test" }] },
      }),
      row("other-source", { text: { value: "Other" } }, 2),
    ],
  };
  const target = {
    url: plan.targetUrl,
    id: 2,
    bookId: 4,
    columns,
    records: [row("other-target", { text: { value: "Archived other" } }, 2)],
  };
  let state;
  const writes = [];
  const io = {
    account: async () => ({ id: 1 }),
    read: async (side) => structuredClone(side === "source" ? source : target),
    content: async () => null,
    load: async () => structuredClone(state),
    save: async (s) => {
      state = structuredClone(s);
    },
    create: async (t, id) => {
      writes.push("create");
      target.records.push(row(id, {}));
    },
    populate: async (t, values) => {
      writes.push("populate");
      target.records.find((r) => r.uuid === plan.targetRecordId).data =
        JSON.stringify(
          Object.fromEntries(values.map((v) => [v.fieldId, v.data])),
        );
    },
    remove: async (t, id) => {
      writes.push("remove");
      source.records = source.records.filter((r) => r.uuid !== id);
    },
  };
  return { plan, source, target, io, writes, move: new ArchiveMove(plan, io) };
}
test("moves exactly one record after verified copy, preserving all other rows", async () => {
  const f = setup();
  const p = await f.move.preview();
  assert.deepEqual(f.writes, []);
  await f.move.stage(p.diff_digest);
  assert.equal(f.source.records.length, 2);
  const result = await f.move.finalize(p.diff_digest);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(f.writes, ["create", "populate", "remove"]);
  assert.equal(result.source_after, 1);
  assert.equal(result.target_after, 2);
  await assert.rejects(f.move.stage(p.diff_digest));
  await assert.rejects(f.move.finalize(p.diff_digest));
  assert.equal(f.writes.length, 3);
});
test("rejects wrong digest without writes", async () => {
  const f = setup();
  await f.move.preview();
  await assert.rejects(f.move.stage("wrong"));
  assert.deepEqual(f.writes, []);
});
test("rejects source edits between preview and stage", async () => {
  const f = setup();
  const p = await f.move.preview();
  f.source.records[0].modifier_id = 2;
  await assert.rejects(f.move.stage(p.diff_digest));
  assert.deepEqual(f.writes, []);
});
test("rejects source edits after copying without deleting source", async () => {
  const f = setup();
  const p = await f.move.preview();
  await f.move.stage(p.diff_digest);
  f.source.records[0].data = "{}";
  await assert.rejects(f.move.finalize(p.diff_digest));
  assert(!f.writes.includes("remove"));
});
test("rejects corrupted archive read-back without deleting source", async () => {
  const f = setup();
  const p = await f.move.preview();
  f.io.populate = async () => {};
  await assert.rejects(f.move.stage(p.diff_digest));
  await assert.rejects(f.move.finalize(p.diff_digest));
  assert.deepEqual(f.writes, ["create"]);
});
test("uncertain creation is journaled and cannot be retried", async () => {
  const f = setup();
  const p = await f.move.preview();
  f.io.create = async () => {
    f.writes.push("create");
    throw Error("timeout");
  };
  await assert.rejects(f.move.stage(p.diff_digest));
  assert.equal((await f.io.load()).state, "creating_target");
  await assert.rejects(f.move.stage(p.diff_digest));
  assert.deepEqual(f.writes, ["create"]);
});
test("blocks other user records, incompatible columns, body loss, and duplicates", async () => {
  for (const alter of [
    (f) => (f.io.account = async () => ({ id: 2 })),
    (f) => (f.source.records[0].user_id = 2),
    (f) => (f.target.columns = [{ id: "text", name: "wrong", type: "text" }]),
    (f) => (f.io.content = async () => "<p>body</p>"),
    (f) => f.target.records.push(structuredClone(f.source.records[0])),
  ]) {
    const f = setup();
    alter(f);
    await assert.rejects(f.move.preview());
    assert.deepEqual(f.writes, []);
  }
});
test("does not delete source if any existing archive row changed", async () => {
  const f = setup();
  const p = await f.move.preview();
  await f.move.stage(p.diff_digest);
  f.target.records[0].data = "{}";
  await assert.rejects(f.move.finalize(p.diff_digest));
  assert(!f.writes.includes("remove"));
});
