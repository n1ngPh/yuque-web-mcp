import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("skills/yuque-workspace");
const skill = await readFile(resolve(root, "SKILL.md"), "utf8");
const metadata = skill.match(/^---\n([\s\S]*?)\n---\n/);
if (!metadata) throw new Error("SKILL.md frontmatter is missing");
const keys = metadata[1]
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split(":", 1)[0]);
if (keys.join(",") !== "name,description") {
  throw new Error(
    "SKILL.md frontmatter must contain only name and description",
  );
}
if (!metadata[1].includes("name: yuque-workspace")) {
  throw new Error("Skill name does not match its directory");
}
if (skill.split("\n").length > 500) {
  throw new Error("SKILL.md exceeds the 500-line context budget");
}
for (const reference of ["references/workflows.md", "agents/openai.yaml"]) {
  await readFile(resolve(root, reference), "utf8");
}
const interfaceFile = await readFile(
  resolve(root, "agents/openai.yaml"),
  "utf8",
);
if (!interfaceFile.includes("$yuque-workspace")) {
  throw new Error(
    "Skill default_prompt must explicitly mention $yuque-workspace",
  );
}
process.stdout.write("yuque-workspace skill validation passed.\n");
