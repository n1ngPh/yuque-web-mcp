import { describe, expect, it, vi } from "vitest";
import {
  LOGIN_PROVIDERS,
  LoginManager,
  parseLoginProvider,
  renderLoginPage,
} from "../src/login-manager.js";

describe("QR login provider boundary", () => {
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
    expect(html).toContain("只支持已注册的账号进行扫描登录");
    expect(html).toContain("绑定手机号并输入短信验证码");
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
