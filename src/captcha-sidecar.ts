import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

// The Python sidecar (captcha/solve.py) drives a real Chrome via DrissionPage
// to solve the Aliyun slider captcha, then speaks the Yuque SMS login endpoints.
// It is spawned as a subprocess and returns JSON on stdout. This module is the
// thin, testable wrapper that pins timeouts, output limits, and env injection.
const MAX_CAPTCHA_OUTPUT_BYTES = 2_000_000;
const DEFAULT_CAPTCHA_TIMEOUT_MS = 180_000;

export interface CaptchaCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface CaptchaAccount {
  id: string;
  login: string;
  name: string | null;
}

export interface SendSmsResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface LoginResult {
  ok: boolean;
  status: number;
  body: string;
  account: CaptchaAccount | null;
  cookies: CaptchaCookie[];
  csrfToken: string;
}

export interface CaptchaSidecar {
  sendSms(phone: string): Promise<SendSmsResult>;
  login(phone: string, code: string): Promise<LoginResult>;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CaptchaSidecarOptions {
  pythonPath: string;
  solvePath: string;
  browserPath?: string;
  proxyUrl?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

export class PinnedCaptchaSidecar implements CaptchaSidecar {
  private readonly pythonPath: string;
  private readonly solvePath: string;
  private readonly browserPath: string | undefined;
  private readonly proxyUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;

  constructor(options: CaptchaSidecarOptions) {
    this.pythonPath = options.pythonPath;
    this.solvePath = options.solvePath;
    this.browserPath = options.browserPath;
    this.proxyUrl = options.proxyUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CAPTCHA_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  async sendSms(phone: string): Promise<SendSmsResult> {
    const raw = await this.run("send_sms", [phone]);
    return {
      ok: raw.ok === true,
      status: numberField(raw, "status"),
      body: typeof raw.body === "string" ? raw.body : "",
    };
  }

  async login(phone: string, code: string): Promise<LoginResult> {
    const raw = await this.run("login", [phone, code]);
    return {
      ok: raw.ok === true,
      status: numberField(raw, "status"),
      body: typeof raw.body === "string" ? raw.body : "",
      account: parseAccount(raw.account),
      cookies: Array.isArray(raw.cookies)
        ? raw.cookies.filter(isCaptchaCookie)
        : [],
      csrfToken: typeof raw.csrfToken === "string" ? raw.csrfToken : "",
    };
  }

  private async run(
    subcommand: string,
    args: string[],
  ): Promise<Record<string, unknown>> {
    const child = this.spawnFn(
      this.pythonPath,
      [this.solvePath, subcommand, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(this.proxyUrl ? { CAPTCHA_PROXY: this.proxyUrl } : {}),
          ...(this.browserPath
            ? { CHROME_BROWSER_PATH: this.browserPath }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      child.kill();
      throw new Error("Captcha sidecar stdio is unavailable");
    }
    stdoutStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_CAPTCHA_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
      }
    });
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_CAPTCHA_OUTPUT_BYTES) overflow = true;
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
        finish(new Error(`Captcha sidecar timed out (${subcommand})`));
      }, this.timeoutMs);
      child.once("error", () =>
        finish(new Error("Captcha sidecar process could not start")),
      );
      child.once("close", (code) => {
        if (overflow || code !== 0) {
          // solve.py 用 emit(..., 1) 把错误 JSON 写到 stdout 再退出 1，stderr 通常
          // 为空。优先取 stdout 里的 error 字段（含风控/代理提示），否则退回 stderr。
          const detail =
            extractSidecarError(stdout) ??
            stderr.trim().split("\n").at(-1) ??
            "";
          finish(
            new Error(
              `Captcha sidecar failed (${subcommand})` +
                (detail ? `: ${detail.slice(0, 500)}` : ""),
            ),
          );
        } else {
          finish();
        }
      });
    });
    await completed;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(
        `Captcha sidecar returned malformed JSON (${subcommand})`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        `Captcha sidecar returned invalid output (${subcommand})`,
      );
    }
    return parsed as Record<string, unknown>;
  }
}

function extractSidecarError(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "string" && error !== "") return error;
    }
  } catch {
    // stdout 不是 JSON 时交给 stderr 兜底。
  }
  return undefined;
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseAccount(value: unknown): CaptchaAccount | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.login !== "string" ||
    record.id === "" ||
    record.login === ""
  ) {
    return null;
  }
  return {
    id: record.id,
    login: record.login,
    name:
      typeof record.name === "string" && record.name !== ""
        ? record.name
        : null,
  };
}

function isCaptchaCookie(value: unknown): value is CaptchaCookie {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.value === "string" &&
    typeof record.domain === "string" &&
    typeof record.path === "string"
  );
}
