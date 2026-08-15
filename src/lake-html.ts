import { spawn } from "node:child_process";
import { resolve } from "node:path";

const MAX_LAKE_CHARACTERS = 5_000_000;
const MAX_WORKER_OUTPUT_CHARACTERS = 10_000_000;

export interface LakeHtmlRenderer {
  render(lakeAsl: string): Promise<string>;
}

export class PinnedLakeHtmlRenderer implements LakeHtmlRenderer {
  constructor(
    private readonly workerPath = process.env.LAKE_RUNTIME_WORKER_PATH ??
      resolve(process.cwd(), "deploy/lake-runtime.mjs"),
    private readonly timeoutMs = 30_000,
  ) {}

  async render(lakeAsl: string): Promise<string> {
    if (
      typeof lakeAsl !== "string" ||
      !/^\s*<!doctype lake>/i.test(lakeAsl) ||
      lakeAsl.length > MAX_LAKE_CHARACTERS
    ) {
      throw new Error("Lake ASL is invalid or too large for HTML conversion");
    }
    const child = spawn(process.execPath, [this.workerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LAKE_CONVERT_STDIN: "1",
        LAKE_EDITOR_RUNTIME_PROBE: "1",
        PERSONAL_LAKE_COMPARE: "0",
        LAKE_RESEARCH_BUNDLE_MANIFEST: "",
        LAKE_RESEARCH_NODE_MODULES: "",
        YUQUE_LIVE_TEST_SUPPRESS_SUMMARY: "1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_WORKER_OUTPUT_CHARACTERS) {
        overflow = true;
        child.kill();
      }
    });
    const completed = new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error("Pinned Lake HTML conversion timed out"));
      }, this.timeoutMs);
      child.once("error", () =>
        finish(new Error("Pinned Lake HTML worker could not start")),
      );
      child.once("close", (code) => {
        if (overflow || code !== 0) {
          finish(new Error("Pinned Lake HTML conversion failed"));
        } else {
          finish();
        }
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ asl: lakeAsl }));
    await completed;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("Pinned Lake HTML worker returned malformed JSON");
    }
    const bodyHtml =
      parsed && typeof parsed === "object" && "body_html" in parsed
        ? (parsed as { body_html?: unknown }).body_html
        : undefined;
    if (
      typeof bodyHtml !== "string" ||
      !/^<!doctype html>/i.test(bodyHtml) ||
      bodyHtml.length > MAX_WORKER_OUTPUT_CHARACTERS
    ) {
      throw new Error("Pinned Lake HTML worker returned invalid HTML");
    }
    return bodyHtml;
  }
}
