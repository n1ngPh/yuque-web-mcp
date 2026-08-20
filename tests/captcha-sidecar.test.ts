import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  PinnedCaptchaSidecar,
  type CaptchaSidecarOptions,
} from "../src/captcha-sidecar.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: unknown;
  };
}

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(options: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number;
  emitError?: boolean;
  hang?: boolean;
}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (options.stdoutData !== undefined) {
      child.stdout.emit("data", options.stdoutData);
    }
    if (options.stderrData !== undefined) {
      child.stderr.emit("data", options.stderrData);
    }
    if (options.emitError) {
      child.emit("error", new Error("spawn failed"));
    } else if (!options.hang) {
      child.emit("close", options.exitCode ?? 0);
    }
  });
  return child;
}

function harness(
  childOptions: Parameters<typeof fakeChild>[0],
  overrides: Partial<CaptchaSidecarOptions> = {},
) {
  const spawnCalls: SpawnCall[] = [];
  let child: FakeChild | undefined;
  const spawnFn = (
    command: string,
    args: string[],
    options: SpawnCall["options"],
  ) => {
    spawnCalls.push({ command, args, options });
    child = fakeChild(childOptions);
    return child as never;
  };
  const sidecar = new PinnedCaptchaSidecar({
    pythonPath: "python3",
    solvePath: "/app/captcha/solve.py",
    ...overrides,
    spawnFn: spawnFn as never,
  });
  return { sidecar, spawnCalls, child: () => child };
}

describe("Captcha sidecar subprocess wrapper", () => {
  it("runs send_sms with the correct argv and passes proxy/browser env", async () => {
    const { sidecar, spawnCalls } = harness(
      { stdoutData: '{"ok":true,"status":200,"body":"{\\"data\\":true}"}' },
      { proxyUrl: "http://127.0.0.1:7897", browserPath: "/usr/bin/chromium" },
    );

    await expect(sidecar.sendSms("13800138000")).resolves.toEqual({
      ok: true,
      status: 200,
      body: '{"data":true}',
    });

    const call = spawnCalls[0]!;
    expect(call.command).toBe("python3");
    expect(call.args).toEqual([
      "/app/captcha/solve.py",
      "send_sms",
      "13800138000",
    ]);
    expect(call.options.env).toMatchObject({
      CAPTCHA_PROXY: "http://127.0.0.1:7897",
      CHROME_BROWSER_PATH: "/usr/bin/chromium",
    });
  });

  it("parses account, cookies and csrf token from a login result", async () => {
    const { sidecar } = harness({
      stdoutData: JSON.stringify({
        ok: true,
        status: 200,
        body: "{}",
        account: { id: "71172175", login: "u8890", name: "8890" },
        cookies: [
          {
            name: "_yuque_session",
            value: "abc",
            domain: ".yuque.com",
            path: "/",
            expires: 1893456000,
            httpOnly: true,
            secure: true,
            sameSite: "None",
          },
        ],
        csrfToken: "csrf-token-value",
      }),
    });

    const result = await sidecar.login("13800138000", "123456");
    expect(result.ok).toBe(true);
    expect(result.account).toEqual({
      id: "71172175",
      login: "u8890",
      name: "8890",
    });
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]).toMatchObject({
      name: "_yuque_session",
      domain: ".yuque.com",
      httpOnly: true,
    });
    expect(result.csrfToken).toBe("csrf-token-value");
  });

  it("omits the proxy/browser env when not configured", async () => {
    const { sidecar, spawnCalls } = harness({
      stdoutData: '{"ok":true,"status":200,"body":""}',
    });
    await sidecar.sendSms("13800138000");
    expect(spawnCalls[0]!.options.env?.CAPTCHA_PROXY).toBeUndefined();
    expect(spawnCalls[0]!.options.env?.CHROME_BROWSER_PATH).toBeUndefined();
  });

  it("surfaces a non-zero exit with the last stderr line", async () => {
    const { sidecar } = harness({
      exitCode: 1,
      stderrData: "Traceback...\nDrissionPage: chrome not found",
    });
    await expect(sidecar.sendSms("13800138000")).rejects.toThrow(
      /Captcha sidecar failed \(send_sms\): DrissionPage: chrome not found/,
    );
  });

  it("prefers the JSON error on stdout for a risk-control failure", async () => {
    const { sidecar } = harness({
      exitCode: 1,
      stdoutData:
        '{"ok":false,"error":"capture failed: 未获取到 certifyId/deviceToken（F001）；可能被风控拒绝，建议设置 CAPTCHA_PROXY 切换到干净的出口代理后重试"}',
      stderrData: "ignored",
    });
    await expect(sidecar.sendSms("13800138000")).rejects.toThrow(
      /capture failed.*CAPTCHA_PROXY/,
    );
  });

  it("rejects malformed JSON output", async () => {
    const { sidecar } = harness({ stdoutData: "not-json" });
    await expect(sidecar.sendSms("13800138000")).rejects.toThrow(
      /malformed JSON/,
    );
  });

  it("times out and kills the process", async () => {
    const { sidecar, child } = harness({ hang: true }, { timeoutMs: 40 });
    await expect(sidecar.sendSms("13800138000")).rejects.toThrow(/timed out/);
    expect(child()?.kill).toHaveBeenCalled();
  });
});
