import { describe, expect, it } from "vitest";
import {
  lakeTargetFingerprint,
  planLakePatch,
  proprietaryBlockTypes,
  scanTopLevelBlocks,
} from "../src/lake-document.js";

describe("native Lake document patching", () => {
  it("appends without reserializing or changing any existing byte", () => {
    const original =
      '<!doctype lake><meta name="lake"/><!--keep exact--><h2 data-lake-id="a" data-extra="keep">标题</h2><p data-lake-id="b">原文&nbsp;保留</p>';
    const fragment = '<meta name="lake"/><p data-lake-id="new">追加内容</p>';
    const plan = planLakePatch({
      currentLake: original,
      convertedFragment: fragment,
      mode: "append",
    });

    expect(plan.lakeContent).toBe(
      `${original}<p data-lake-id="new">追加内容</p>`,
    );
    expect(plan.lakeContent.slice(0, original.length)).toBe(original);
  });

  it("replaces only the uniquely named section body", () => {
    const before =
      '<h2 data-lake-id="a">目标</h2><p data-lake-id="old">旧内容</p><h2 data-lake-id="b">其他</h2><p data-byte="exact">不要改变</p>';
    const untouched =
      '<h2 data-lake-id="b">其他</h2><p data-byte="exact">不要改变</p>';
    const plan = planLakePatch({
      currentLake: before,
      convertedFragment: '<meta name="lake"/><p data-lake-id="new">新内容</p>',
      mode: "replace_section",
      sectionHeading: "目标",
    });

    expect(plan.lakeContent).toBe(
      `<h2 data-lake-id="a">目标</h2><p data-lake-id="new">新内容</p>${untouched}`,
    );
    expect(plan.lakeContent.endsWith(untouched)).toBe(true);
  });

  it("deletes one plain named section while preserving every other byte", () => {
    const before =
      '<!doctype lake><meta name="lake"/><h2 data-lake-id="a">删除我</h2><p data-lake-id="old">旧内容</p><h2 data-lake-id="b">保留</h2><p data-byte="exact">不要改变</p>';
    const preserved =
      '<!doctype lake><meta name="lake"/><h2 data-lake-id="b">保留</h2><p data-byte="exact">不要改变</p>';
    const plan = planLakePatch({
      currentLake: before,
      convertedFragment: "",
      mode: "delete_section",
      sectionHeading: "删除我",
    });

    expect(plan.lakeContent).toBe(preserved);
    expect(plan.beforeText).toBe("删除我\n旧内容");
    expect(plan.afterText).toBe("");
  });

  it("refuses to empty a document or hide proprietary section deletion", () => {
    expect(() =>
      planLakePatch({
        currentLake: "<h2>唯一章节</h2><p>内容</p>",
        convertedFragment: "",
        mode: "delete_section",
        sectionHeading: "唯一章节",
      }),
    ).toThrow("empty the entire document");
    expect(() =>
      planLakePatch({
        currentLake:
          '<h2>目标</h2><div data-card-type="file">附件</div><h2>保留</h2><p>内容</p>',
        convertedFragment: "",
        mode: "delete_section",
        sectionHeading: "目标",
      }),
    ).toThrow("unsupported Lake blocks");
  });

  it("rejects missing or duplicate section headings", () => {
    const duplicate = "<h2>重复</h2><p>一</p><h2>重复</h2><p>二</p>";
    expect(() =>
      planLakePatch({
        currentLake: duplicate,
        convertedFragment: "<p>新</p>",
        mode: "replace_section",
        sectionHeading: "重复",
      }),
    ).toThrow("ambiguous");
    expect(() =>
      planLakePatch({
        currentLake: "<h2>存在</h2><p>一</p>",
        convertedFragment: "<p>新</p>",
        mode: "replace_section",
        sectionHeading: "不存在",
      }),
    ).toThrow("not found");
  });

  it("blocks proprietary or unknown blocks inside a replacement target", () => {
    for (const unsafeBody of [
      '<p>文字</p><img src="secret"/>',
      '<div data-card-type="file">附件</div>',
      "<custom-lake-block>未知</custom-lake-block>",
    ]) {
      expect(() =>
        planLakePatch({
          currentLake: `<h2>目标</h2>${unsafeBody}<h2>其他</h2><p>保留</p>`,
          convertedFragment: "<p>新</p>",
          mode: "replace_section",
          sectionHeading: "目标",
        }),
      ).toThrow("unsupported Lake blocks");
    }
  });

  it("recognizes Yuque's real embedded Board card serialization", () => {
    const board = '<card name="board" value="redacted-board-payload"></card>';
    expect(proprietaryBlockTypes(board)).toEqual(["board"]);
    expect(() =>
      planLakePatch({
        currentLake: `<h2>目标</h2>${board}<h2>其他</h2><p>保留</p>`,
        convertedFragment: "<p>新</p>",
        mode: "replace_section",
        sectionHeading: "目标",
      }),
    ).toThrow("unsupported Lake blocks");
  });

  it("fails closed for unrecognized card names", () => {
    expect(
      proprietaryBlockTypes('<card name="future-card" value="redacted"/>'),
    ).toEqual(["unknown_card"]);
  });

  it("rejects a replacement fragment that escapes the target section", () => {
    expect(() =>
      planLakePatch({
        currentLake: "<h2>目标</h2><p>旧</p><h2>其他</h2><p>保留</p>",
        convertedFragment: "<p>新</p><h2>越界标题</h2>",
        mode: "replace_section",
        sectionHeading: "目标",
      }),
    ).toThrow("at or above");
  });

  it("keeps the target fingerprint stable for non-target edits", () => {
    const before = "<h2>目标</h2><p>旧</p><h2>其他</h2><p>原值</p>";
    const colleagueEdit = "<h2>目标</h2><p>旧</p><h2>其他</h2><p>同事修改</p>";
    expect(
      lakeTargetFingerprint({
        currentLake: colleagueEdit,
        mode: "replace_section",
        sectionHeading: "目标",
      }),
    ).toBe(
      lakeTargetFingerprint({
        currentLake: before,
        mode: "replace_section",
        sectionHeading: "目标",
      }),
    );
  });

  it("fails closed for malformed Lake instead of guessing structure", () => {
    expect(() => scanTopLevelBlocks("<p><strong>broken</p>")).toThrow(
      "mismatched",
    );
    expect(() => scanTopLevelBlocks("plain text<p>body</p>")).toThrow(
      "top-level text",
    );
  });
});
