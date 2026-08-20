import { describe, expect, it, vi } from "vitest";
import {
  CHROMIUM_LAUNCH_ARGS,
  CHROMIUM_SANDBOX_ENABLED,
  LOGIN_PROVIDERS,
  LoginManager,
  chromiumLaunchOptions,
  parseLoginProvider,
  renderLoginPage,
} from "../src/login-manager.js";

describe("QR login provider boundary", () => {
  it("keeps the Chromium process sandbox enabled", () => {
    expect(CHROMIUM_SANDBOX_ENABLED).toBe(true);
    expect(CHROMIUM_LAUNCH_ARGS).not.toContain("--no-sandbox");
    expect(CHROMIUM_LAUNCH_ARGS).not.toContain("--disable-setuid-sandbox");
    expect(
      chromiumLaunchOptions({
        chromiumExecutable: "/usr/bin/chromium",
      } as never),
    ).toMatchObject({
      executablePath: "/usr/bin/chromium",
      chromiumSandbox: true,
    });
  });

  it("accepts only the three verified official QR providers", () => {
    expect(LOGIN_PROVIDERS).toEqual(["dingtalk", "wechat", "alipay"]);
    expect(parseLoginProvider("dingtalk")).toBe("dingtalk");
    expect(parseLoginProvider("wechat")).toBe("wechat");
    expect(parseLoginProvider("alipay")).toBe("alipay");
    expect(parseLoginProvider("password")).toBe(undefined);
    expect(parseLoginProvider("sms")).toBe(undefined);
    expect(parseLoginProvider({ provider: "dingtalk" })).toBe(undefined);
  });

  it("explains registration and encrypted session safety before scanning", () => {
    const html = renderLoginPage(
      "public-code",
      {
        state: "waiting_scan",
        loginId: "public",
        expiresAt: "2026-08-15T08:00:00.000Z",
      },
      "dingtalk",
    );

    expect(html).toContain("隐私与加密安全");
    expect(html).toContain("AES-256-GCM 加密保存");
    expect(html).toContain("每个账号的登录数据相互隔离");
    expect(html).toContain("个人空间扫码要求账号已注册并已绑定手机号");
    expect(html).toContain("企业或组织空间能够通过钉钉登录");
    expect(html).toContain("不代表个人空间账号已经完成手机号绑定");
    expect(html).toContain('id="login-flow" class="flow"');
    expect(html).toContain('id="refresh-qr"');
    expect(html).toContain("刷新二维码");
    expect(html).toContain("base+'/refresh'");
    expect(html).toContain("二维码尚未加载，正在自动重试");
    expect(html).toContain(
      'id="success-panel" class="success" role="status" hidden',
    );
  });

  it("shows a close-page confirmation only after successful persistence", () => {
    const html = renderLoginPage(
      "public-code",
      {
        state: "success",
        loginId: "public",
        expiresAt: "2026-08-15T08:00:00.000Z",
        message: "已成功登录，可关闭此页面",
      },
      "wechat",
    );

    expect(html).toContain("已成功登录，可关闭此页面");
    expect(html).toContain('id="login-flow" class="flow" hidden');
    expect(html).toContain('id="success-panel" class="success" role="status"');
    expect(html).not.toContain(
      'id="success-panel" class="success" role="status" hidden',
    );
  });

  it("refreshes an active QR page and preserves the selected provider", async () => {
    const manager = loginManager();
    const goto = vi.fn().mockResolvedValue(undefined);
    const screenshot = vi.fn().mockResolvedValue(Buffer.from("fresh-qr"));
    const attempt = loginAttempt("waiting_scan", {
      page: { goto, screenshot },
      message: "temporary failure",
    });
    registerAttempt(manager, attempt);

    await expect(manager.refreshByPublicCode("public-code")).resolves.toBe(
      "accepted",
    );
    expect(goto).toHaveBeenCalledWith(
      expect.stringContaining("platform=dingtalk"),
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(screenshot).toHaveBeenCalledOnce();
    expect(attempt.screenshot?.toString()).toBe("fresh-qr");
    expect(attempt.message).toBe(undefined);
  });

  it("handles missing, starting, completed and transient refresh states", async () => {
    const missing = loginManager();
    await expect(missing.refreshByPublicCode("missing")).resolves.toBe(
      "not_found",
    );

    const starting = loginManager();
    registerAttempt(
      starting,
      loginAttempt("starting", { screenshot: Buffer.from("ready") }),
    );
    await expect(starting.refreshByPublicCode("public-code")).resolves.toBe(
      "accepted",
    );

    const completed = loginManager();
    registerAttempt(completed, loginAttempt("success"));
    await expect(completed.refreshByPublicCode("public-code")).resolves.toBe(
      "not_ready",
    );

    const transient = loginManager();
    registerAttempt(
      transient,
      loginAttempt("waiting_scan", {
        page: {
          goto: vi.fn().mockRejectedValue(new Error("navigation changed")),
          screenshot: vi.fn(),
        },
      }),
    );
    await expect(transient.refreshByPublicCode("public-code")).resolves.toBe(
      "not_ready",
    );
  });

  it("escapes failure messages embedded into the login page script", () => {
    const html = renderLoginPage(
      "public-code",
      {
        state: "failed",
        loginId: "public",
        expiresAt: "2026-08-15T08:00:00.000Z",
        message: "can't load </script>\nretry",
      },
      "alipay",
    );
    expect(html).toContain("can\\'t load \\u003c/script>\\nretry");
    expect(html).not.toContain("applyStatus('failed','can't load </script>");
  });
});

describe("SMS login flow", () => {
  it("sends a code through the sidecar and lands in waiting_sms", async () => {
    const captcha = smsCaptcha({ sendSmsOk: true });
    const sessions = smsSessions();
    const manager = smsManager(captcha, sessions);

    const status = await manager.beginSms("employee.a", "13800138000");

    expect(captcha.sendSms).toHaveBeenCalledWith("13800138000");
    expect(status.state).toBe("waiting_sms");
    expect(status.message).toBe("短信验证码已发送，请查收");
    expect(status.loginId).toBeTruthy();
    expect(sessions.save).not.toHaveBeenCalled();
  });

  it("marks a rejected send as failed without persisting a session", async () => {
    const captcha = smsCaptcha({ sendSmsOk: false, status: 429 });
    const sessions = smsSessions();
    const manager = smsManager(captcha, sessions);

    const status = await manager.beginSms("employee.a", "13800138000");

    expect(status.state).toBe("failed");
    expect(status.message).toBe("发送过于频繁，请稍后再试");
    expect(sessions.save).not.toHaveBeenCalled();
  });

  it("submits the code and saves the session in tough-cookie shape", async () => {
    const captcha = smsCaptcha({ sendSmsOk: true, loginOk: true });
    const sessions = smsSessions();
    const manager = smsManager(captcha, sessions);

    const sent = await manager.beginSms("employee.a", "13800138000");
    const result = await manager.submitSms(
      "employee.a",
      sent.loginId,
      "123456",
    );

    expect(captcha.login).toHaveBeenCalledWith("13800138000", "123456");
    expect(result.state).toBe("success");
    expect(result.account).toMatchObject({
      id: "71172175",
      login: "u8890",
      name: "8890",
    });

    const saved = sessions.save.mock.calls[0]![1];
    expect(saved.csrfToken).toBe("csrf-token-value");
    expect(saved.account).toMatchObject({ id: "71172175", login: "u8890" });
    expect(saved.cookies.cookies).toHaveLength(1);
    expect(saved.cookies.cookies[0]).toMatchObject({
      key: "_yuque_session",
      value: "abc",
      domain: "yuque.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "none",
      hostOnly: false,
    });
    expect(saved.savedAt).toEqual(expect.any(String));
  });

  it("rejects submission for an unknown attempt", async () => {
    const manager = smsManager(smsCaptcha({}), smsSessions());
    await expect(
      manager.submitSms("employee.a", "missing", "123456"),
    ).rejects.toThrow("not found");
  });

  it("returns to waiting_sms after a failed verification and keeps state", async () => {
    const captcha = smsCaptcha({
      sendSmsOk: true,
      loginOk: false,
      status: 400,
      body: '{"message":"验证码错误"}',
    });
    const sessions = smsSessions();
    const manager = smsManager(captcha, sessions);

    const sent = await manager.beginSms("employee.a", "13800138000");
    await expect(
      manager.submitSms("employee.a", sent.loginId, "000000"),
    ).rejects.toThrow("验证码错误");

    expect(sessions.save).not.toHaveBeenCalled();
    expect(manager.status("employee.a", sent.loginId).state).toBe(
      "waiting_sms",
    );
  });

  it("caps concurrent login flows across employees", async () => {
    const captcha = smsCaptcha({ sendSmsOk: true });
    const manager = new LoginManager(
      {
        loginTtlSeconds: 300,
        publicBaseUrl: "http://127.0.0.1:18082",
        personalYuqueHost: "https://www.yuque.com",
        yuqueHost: "https://www.yuque.com",
        organization: "",
        chromiumExecutable: "/not-used",
        maxConcurrentLogins: 1,
      } as never,
      smsSessions() as never,
      captcha as never,
    );

    await manager.beginSms("employee.a", "13800138000");
    await expect(manager.beginSms("employee.b", "13800138001")).rejects.toThrow(
      "At most 1 login flows",
    );
  });
});

function loginManager(): LoginManager {
  return new LoginManager(
    {
      loginTtlSeconds: 300,
      publicBaseUrl: "http://127.0.0.1:18082",
      personalYuqueHost: "https://www.yuque.com",
      yuqueHost: "https://www.yuque.com",
      organization: "",
      chromiumExecutable: "/not-used",
    } as never,
    {} as never,
  );
}

function loginAttempt(
  state: "starting" | "waiting_scan" | "success",
  overrides: Record<string, unknown> = {},
) {
  return {
    employeeId: "employee.a",
    loginId: "login-id",
    publicCode: "public-code",
    provider: "dingtalk",
    expiresAt: new Date(Date.now() + 60_000),
    state,
    interactionQueue: Promise.resolve(),
    ...overrides,
  } as {
    employeeId: string;
    loginId: string;
    publicCode: string;
    provider: "dingtalk";
    expiresAt: Date;
    state: "starting" | "waiting_scan" | "success";
    interactionQueue: Promise<void>;
    screenshot?: Buffer;
    message?: string;
    page?: {
      goto: ReturnType<typeof vi.fn>;
      screenshot: ReturnType<typeof vi.fn>;
    };
  };
}

function registerAttempt(
  manager: LoginManager,
  attempt: ReturnType<typeof loginAttempt>,
) {
  const internal = manager as unknown as {
    attemptsById: Map<string, unknown>;
    attemptsByCode: Map<string, unknown>;
  };
  internal.attemptsById.set(attempt.loginId, attempt);
  internal.attemptsByCode.set(attempt.publicCode, attempt);
}

interface SmsCaptchaOptions {
  sendSmsOk?: boolean;
  status?: number;
  body?: string;
  loginOk?: boolean;
}

function smsCaptcha(options: SmsCaptchaOptions) {
  return {
    sendSms: vi.fn().mockResolvedValue({
      ok: options.sendSmsOk ?? true,
      status: options.status ?? 200,
      body: options.body ?? "{}",
    }),
    login: vi.fn().mockResolvedValue({
      ok: options.loginOk ?? true,
      status: options.status ?? 200,
      body: options.body ?? "{}",
      account:
        options.loginOk === false
          ? null
          : {
              id: "71172175",
              login: "u8890",
              name: "8890",
            },
      cookies:
        options.loginOk === false
          ? []
          : [
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
  };
}

function smsSessions() {
  return { save: vi.fn().mockResolvedValue(undefined) };
}

function smsManager(
  captcha: ReturnType<typeof smsCaptcha>,
  sessions: ReturnType<typeof smsSessions>,
) {
  return new LoginManager(
    {
      loginTtlSeconds: 300,
      publicBaseUrl: "http://127.0.0.1:18082",
      personalYuqueHost: "https://www.yuque.com",
      yuqueHost: "https://www.yuque.com",
      organization: "",
      chromiumExecutable: "/not-used",
    } as never,
    sessions as never,
    captcha as never,
  );
}
