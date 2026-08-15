import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedLakeHtmlRenderer } from "../src/lake-html.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("pinned Lake HTML renderer boundary", () => {
  it("passes ASL through a subprocess without logging or accepting malformed output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yuque-lake-renderer-"));
    temporaryDirectories.push(directory);
    const workerPath = join(directory, "worker.mjs");
    await writeFile(
      workerPath,
      `let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input);
if (!parsed.asl.includes("probe")) process.exit(2);
process.stdout.write(JSON.stringify({ body_html: "<!doctype html><p>probe</p>" }));
`,
      { mode: 0o600 },
    );
    const renderer = new PinnedLakeHtmlRenderer(workerPath, 5_000);
    await expect(renderer.render("<!doctype lake><p>probe</p>")).resolves.toBe(
      "<!doctype html><p>probe</p>",
    );
    await expect(renderer.render("<p>missing doctype</p>")).rejects.toThrow(
      "Lake ASL is invalid",
    );
  });
});
