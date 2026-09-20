import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const SYSTEM = new Set(["createdAt", "updatedAt", "userId", "modifierId"]);
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const recordData = (row) =>
  typeof row.data === "string" ? JSON.parse(row.data) : row.data;
const businessData = (row) =>
  Object.fromEntries(
    Object.entries(recordData(row)).filter(([key]) => !SYSTEM.has(key)),
  );

export function assertRowsUnchanged(before, after, ignored = []) {
  const excluded = new Set(ignored);
  const normalize = (rows) =>
    rows
      .filter((r) => !excluded.has(r.uuid))
      .map((r) => ({ ...r, data: recordData(r) }))
      .sort((a, b) => a.uuid.localeCompare(b.uuid));
  assert.deepEqual(
    normalize(after),
    normalize(before),
    "Existing records changed; stop and reconcile",
  );
}

export function prepareArchive(plan, source, target, account) {
  assert.equal(
    account.id.toString(),
    plan.accountId,
    "Session account mismatch",
  );
  assert.equal(source.url, plan.sourceUrl);
  assert.equal(target.url, plan.targetUrl);
  assert.equal(new URL(source.url).origin, new URL(target.url).origin);
  assert.notEqual(source.id, target.id);
  assert.equal(source.bookId, target.bookId);
  const row = source.records.find((r) => r.uuid === plan.sourceRecordId);
  assert(row, "Source record missing");
  assert.equal(
    String(row.user_id),
    plan.accountId,
    "Only own records supported",
  );
  assert.equal(
    String(row.modifier_id),
    plan.accountId,
    "Source modified by another user",
  );
  assert(
    !target.records.some((r) => r.uuid === plan.targetRecordId),
    "Archive record already exists",
  );
  const data = businessData(row);
  const values = [];
  for (const [id, cell] of Object.entries(data)) {
    if (cell.value == null) continue;
    assert.deepEqual(
      Object.keys(cell),
      ["value"],
      "Cell has unsupported metadata",
    );
    const column = source.columns.find((c) => c.id === id);
    const mapped = target.columns.find((c) => c.id === id);
    assert(column && mapped, "Field mapping missing");
    assert.equal(mapped.name, column.name);
    assert.equal(mapped.type, column.type);
    assert(
      ["text", "input", "mention"].includes(column.type),
      "This test harness only supports text/input/mention cells",
    );
    if (column.type === "mention") {
      assert(Array.isArray(cell.value) && cell.value.length === 1);
      assert.equal(
        String(cell.value[0].id),
        plan.accountId,
        "Only current user assignment supported",
      );
    } else assert.equal(typeof cell.value, "string");
    values.push({
      fieldId: id,
      data: { value: cell.value },
      recordId: plan.targetRecordId,
    });
  }
  assert.equal(
    values.length,
    2,
    "Only the two approved test fields may be populated",
  );
  const textColumn = source.columns.find(
    (c) => c.name === (plan.textFieldName ?? "具体工作内容"),
  );
  const ownerColumn = source.columns.find(
    (c) => c.name === (plan.ownerFieldName ?? "负责人"),
  );
  assert.equal(
    source.columns.filter(
      (c) => c.name === (plan.textFieldName ?? "具体工作内容"),
    ).length,
    1,
  );
  assert.equal(
    source.columns.filter((c) => c.name === (plan.ownerFieldName ?? "负责人"))
      .length,
    1,
  );
  assert(
    textColumn && ownerColumn && textColumn.id !== ownerColumn.id,
    "Expected fields missing or ambiguous",
  );
  assert(["text", "input"].includes(textColumn.type));
  assert.equal(ownerColumn.type, "mention");
  assert.equal(data[textColumn.id]?.value, plan.expectedText);
  assert.equal(String(data[ownerColumn?.id]?.value?.[0]?.id), plan.accountId);
  assert(
    !target.records.some(
      (r) => businessData(r)[textColumn.id]?.value === plan.expectedText,
    ),
    "Matching archive content already exists",
  );
  return { values, sourceRow: row, source, target };
}

export function assertCopied(plan, baseline, current) {
  assertRowsUnchanged(baseline.target.records, current.records, [
    plan.targetRecordId,
  ]);
  const row = current.records.find((r) => r.uuid === plan.targetRecordId);
  assert(row, "Archived record missing");
  assert.equal(String(row.user_id), plan.accountId);
  assert.equal(
    String(row.modifier_id),
    plan.accountId,
    "Archive modified by another user",
  );
  const data = businessData(row);
  assert.equal(
    Object.values(data).filter((c) => c.value != null).length,
    baseline.values.length,
    "Unexpected archived fields",
  );
  for (const value of baseline.values) {
    const col = current.columns.find((c) => c.id === value.fieldId);
    const expected = value.data.value;
    const actual = data[value.fieldId]?.value;
    if (col.type === "mention")
      assert.deepEqual(
        actual?.map((u) => String(u.id)),
        expected.map((u) => String(u.id)),
      );
    else assert.deepEqual(actual, expected);
  }
  return row;
}

export class ArchiveMove {
  constructor(plan, io) {
    this.plan = plan;
    this.io = io;
  }
  async preview() {
    const old = await this.io.load();
    if (old)
      throw Error(
        "A durable operation already exists; inspect status, do not duplicate",
      );
    const source = await this.io.read("source"),
      target = await this.io.read("target");
    const prepared = prepareArchive(
      this.plan,
      source,
      target,
      await this.io.account(),
    );
    assert.equal(
      await this.io.content("source", this.plan.sourceRecordId),
      null,
      "Nonempty record body is not supported",
    );
    const preview = {
      source_url: source.url,
      target_url: target.url,
      source_record_id: this.plan.sourceRecordId,
      target_record_id: this.plan.targetRecordId,
      content: this.plan.expectedText,
      assignee: this.plan.accountName,
      source_count: source.records.length,
      target_count: target.records.length,
      method:
        "copy verified business fields, verify target, then remove exactly the source record",
      system_fields: "Target gets a new ID and new creation/update timestamps",
      expires_at: new Date(Date.now() + 600000).toISOString(),
    };
    const state = {
      state: "previewed",
      planDigest: digest(this.plan),
      preview,
      diff_digest: digest(preview),
      prepared,
    };
    await this.io.save(state);
    return { ...preview, diff_digest: state.diff_digest };
  }
  async state(expected, diff) {
    const state = await this.io.load();
    assert(state, "Preview required");
    assert.equal(state.planDigest, digest(this.plan));
    assert.equal(
      state.state,
      expected,
      "Operation cannot be repeated; inspect saved state",
    );
    assert.equal(state.diff_digest, diff, "Preview digest mismatch");
    assert(
      Date.now() < Date.parse(state.preview.expires_at),
      "Preview expired",
    );
    return state;
  }
  async checkBaseline(state) {
    assert.equal(String((await this.io.account()).id), this.plan.accountId);
    const source = await this.io.read("source"),
      target = await this.io.read("target");
    assertRowsUnchanged(state.prepared.source.records, source.records);
    assert.deepEqual(source.columns, state.prepared.source.columns);
    assert.deepEqual(target.columns, state.prepared.target.columns);
    assert.equal(
      await this.io.content("source", this.plan.sourceRecordId),
      null,
    );
    return { source, target };
  }
  async stage(diff) {
    await this.io.assertWriteEnabled?.();
    const state = await this.state("previewed", diff);
    const current = await this.checkBaseline(state);
    assertRowsUnchanged(state.prepared.target.records, current.target.records);
    // Persist before each non-idempotent write. A timeout never triggers a replay.
    state.state = "creating_target";
    await this.io.save(state);
    await this.io.create(current.target, this.plan.targetRecordId);
    const created = await this.io.read("target");
    assertRowsUnchanged(state.prepared.target.records, created.records, [
      this.plan.targetRecordId,
    ]);
    assert(
      created.records.some((r) => r.uuid === this.plan.targetRecordId),
      "Creation read-back failed",
    );
    state.state = "populating_target";
    await this.io.save(state);
    await this.io.populate(current.target, state.prepared.values);
    const verified = await this.io.read("target");
    assertCopied(this.plan, state.prepared, verified);
    assert.equal(
      await this.io.content("target", this.plan.targetRecordId),
      null,
    );
    state.state = "staged";
    state.targetAfterCopy = verified;
    await this.io.save(state);
    return {
      state: state.state,
      target_record_id: this.plan.targetRecordId,
      target_count: verified.records.length,
      source_record_retained: true,
    };
  }
  async finalize(diff) {
    await this.io.assertWriteEnabled?.();
    const state = await this.state("staged", diff);
    const current = await this.checkBaseline(state);
    assertCopied(this.plan, state.prepared, current.target);
    assert.equal(
      await this.io.content("target", this.plan.targetRecordId),
      null,
    );
    state.state = "removing_source";
    await this.io.save(state);
    await this.io.remove(current.source, this.plan.sourceRecordId);
    const source = await this.io.read("source"),
      target = await this.io.read("target");
    assert(
      !source.records.some((r) => r.uuid === this.plan.sourceRecordId),
      "Source removal not verified",
    );
    assertRowsUnchanged(state.prepared.source.records, source.records, [
      this.plan.sourceRecordId,
    ]);
    assertCopied(this.plan, state.prepared, target);
    state.state = "succeeded";
    state.result = {
      state: "succeeded",
      source_url: source.url,
      target_url: target.url,
      source_record_id: this.plan.sourceRecordId,
      target_record_id: this.plan.targetRecordId,
      source_before: state.prepared.source.records.length,
      source_after: source.records.length,
      target_before: state.prepared.target.records.length,
      target_after: target.records.length,
      unchanged_source_records: source.records.length,
      unchanged_target_records: state.prepared.target.records.length,
      content: this.plan.expectedText,
      assignee: this.plan.accountName,
      completed_at: new Date().toISOString(),
    };
    await this.io.save(state);
    return state.result;
  }
}
