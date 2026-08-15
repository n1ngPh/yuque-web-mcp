import { describe, expect, it } from "vitest";
import {
  LOGIN_PROVIDERS,
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
});
