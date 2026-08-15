import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { randomBase64Url } from "./crypto.js";
import type { SessionStore } from "./session-store.js";
import type { LoginStatus, YuqueAccount } from "./types.js";

interface LoginAttempt {
  employeeId: string;
  loginId: string;
  publicCode: string;
  provider: LoginProvider;
  expiresAt: Date;
  state: LoginStatus["state"];
  screenshot?: Buffer;
  account?: YuqueAccount;
  message?: string;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  interactionQueue: Promise<void>;
}

export const LOGIN_PROVIDERS = ["dingtalk", "wechat", "alipay"] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export function parseLoginProvider(value: unknown): LoginProvider | undefined {
  if (typeof value !== "string") return undefined;
  return LOGIN_PROVIDERS.find((provider) => provider === value);
}

export class LoginManager {
  private readonly attemptsById = new Map<string, LoginAttempt>();
  private readonly attemptsByCode = new Map<string, LoginAttempt>();

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  async begin(
    employeeId: string,
    provider: LoginProvider = "dingtalk",
  ): Promise<{
    status: LoginStatus;
    loginUrl: string;
    provider: LoginProvider;
    screenshot?: Buffer;
  }> {
    const existing = [...this.attemptsById.values()].find(
      (attempt) =>
        attempt.employeeId === employeeId &&
        ["starting", "waiting_scan"].includes(attempt.state) &&
        attempt.expiresAt > new Date(),
    );
    if (existing?.provider === provider) return this.describeAttempt(existing);
    if (existing) await this.closeAttempt(existing);

    const activeCount = [...this.attemptsById.values()].filter((attempt) =>
      ["starting", "waiting_scan"].includes(attempt.state),
    ).length;
    if (activeCount >= 2)
      throw new Error("At most two employee login flows may run concurrently");

    const attempt: LoginAttempt = {
      employeeId,
      loginId: randomUUID(),
      publicCode: randomBase64Url(32),
      provider,
      expiresAt: new Date(Date.now() + this.config.loginTtlSeconds * 1000),
      state: "starting",
      interactionQueue: Promise.resolve(),
    };
    this.attemptsById.set(attempt.loginId, attempt);
    this.attemptsByCode.set(attempt.publicCode, attempt);
    void this.run(attempt);

    await waitFor(
      () => Boolean(attempt.screenshot) || attempt.state === "failed",
      15_000,
    );
    return this.describeAttempt(attempt);
  }

  status(employeeId: string, loginId: string): LoginStatus {
    const attempt = this.attemptsById.get(loginId);
    if (!attempt || attempt.employeeId !== employeeId)
      throw new Error("Login attempt not found");
    this.expireIfNeeded(attempt);
    return toStatus(attempt);
  }

  statusByPublicCode(code: string): LoginStatus | undefined {
    const attempt = this.publicAttempt(code);
    if (!attempt) return undefined;
    const status = toStatus(attempt);
    return {
      state: status.state,
      loginId: "public",
      expiresAt: status.expiresAt,
      ...(status.message ? { message: status.message } : {}),
    };
  }

  screenshotByPublicCode(code: string): Buffer | undefined {
    const attempt = this.publicAttempt(code);
    if (!attempt) return undefined;
    if (!["starting", "waiting_scan"].includes(attempt.state)) return undefined;
    return attempt.screenshot;
  }

  async selectProviderByPublicCode(
    code: string,
    provider: LoginProvider,
  ): Promise<"accepted" | "not_found" | "not_ready"> {
    const attempt = this.publicAttempt(code);
    if (!attempt) return "not_found";
    if (attempt.state !== "waiting_scan" || !attempt.page) return "not_ready";

    try {
      await this.enqueueInteraction(attempt, async () => {
        const page = attempt.page;
        if (!page || attempt.state !== "waiting_scan")
          throw new Error("Login page is not available");
        await page.goto(this.loginTarget(provider), {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        attempt.provider = provider;
        attempt.screenshot = await page.screenshot({
          type: "png",
          fullPage: false,
        });
      });
      return "accepted";
    } catch {
      return "not_ready";
    }
  }

  async refreshByPublicCode(
    code: string,
  ): Promise<"accepted" | "not_found" | "not_ready"> {
    const attempt = this.publicAttempt(code);
    if (!attempt) return "not_found";

    if (attempt.state === "failed") {
      await this.closeBrowser(attempt);
      attempt.expiresAt = new Date(
        Date.now() + this.config.loginTtlSeconds * 1000,
      );
      attempt.state = "starting";
      attempt.interactionQueue = Promise.resolve();
      delete attempt.screenshot;
      delete attempt.account;
      delete attempt.message;
      void this.run(attempt);
      await waitFor(
        () => Boolean(attempt.screenshot) || attempt.state === "failed",
        15_000,
      );
      return attempt.screenshot ? "accepted" : "not_ready";
    }

    if (attempt.state === "starting") {
      await waitFor(
        () => Boolean(attempt.screenshot) || attempt.state === "failed",
        15_000,
      );
      return attempt.screenshot ? "accepted" : "not_ready";
    }

    if (attempt.state !== "waiting_scan" || !attempt.page) return "not_ready";
    try {
      await this.enqueueInteraction(attempt, async () => {
        const page = attempt.page;
        if (!page || attempt.state !== "waiting_scan")
          throw new Error("Login page is not available");
        await page.goto(this.loginTarget(attempt.provider), {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        attempt.screenshot = await page.screenshot({
          type: "png",
          fullPage: false,
        });
        delete attempt.message;
      });
      return "accepted";
    } catch {
      return "not_ready";
    }
  }

  pageByPublicCode(code: string): string | undefined {
    const attempt = this.publicAttempt(code);
    if (!attempt) return undefined;
    const status = toStatus(attempt);
    return renderLoginPage(code, status, attempt.provider);
  }

  async cancelEmployee(employeeId: string): Promise<void> {
    const attempts = [...this.attemptsById.values()].filter(
      (attempt) => attempt.employeeId === employeeId,
    );
    await Promise.all(attempts.map((attempt) => this.closeAttempt(attempt)));
  }

  private describeAttempt(attempt: LoginAttempt): {
    status: LoginStatus;
    loginUrl: string;
    provider: LoginProvider;
    screenshot?: Buffer;
  } {
    return {
      status: toStatus(attempt),
      loginUrl: `${this.config.publicBaseUrl}/login/${attempt.publicCode}`,
      provider: attempt.provider,
      ...(attempt.screenshot ? { screenshot: attempt.screenshot } : {}),
    };
  }

  private async run(attempt: LoginAttempt): Promise<void> {
    try {
      const browser = await chromium.launch({
        executablePath: this.config.chromiumExecutable,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      attempt.browser = browser;
      const context = await browser.newContext({ locale: "zh-CN" });
      attempt.context = context;
      const page = await context.newPage();
      attempt.page = page;
      await page.goto(this.loginTarget(attempt.provider), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      attempt.state = "waiting_scan";
      let consecutivePollFailures = 0;

      while (
        attempt.expiresAt > new Date() &&
        attempt.state === "waiting_scan"
      ) {
        let account: YuqueAccount | undefined;
        let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> | undefined;
        let csrfToken: string | undefined;
        try {
          await this.enqueueInteraction(attempt, async () => {
            attempt.screenshot = await page.screenshot({
              type: "png",
              fullPage: false,
            });
            account = await readAccount(page);
            if (account) {
              cookies = await context.cookies();
              csrfToken = await readCsrf(page, cookies);
              if (!csrfToken)
                throw new Error(
                  "Login succeeded but no CSRF token could be located",
                );
            }
          });
          consecutivePollFailures = 0;
          delete attempt.message;
        } catch {
          if (page.isClosed()) throw new Error("Login page was closed");
          consecutivePollFailures += 1;
          attempt.message = "二维码页面正在自动刷新，请稍候";
          if (consecutivePollFailures >= 3) {
            await this.enqueueInteraction(attempt, async () => {
              await page.goto(this.loginTarget(attempt.provider), {
                waitUntil: "domcontentloaded",
                timeout: 60_000,
              });
              attempt.screenshot = await page.screenshot({
                type: "png",
                fullPage: false,
              });
            });
            consecutivePollFailures = 0;
          }
          await page.waitForTimeout(1_000);
          continue;
        }
        if (account && cookies && csrfToken) {
          await this.sessions.save(attempt.employeeId, {
            cookies: {
              version: "tough-cookie@6",
              storeType: "MemoryCookieStore",
              rejectPublicSuffixes: true,
              enableLooseMode: false,
              allowSpecialUseDomain: true,
              prefixSecurity: "silent",
              cookies: cookies.map(toToughCookieJson),
            },
            csrfToken,
            account,
            savedAt: new Date().toISOString(),
          });
          attempt.state = "success";
          attempt.account = account;
          delete attempt.screenshot;
          attempt.message = "已成功登录，可关闭此页面";
          break;
        }
        await page.waitForTimeout(1_000);
      }
      if (attempt.state === "waiting_scan") {
        attempt.state = "expired";
        attempt.message = "登录页面已过期";
      }
    } catch {
      attempt.state = "failed";
      attempt.message =
        "登录流程失败；请检查 Chromium、网络或是否出现交互式验证码";
    } finally {
      await this.closeBrowser(attempt);
    }
  }

  private expireIfNeeded(attempt: LoginAttempt): void {
    if (
      attempt.expiresAt <= new Date() &&
      ["starting", "waiting_scan"].includes(attempt.state)
    ) {
      attempt.state = "expired";
      attempt.message = "登录页面已过期";
      void this.closeBrowser(attempt);
    }
  }

  private publicAttempt(code: string): LoginAttempt | undefined {
    const attempt = this.attemptsByCode.get(code);
    if (!attempt) return undefined;
    this.expireIfNeeded(attempt);
    if (attempt.expiresAt <= new Date()) {
      this.attemptsByCode.delete(code);
      return undefined;
    }
    return attempt;
  }

  private async closeAttempt(attempt: LoginAttempt): Promise<void> {
    if (["starting", "waiting_scan"].includes(attempt.state)) {
      attempt.state = "failed";
      attempt.message = "登录已取消";
    }
    await this.closeBrowser(attempt);
  }

  private async closeBrowser(attempt: LoginAttempt): Promise<void> {
    await attempt.interactionQueue.catch(() => undefined);
    delete attempt.page;
    await attempt.context?.close().catch(() => undefined);
    await attempt.browser?.close().catch(() => undefined);
    delete attempt.context;
    delete attempt.browser;
  }

  private enqueueInteraction(
    attempt: LoginAttempt,
    operation: () => Promise<void>,
  ): Promise<void> {
    const pending = attempt.interactionQueue.then(operation);
    attempt.interactionQueue = pending.catch(() => undefined);
    return pending;
  }

  private loginTarget(provider: LoginProvider): string {
    const target = this.config.organization
      ? new URL("/login", this.config.yuqueHost)
      : new URL("/login", this.config.personalYuqueHost);
    if (this.config.organization)
      target.searchParams.set("org", this.config.organization);
    target.searchParams.set("platform", provider);
    target.searchParams.set(
      "goto",
      this.config.organization
        ? `${this.config.yuqueHost}/`
        : `${this.config.personalYuqueHost}/dashboard`,
    );
    return target.toString();
  }
}

export function renderLoginPage(
  code: string,
  status: LoginStatus,
  provider: LoginProvider,
): string {
  const encodedCode = encodeURIComponent(code);
  const expiresAt = new Date(status.expiresAt).toLocaleString("zh-CN");
  const success = status.state === "success";
  const providerLabels: Record<LoginProvider, string> = {
    dingtalk: "钉钉扫码",
    wechat: "微信扫码",
    alipay: "支付宝扫码",
  };
  const providerButtons = LOGIN_PROVIDERS.map(
    (value) =>
      `<button type="button" class="provider${provider === value ? " active" : ""}" data-provider="${value}" aria-pressed="${provider === value ? "true" : "false"}">${providerLabels[value]}</button>`,
  ).join("");
  const stateLabels: Record<LoginStatus["state"], string> = {
    starting: "正在准备安全登录",
    waiting_scan: "等待扫码",
    success: "登录成功",
    expired: "登录页已过期",
    failed: "登录失败",
  };
  const statusMessage = status.message
    ? ` — ${escapeHtml(status.message)}`
    : "";

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全连接语雀账号</title><style>
:root{color-scheme:light;--ink:#14251a;--muted:#5c6c62;--jade:#176c3a;--jade-dark:#0e4f2a;--jade-soft:#eaf5ed;--mist:#f3f7f3;--line:#d8e3da;--amber:#8a5100;--amber-soft:#fff5dc;--white:#fff;--shadow:0 24px 70px rgba(18,58,31,.12)}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;min-height:100vh;padding:32px 18px 48px;background:radial-gradient(circle at 12% 0,rgba(92,174,115,.15),transparent 30rem),linear-gradient(180deg,#f8fbf8 0%,#eef5ef 100%);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
button{font:inherit}.shell{width:min(920px,100%);margin:0 auto;background:rgba(255,255,255,.96);border:1px solid rgba(202,218,206,.9);border-radius:24px;box-shadow:var(--shadow);overflow:hidden}.hero{padding:34px 38px 24px}.eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:14px;color:var(--jade);font-size:13px;font-weight:700;letter-spacing:.08em}.lock-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--jade);color:#fff;font-size:11px;letter-spacing:0}.hero h1{margin:0;font-family:ui-rounded,"PingFang SC",sans-serif;font-size:clamp(28px,5vw,44px);font-weight:750;letter-spacing:-.035em}.hero p{max-width:670px;margin:14px 0 0;color:var(--muted);font-size:16px;line-height:1.75}
.security{margin:0 38px 18px;padding:22px;border:1px solid #bdd7c4;border-radius:18px;background:linear-gradient(135deg,#edf8f0,#f8fcf9)}.security-head{display:flex;gap:14px;align-items:flex-start}.security-badge{flex:0 0 auto;padding:6px 10px;border-radius:8px;background:var(--jade-dark);color:#fff;font-size:12px;font-weight:700}.security h2{margin:1px 0 5px;font-size:18px}.security p{margin:0;color:var(--muted);line-height:1.65}.security-list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0 0;padding:0;list-style:none}.security-list li{position:relative;padding:12px 12px 12px 31px;border:1px solid rgba(183,211,191,.8);border-radius:12px;background:rgba(255,255,255,.72);color:#31513c;font-size:13px;line-height:1.55}.security-list li::before{content:"✓";position:absolute;left:12px;color:var(--jade);font-weight:800}
.warning{display:flex;gap:14px;align-items:flex-start;margin:0 38px 20px;padding:15px 17px;border:1px solid #efcf83;border-left:4px solid #d18a00;border-radius:12px;background:var(--amber-soft);color:#694006}.warning-mark{display:grid;place-items:center;flex:0 0 auto;width:24px;height:24px;border-radius:50%;background:#f1b637;color:#4c2e00;font-weight:800}.warning strong,.warning span{display:block}.warning strong{margin-bottom:4px;font-size:15px}.warning span{font-size:13px;line-height:1.6}
.status-line{display:flex;align-items:center;gap:9px;margin:0 38px 14px;color:var(--muted);font-size:14px}.status-dot{width:9px;height:9px;border-radius:50%;background:#43a764;box-shadow:0 0 0 5px rgba(67,167,100,.12)}#notice{min-height:1.5em;margin:0 38px 4px;color:var(--muted);font-size:14px}.flow{padding:0 38px 32px}.providers{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.provider,.refresh-qr{min-height:44px;padding:10px 19px;border:1px solid #a9bdad;border-radius:12px;background:#fff;color:#284a34;cursor:pointer;font-weight:650;transition:transform .16s ease,background .16s ease,border-color .16s ease}.provider:hover:not(:disabled),.refresh-qr:hover:not(:disabled){transform:translateY(-1px);border-color:var(--jade)}.provider:focus-visible,.refresh-qr:focus-visible{outline:3px solid rgba(23,108,58,.22);outline-offset:2px}.provider.active{border-color:var(--jade);background:var(--jade);color:#fff}.provider:disabled,.refresh-qr:disabled{opacity:.55;cursor:not-allowed}.qr-actions{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 16px}.qr-actions span{color:var(--muted);font-size:13px;line-height:1.5}.refresh-qr{flex:0 0 auto;border-color:var(--jade);color:var(--jade)}.screen-wrap{margin:0;overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--mist)}.screen-wrap img{display:block;width:100%;min-height:220px;height:auto;object-fit:contain;user-select:none}.screen-wrap figcaption{padding:12px 15px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;line-height:1.55}
.success{margin:6px 38px 36px;padding:48px 28px;text-align:center;border:1px solid #b9dcc3;border-radius:20px;background:linear-gradient(160deg,#f3fbf5,#e8f6ec)}.success-mark{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 20px;border-radius:50%;background:var(--jade);color:#fff;font-size:34px;font-weight:800;box-shadow:0 12px 30px rgba(23,108,58,.22)}.success-kicker{margin:0 0 6px;color:var(--jade);font-size:13px;font-weight:750;letter-spacing:.08em}.success h2{margin:0;font-size:clamp(24px,5vw,36px);letter-spacing:-.025em}.success-copy{margin:12px auto 0;max-width:520px;color:var(--muted);line-height:1.7}.footer{display:flex;justify-content:space-between;gap:20px;padding:17px 38px;border-top:1px solid var(--line);background:#fbfdfb;color:#69786e;font-size:12px;line-height:1.6}.footer strong{color:#3b5142}
@media(max-width:680px){body{padding:12px 10px 30px}.shell{border-radius:18px}.hero{padding:26px 20px 18px}.security,.warning,.status-line,#notice,.success{margin-left:20px;margin-right:20px}.security{padding:17px}.security-head{display:block}.security-badge{display:inline-block;margin-bottom:10px}.security-list{grid-template-columns:1fr}.flow{padding:0 20px 24px}.provider{flex:1 1 130px}.qr-actions{align-items:stretch;flex-direction:column}.refresh-qr{width:100%}.success{padding:38px 18px}.footer{display:block;padding:15px 20px}.footer span{display:block;margin-top:4px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body data-login-state="${status.state}">
<main class="shell">
<header class="hero"><div class="eyebrow"><span class="lock-mark" aria-hidden="true">AES</span><span>一次性安全登录页</span></div><h1>连接你的语雀账号</h1><p>选择对应的手机应用扫描语雀官方二维码。本次连接只绑定当前账号，不会与其他用户共享登录凭证。</p></header>
<section class="security" aria-labelledby="security-title"><div class="security-head"><span class="security-badge">隐私与加密安全</span><div><h2 id="security-title">登录信息只保存在当前账号的独立加密空间</h2><p>扫码完成后，Cookie、CSRF 和账号摘要会使用 AES-256-GCM 加密保存，不会在此页面展示明文凭证。</p></div></div><ul class="security-list"><li>每个账号的登录数据相互隔离</li><li>二维码和页面链接均为一次性凭证</li><li>保存成功后立即关闭临时浏览器</li></ul></section>
<aside class="warning" role="note"><span class="warning-mark" aria-hidden="true">!</span><div><strong>只支持已注册的账号进行扫描登录</strong><span>未注册账号扫码后可能被要求绑定手机号并输入短信验证码，请先在语雀完成账号注册，再返回此页面扫码。</span></div></aside>
<p id="status" class="status-line" role="status" aria-live="polite"><span class="status-dot" aria-hidden="true"></span><span>状态：${stateLabels[status.state]}${statusMessage}</span></p>
<p id="notice" aria-live="polite"></p>
<section id="login-flow" class="flow"${success ? " hidden" : ""}><nav class="providers" aria-label="选择扫码方式">${providerButtons}</nav><div class="qr-actions"><span>二维码加载失败或失效时，可在链接有效期内重新生成。</span><button id="refresh-qr" class="refresh-qr" type="button">刷新二维码</button></div><figure class="screen-wrap"><img id="screen" draggable="false" src="/login/${encodedCode}/image" alt="语雀官方扫码页面"><figcaption>请仅使用你自己的设备扫码。不要把二维码、截图或此页面链接转发给其他人。</figcaption></figure></section>
<section id="success-panel" class="success" role="status"${success ? "" : " hidden"}><div class="success-mark" aria-hidden="true">✓</div><p class="success-kicker">登录完成</p><h2>已成功登录，可关闭此页面</h2><p class="success-copy">登录信息已经加密保存，临时浏览器已关闭。后续文档操作不需要保持此页面打开。</p></section>
<footer class="footer"><strong>登录页有效期至 ${escapeHtml(expiresAt)}</strong><span>如果不是你发起的登录，请直接关闭页面。</span></footer>
</main>
<script>
const base='/login/${encodedCode}';const screen=document.getElementById('screen');const refreshButton=document.getElementById('refresh-qr');const notice=document.getElementById('notice');const statusElement=document.getElementById('status');const loginFlow=document.getElementById('login-flow');const successPanel=document.getElementById('success-panel');const stateLabels={starting:'正在准备安全登录',waiting_scan:'等待扫码',success:'登录成功',expired:'登录页已过期',failed:'登录失败'};let switching=false;let refreshing=false;let imageFailures=0;let imageRetryTimer;let statusTimer;let lastImageReload=Date.now();
function reloadImage(){if(document.body.dataset.loginState==='success'||document.body.dataset.loginState==='expired')return;lastImageReload=Date.now();screen.src=base+'/image?t='+Date.now()}
function applyStatus(state,message){document.body.dataset.loginState=state;statusElement.lastElementChild.textContent='状态：'+(stateLabels[state]||state)+(message?' — '+message:'');const complete=state==='success';loginFlow.hidden=complete;successPanel.hidden=!complete;refreshButton.disabled=complete||state==='expired';document.querySelectorAll('[data-provider]').forEach(button=>button.disabled=switching||refreshing||state!=='waiting_scan');if(complete){notice.textContent='';if(statusTimer)clearInterval(statusTimer)}else if(state==='expired'){notice.textContent=message||'链接已过期，请返回智能体重新发起登录。';if(statusTimer)clearInterval(statusTimer)}else if(state==='failed'){notice.textContent=(message||'二维码生成失败。')+' 可点击“刷新二维码”重试。'}}
async function selectProvider(provider){if(switching||refreshing)return;switching=true;applyStatus(document.body.dataset.loginState,'正在切换扫码方式…');try{const r=await fetch(base+'/provider',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider})});if(!r.ok){notice.textContent=r.status===409?'登录页暂时不可切换，请稍后重试。':'扫码方式未被接受。';return}document.querySelectorAll('[data-provider]').forEach(button=>{const active=button.dataset.provider===provider;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});notice.textContent='已切换，请使用对应应用扫码。';reloadImage()}catch{notice.textContent='无法连接本地登录服务。'}finally{switching=false;applyStatus(document.body.dataset.loginState,'')}}
async function refreshQr(){if(refreshing||document.body.dataset.loginState==='expired'||document.body.dataset.loginState==='success')return;refreshing=true;refreshButton.disabled=true;notice.textContent='正在重新生成二维码…';try{const r=await fetch(base+'/refresh',{method:'POST'});if(!r.ok){notice.textContent=r.status===410?'链接已过期，请返回智能体重新发起登录。':'二维码暂未准备好，请稍后再试。';return}imageFailures=0;applyStatus('waiting_scan','');notice.textContent='二维码已刷新，请重新扫码。';reloadImage()}catch{notice.textContent='无法连接本地登录服务。'}finally{refreshing=false;applyStatus(document.body.dataset.loginState,'')}}
screen.addEventListener('load',()=>{imageFailures=0;if(imageRetryTimer)clearTimeout(imageRetryTimer)});screen.addEventListener('error',()=>{imageFailures+=1;notice.textContent='二维码尚未加载，正在自动重试…';if(imageRetryTimer)clearTimeout(imageRetryTimer);imageRetryTimer=setTimeout(reloadImage,Math.min(1000*imageFailures,5000))});
document.querySelectorAll('[data-provider]').forEach(button=>button.addEventListener('click',()=>selectProvider(button.dataset.provider)));refreshButton.addEventListener('click',refreshQr);
applyStatus('${status.state}','${escapeJavaScriptString(status.message ?? "")}');if('${status.state}'!=='success'&&'${status.state}'!=='expired'){statusTimer=setInterval(async()=>{try{const r=await fetch(base+'/status',{cache:'no-store'});if(!r.ok)return;const s=await r.json();applyStatus(s.state,s.message||'');if(!switching&&!refreshing&&(s.state==='starting'||s.state==='waiting_scan')&&Date.now()-lastImageReload>10000)reloadImage()}catch{}},1500)}
</script></body></html>`;
}

async function readAccount(page: Page): Promise<YuqueAccount | undefined> {
  const value = await page.evaluate(() => {
    const appData = (
      window as unknown as { appData?: { me?: Record<string, unknown> } }
    ).appData;
    const me = appData?.me;
    if (!me?.id || !me.login) return undefined;
    return {
      id: String(me.id),
      login: String(me.login),
      name: me.name ? String(me.name) : undefined,
    };
  });
  return value as YuqueAccount | undefined;
}

async function readCsrf(
  page: Page,
  cookies: Array<{ name: string; value: string }>,
): Promise<string | undefined> {
  const cookie = cookies.find((entry) =>
    /(^|_)(csrf|ctoken)/i.test(entry.name),
  );
  if (cookie?.value) return cookie.value;
  return page
    .locator('meta[name="csrf-token"]')
    .getAttribute("content")
    .then((value) => value ?? undefined)
    .catch(() => undefined);
}

function toToughCookieJson(cookie: {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}): Record<string, unknown> {
  return {
    key: cookie.name,
    value: cookie.value,
    domain: cookie.domain.replace(/^\./, ""),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expires > 0
      ? { expires: new Date(cookie.expires * 1000).toISOString() }
      : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite.toLowerCase() } : {}),
    hostOnly: !cookie.domain.startsWith("."),
    creation: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
  };
}

function toStatus(attempt: LoginAttempt): LoginStatus {
  return {
    state: attempt.state,
    loginId: attempt.loginId,
    expiresAt: attempt.expiresAt.toISOString(),
    ...(attempt.account ? { account: attempt.account } : {}),
    ...(attempt.message ? { message: attempt.message } : {}),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function escapeJavaScriptString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
}
