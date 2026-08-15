import { fingerprint } from "./crypto.js";

export type LakePatchMode = "append" | "replace_section" | "delete_section";

export interface LakePatchPlan {
  lakeContent: string;
  baseTargetFingerprint: string;
  proposedTargetFingerprint: string;
  beforeText: string;
  afterText: string;
  warnings: string[];
}

interface LakeBlock {
  tag: string;
  start: number;
  end: number;
  raw: string;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const SAFE_TOP_LEVEL_TAGS = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
]);

export function planLakePatch(input: {
  currentLake: string;
  convertedFragment: string;
  mode: LakePatchMode;
  sectionHeading?: string;
}): LakePatchPlan {
  const blocks = scanTopLevelBlocks(input.currentLake);

  if (input.mode === "append") {
    const fragment = normalizedFragment(input.convertedFragment);
    if (!fragment) throw new Error("Converted Lake fragment is empty");
    const last = blocks.at(-1);
    const anchor = last?.raw ?? "";
    const insertion = last?.end ?? input.currentLake.length;
    const next = `${input.currentLake.slice(0, insertion)}${fragment}${input.currentLake.slice(insertion)}`;
    return {
      lakeContent: next,
      baseTargetFingerprint: fingerprint({ mode: "append", anchor }),
      proposedTargetFingerprint: fingerprint({
        mode: "append",
        anchor,
        fragment,
      }),
      beforeText: lakeText(anchor),
      afterText: [lakeText(anchor), lakeText(fragment)]
        .filter(Boolean)
        .join("\n"),
      warnings: [],
    };
  }

  const heading = input.sectionHeading?.trim();
  if (!heading) {
    throw new Error("section_heading is required for replace_section");
  }
  const section = findUniqueSection(input.currentLake, blocks, heading);
  const risks = proprietaryBlockTypes(section.bodyRaw);
  const unknown = unknownTopLevelTags(section.bodyRaw);
  if (risks.length || unknown.length) {
    throw new Error(
      `Section change is blocked because the target contains unsupported Lake blocks: ${[
        ...risks,
        ...unknown.map((tag) => `tag:${tag}`),
      ].join(", ")}`,
    );
  }
  if (input.mode === "delete_section") {
    const next = `${input.currentLake.slice(0, section.start)}${input.currentLake.slice(section.end)}`;
    if (scanTopLevelBlocks(next).every((block) => block.tag === "meta")) {
      throw new Error("Deleting this section would empty the entire document");
    }
    return {
      lakeContent: next,
      baseTargetFingerprint: fingerprint({
        mode: "delete_section",
        heading,
        raw: section.raw,
      }),
      proposedTargetFingerprint: fingerprint({
        mode: "delete_section",
        heading,
        deleted: section.raw,
      }),
      beforeText: [heading, lakeText(section.bodyRaw)]
        .filter(Boolean)
        .join("\n"),
      afterText: "",
      warnings: [
        "The complete named section, including its heading, will be removed.",
      ],
    };
  }

  const fragment = normalizedFragment(input.convertedFragment);
  if (!fragment) throw new Error("Converted Lake fragment is empty");
  const fragmentBlocks = scanTopLevelBlocks(fragment);
  const invalidHeading = fragmentBlocks.find((block) => {
    const level = headingLevel(block.tag);
    return level !== undefined && level <= section.level;
  });
  if (invalidHeading) {
    throw new Error(
      "Replacement content contains a heading at or above the target section level; split the change into a separate preview",
    );
  }
  const next = `${input.currentLake.slice(0, section.bodyStart)}${fragment}${input.currentLake.slice(section.end)}`;
  return {
    lakeContent: next,
    baseTargetFingerprint: fingerprint({
      mode: "replace_section",
      heading,
      raw: section.raw,
    }),
    proposedTargetFingerprint: fingerprint({
      mode: "replace_section",
      heading,
      headingRaw: section.headingRaw,
      fragment,
    }),
    beforeText: [heading, lakeText(section.bodyRaw)].filter(Boolean).join("\n"),
    afterText: [heading, lakeText(fragment)].filter(Boolean).join("\n"),
    warnings: [],
  };
}

export function lakeTargetFingerprint(input: {
  currentLake: string;
  mode: LakePatchMode;
  sectionHeading?: string;
}): string {
  const blocks = scanTopLevelBlocks(input.currentLake);
  if (input.mode === "append") {
    return fingerprint({ mode: "append", anchor: blocks.at(-1)?.raw ?? "" });
  }
  const heading = input.sectionHeading?.trim();
  if (!heading) throw new Error("section_heading is required");
  const section = findUniqueSection(input.currentLake, blocks, heading);
  return fingerprint({ mode: input.mode, heading, raw: section.raw });
}

export function lakeText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<\/(p|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function proprietaryBlockTypes(value: string): string[] {
  const found = new Set<string>();
  if (/<img\b/i.test(value)) found.add("image");
  if (/attachment:/i.test(value)) found.add("attachment");
  if (/lakeboard/i.test(value)) found.add("board");
  if (/lakesheet/i.test(value)) found.add("sheet");
  if (/lakemind/i.test(value)) found.add("mind");

  for (const type of cardAttributeValues(value, "data-card-type")) {
    classifyCardType(type, found);
  }
  for (const name of cardElementNames(value)) {
    classifyCardType(name, found);
  }
  return [...found];
}

function cardElementNames(value: string): string[] {
  const names: string[] = [];
  const card = /<card\b[^>]{0,8192}>/gi;
  for (const match of value.matchAll(card)) {
    const serialized = match[0];
    const name = /\bname\s*=\s*(?:"([^"]{1,128})"|'([^']{1,128})')/i.exec(
      serialized,
    );
    if (name?.[1] || name?.[2]) names.push((name[1] ?? name[2]!).trim());
    else names.push("");
  }
  return names;
}

function cardAttributeValues(value: string, attribute: string): string[] {
  const values: string[] = [];
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b${escaped}\\s*=\\s*(?:"([^"]{1,128})"|'([^']{1,128})')`,
    "gi",
  );
  for (const match of value.matchAll(pattern)) {
    values.push((match[1] ?? match[2] ?? "").trim());
  }
  return values;
}

function classifyCardType(value: string, found: Set<string>): void {
  switch (value.toLowerCase()) {
    case "image":
      found.add("image");
      break;
    case "file":
    case "attachment":
      found.add("attachment");
      break;
    case "board":
    case "basicdraw":
    case "flowchart":
    case "flowchart2":
      found.add("board");
      break;
    case "sheet":
    case "lakesheet":
      found.add("sheet");
      break;
    case "mind":
    case "mindmap":
      found.add("mind");
      break;
    default:
      found.add("unknown_card");
  }
}

export function scanTopLevelBlocks(value: string): LakeBlock[] {
  const blocks: LakeBlock[] = [];
  const ignoredRanges: Array<[number, number]> = [];
  const stack: string[] = [];
  let rootStart = -1;
  let index = 0;
  while (index < value.length) {
    const open = value.indexOf("<", index);
    if (open < 0) break;
    if (value.startsWith("<!--", open)) {
      const end = value.indexOf("-->", open + 4);
      if (end < 0)
        throw new Error("Lake content contains an unterminated comment");
      ignoredRanges.push([open, end + 3]);
      index = end + 3;
      continue;
    }
    if (value.startsWith("<!", open) || value.startsWith("<?", open)) {
      const end = tagEnd(value, open);
      ignoredRanges.push([open, end + 1]);
      index = end + 1;
      continue;
    }
    const end = tagEnd(value, open);
    const serialized = value.slice(open, end + 1);
    const closing = /^<\s*\/\s*([A-Za-z0-9:-]+)/.exec(serialized);
    if (closing?.[1]) {
      const tag = closing[1].toLowerCase();
      const expected = stack.pop();
      if (expected !== tag) {
        throw new Error(`Lake content has mismatched closing tag: ${tag}`);
      }
      if (stack.length === 0 && rootStart >= 0) {
        blocks.push({
          tag,
          start: rootStart,
          end: end + 1,
          raw: value.slice(rootStart, end + 1),
        });
        rootStart = -1;
      }
      index = end + 1;
      continue;
    }
    const opening = /^<\s*([A-Za-z0-9:-]+)/.exec(serialized);
    if (!opening?.[1]) {
      throw new Error("Lake content contains an invalid tag");
    }
    const tag = opening[1].toLowerCase();
    const selfClosing = /\/\s*>$/.test(serialized) || VOID_ELEMENTS.has(tag);
    if (stack.length === 0) rootStart = open;
    if (selfClosing) {
      if (stack.length === 0) {
        blocks.push({ tag, start: open, end: end + 1, raw: serialized });
        rootStart = -1;
      }
    } else {
      stack.push(tag);
    }
    index = end + 1;
  }
  if (stack.length > 0) throw new Error("Lake content contains unclosed tags");
  const outside = removeRanges(
    value,
    [
      ...blocks.map(({ start, end }): [number, number] => [start, end]),
      ...ignoredRanges,
    ].sort(([left], [right]) => left - right),
  );
  if (outside.trim()) {
    throw new Error("Lake content contains unsupported top-level text");
  }
  return blocks;
}

function normalizedFragment(value: string): string {
  const blocks = scanTopLevelBlocks(value);
  return blocks
    .filter((block) => block.tag !== "meta")
    .map((block) => block.raw)
    .join("");
}

function findUniqueSection(
  value: string,
  blocks: LakeBlock[],
  heading: string,
): {
  start: number;
  level: number;
  headingRaw: string;
  bodyStart: number;
  bodyRaw: string;
  raw: string;
  end: number;
} {
  const matches = blocks
    .map((block, index) => ({ block, index, level: headingLevel(block.tag) }))
    .filter(
      (entry): entry is { block: LakeBlock; index: number; level: number } =>
        entry.level !== undefined && lakeText(entry.block.raw) === heading,
    );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Section heading not found: ${heading}`
        : `Section heading is ambiguous: ${heading}`,
    );
  }
  const match = matches[0]!;
  let end = value.length;
  for (let index = match.index + 1; index < blocks.length; index += 1) {
    const level = headingLevel(blocks[index]!.tag);
    if (level !== undefined && level <= match.level) {
      end = blocks[index]!.start;
      break;
    }
  }
  return {
    start: match.block.start,
    level: match.level,
    headingRaw: match.block.raw,
    bodyStart: match.block.end,
    bodyRaw: value.slice(match.block.end, end),
    raw: value.slice(match.block.start, end),
    end,
  };
}

function headingLevel(tag: string): number | undefined {
  return /^h([1-6])$/.test(tag) ? Number.parseInt(tag.slice(1), 10) : undefined;
}

function unknownTopLevelTags(value: string): string[] {
  return [
    ...new Set(
      scanTopLevelBlocks(value)
        .map((block) => block.tag)
        .filter((tag) => tag !== "meta" && !SAFE_TOP_LEVEL_TAGS.has(tag)),
    ),
  ];
}

function tagEnd(value: string, start: number): number {
  let quote: string | undefined;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw new Error("Lake content contains an unterminated tag");
}

function removeRanges(value: string, ranges: Array<[number, number]>): string {
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    result += value.slice(cursor, start);
    cursor = end;
  }
  return result + value.slice(cursor);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    );
}
