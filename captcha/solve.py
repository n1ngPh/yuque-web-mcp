#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""语雀登录 阿里云滑块 侧车（DrissionPage headless 版）。

统一入口，供 Node 侧通过子进程调用。子命令均把 JSON 写到 stdout、退出码 0/1：

  python3 solve.py captcha              -> {ok, captchaVerifyParam, certifyId, securityToken, cookie, ctoken}
  python3 solve.py send_sms <phone>     -> 过滑块后 POST /api/validation_codes 发短信 -> {ok, status, body}
  python3 solve.py login <phone> <code> -> 过滑块后 POST /api/accounts/login -> {ok, account, cookies, csrfToken, ...}

链路：浏览器原生 InitCaptchaV3 拿 certifyId + deviceToken（certifyId 只能浏览器拿，
纯 HTTP Init 会被 TLS 指纹标记返回 F001）；之后纯 HTTP 用 track_gen 轨迹 + gen.js 加密
data 调 VerifyCaptchaV3（Verify 不校验 TLS 指纹，可纯 HTTP）。

环境变量：
  CAPTCHA_PROXY        HTTP(S) 代理出口（如 http://127.0.0.1:7897）；缺省直连
  CHROME_BROWSER_PATH  真实 Chrome/Chromium 可执行文件路径；缺省 DrissionPage 自动探测
"""
import base64
import email.utils
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie

from DrissionPage import ChromiumPage, ChromiumOptions

from sig_util import SCENE_ID, VERIFY_AADUANE_ID, VERIFY_KEY_SECRET, VERIFY_VERSION, VERIFY_VERIFY_ENDPOINT, build_signed_body
import track_gen

LOGIN_URL = ("https://www.yuque.com/login?register_with_scene=true&defaultType=org"
             "&register_from=official_website_top_button:_about")
VALIDATION_CODES_ENDPOINT = "https://www.yuque.com/api/validation_codes"
LOGIN_ENDPOINT = "https://www.yuque.com/api/accounts/login"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
# 兼容 Node 侧 optionalProxyUrl 归一化后带尾斜杠的形式（http://host:port/），
# DrissionPage/urllib 的代理参数不接受尾斜杠。
PROXY = os.environ.get("CAPTCHA_PROXY", "").strip().rstrip("/")
NODE = ["node", os.path.dirname(os.path.abspath(__file__)) + "/node_harness/gen.js"]
MAX_RETRY = 3
SI = "1440,1440,900,1440,900,980,900,70.6713780918728,1442"
# 默认直连；当 InitCaptchaV3 被 TLS 指纹 / 出口 IP 标记（拿不到 CertifyId）或
# VerifyCaptchaV3 无有效结果时，属风控拦截，提示切换出口代理重试。
PROXY_HINT = "；可能被风控拒绝，建议设置 CAPTCHA_PROXY（或 YUQUE_HTTPS_PROXY）切换到干净的出口代理后重试"


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.exit(code)


def opener():
    if PROXY:
        return urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    return urllib.request.build_opener()


def post(url, params, secret):
    body = build_signed_body(params, secret)
    req = urllib.request.Request(url, data=body.encode(), method="POST",
                                 headers={"User-Agent": UA,
                                          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                                          "Referer": "https://www.yuque.com/", "Origin": "https://www.yuque.com"})
    return json.loads(opener().open(req, timeout=25).read())


def post_json(url, obj, cookie, ctoken):
    raw = json.dumps(obj, separators=(",", ":"))
    headers = {"User-Agent": UA, "Content-Type": "application/json",
               "Referer": "https://www.yuque.com/login", "Origin": "https://www.yuque.com",
               "Accept": "application/json", "X-Requested-With": "XMLHttpRequest",
               "Cookie": cookie, "x-csrf-token": ctoken}
    req = urllib.request.Request(url, data=raw.encode(), method="POST", headers=headers)
    try:
        resp = opener().open(req, timeout=25)
        return resp.status, resp.read().decode("utf-8", "replace"), resp.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), e.headers.get_all("Set-Cookie") or []


def build_data(nc):
    import random
    rand16 = "".join(random.choice("0123456789abcdefghijklmnopqrstuvwxyz") for _ in range(16))
    nc["arg"] = subprocess.run(NODE + ["arg", rand16], capture_output=True, text=True).stdout.strip()
    gen = json.loads(subprocess.run(NODE + ["data", json.dumps(nc, separators=(",", ":"))],
                                    capture_output=True, text=True).stdout.strip())
    return gen["data"]


def normalize_cookie(c):
    """把 CDP 原始 cookie 转成 Playwright 兼容结构（供 TS 端 toToughCookieJson 复用）。"""
    expires = c.get("expires")
    try:
        expires = int(float(expires))
    except (TypeError, ValueError):
        expires = -1
    return {
        "name": c.get("name", ""),
        "value": c.get("value", ""),
        "domain": c.get("domain", ""),
        "path": c.get("path", "/"),
        "expires": expires,
        "httpOnly": bool(c.get("httpOnly", False)),
        "secure": bool(c.get("secure", False)),
        "sameSite": c.get("sameSite") or "",
    }


def parse_set_cookies(headers):
    """把 Set-Cookie 响应头解析成与 normalize_cookie 一致的结构。"""
    out = []
    for header in headers:
        sc = SimpleCookie()
        try:
            sc.load(header)
        except Exception:
            continue
        for morsel in sc.values():
            max_age = morsel.get("max-age", "")
            expires_str = morsel.get("expires", "")
            expires = -1
            if str(max_age).lstrip("-").isdigit():
                expires = int(time.time()) + int(max_age)
            elif expires_str:
                try:
                    expires = int(email.utils.parsedate_to_datetime(expires_str).timestamp())
                except Exception:
                    expires = -1
            ss = (morsel.get("samesite", "") or "").lower()
            out.append({
                "name": morsel.key,
                "value": morsel.value,
                "domain": morsel.get("domain", ""),
                "path": morsel.get("path", "/"),
                "expires": expires,
                "httpOnly": bool(morsel.get("httponly", False)),
                "secure": bool(morsel.get("secure", False)),
                "sameSite": {"strict": "Strict", "lax": "Lax", "none": "None"}.get(ss, ""),
            })
    return out


def merge_cookies(browser_cookies, set_cookies):
    merged = {c["name"]: c for c in browser_cookies}
    for c in set_cookies:
        merged[c["name"]] = c
    return list(merged.values())


def browser_capture():
    """DrissionPage 打开登录页，采集 certifyId + deviceToken + cookie + yuque_ctoken。"""
    co = ChromiumOptions()
    co.set_user_agent(UA)
    if PROXY:
        co.set_proxy(PROXY)
    browser_path = os.environ.get("CHROME_BROWSER_PATH", "").strip()
    if browser_path:
        co.set_browser_path(browser_path)
    co.set_argument('--disable-blink-features=AutomationControlled')
    co.set_argument('--window-size=1440,900')
    co.headless(True)

    # 每次都用独立临时 profile，避免复用上次登录残留的 _yuque_session，
    # 导致打开 /login 被重定向到 /dashboard 而拿不到滑块。
    profile_dir = tempfile.mkdtemp(prefix="yuque-captcha-")
    co.set_user_data_path(profile_dir)

    page = ChromiumPage(co)
    try:
        page.listen.start('captcha-open.aliyuncs.com')
        page.get(LOGIN_URL)
        page.ele('#aliyunCaptcha-sliding-slider', timeout=20)
        time.sleep(2.5)

        certify_id = None
        init_error = ""
        for _ in range(60):
            pk = page.listen.wait(count=1, timeout=1)
            if not pk:
                continue
            try:
                postdata = str(pk.request.postData or '')
            except Exception:
                postdata = ''
            if 'InitCaptchaV3' in postdata:
                try:
                    body = pk.response.body
                    if isinstance(body, dict) and body.get('CertifyId'):
                        certify_id = body['CertifyId']
                        break
                    if isinstance(body, dict):
                        # 无 CertifyId 时记录风控错误码（如 F001），用于上报提示。
                        init_error = body.get('Code') or body.get('Message') or json.dumps(body, ensure_ascii=False)
                except Exception:
                    pass

        device_token = page.run_js("""
          var t = window.um && window.um.getToken ? window.um.getToken() : null;
          if (t) return t;
          var z = window.z_um && window.z_um.getToken ? window.z_um.getToken() : null;
          return z;
        """)

        raw_cookies = list(page.cookies(all_info=True))
        cookies = [normalize_cookie(c) for c in raw_cookies]
        ctoken = ""
        for c in cookies:
            if c["name"] == "yuque_ctoken":
                ctoken = c["value"]
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
        return certify_id, device_token, cookie_str, ctoken, cookies, init_error
    finally:
        page.quit()
        shutil.rmtree(profile_dir, ignore_errors=True)


def http_verify(certify_id, device_token):
    for attempt in range(1, MAX_RETRY + 1):
        drag = track_gen.gen_drag()
        start = int(time.time() * 1000) - drag["duration_ms"] - 50
        now = int(time.time() * 1000)
        tl = dict(drag["tracklist"])
        tl["startTime"] = start
        tl["si"] = SI
        nc = {"TrackList": tl, "TrackStartTime": start, "VerifyTime": now}
        data = build_data(nc)

        param = {"sceneId": SCENE_ID, "certifyId": certify_id, "deviceToken": device_token, "data": data}
        r5 = post(VERIFY_VERIFY_ENDPOINT, {"AaduaneId": VERIFY_AADUANE_ID,
                                           "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                           "Version": VERIFY_VERSION, "Action": "VerifyCaptchaV3", "SceneId": SCENE_ID,
                                           "CertifyId": certify_id,
                                           "CaptchaVerifyParam": json.dumps(param, separators=(",", ":"))},
                  VERIFY_KEY_SECRET)
        result = r5.get("Result") or {}
        if result.get("VerifyResult"):
            res_certify = result.get("certifyId") or certify_id
            token = result.get("securityToken")
            out = {"certifyId": res_certify, "sceneId": SCENE_ID, "isSign": True, "securityToken": token}
            cp = base64.b64encode(json.dumps(out, separators=(",", ":")).encode()).decode()
            return res_certify, token, cp, result
        time.sleep(0.5)
    return None, None, None, result


def cmd_captcha():
    certify_id, device_token, cookie_str, ctoken, _, init_error = browser_capture()
    if not certify_id or not device_token:
        emit({"ok": False, "error": "capture failed: 未获取到 certifyId/deviceToken" +
              (("（" + init_error + "）") if init_error else "") + PROXY_HINT}, 1)
    res_certify, token, cp, _ = http_verify(certify_id, device_token)
    if not cp:
        emit({"ok": False, "error": "verify failed: VerifyCaptchaV3 未返回有效结果" + PROXY_HINT}, 1)
    emit({"ok": True, "captchaVerifyParam": cp, "certifyId": res_certify,
          "securityToken": token, "cookie": cookie_str, "ctoken": ctoken})


def cmd_send_sms(phone):
    certify_id, device_token, cookie_str, ctoken, _, init_error = browser_capture()
    if not certify_id or not device_token:
        emit({"ok": False, "error": "capture failed: 未获取到 certifyId/deviceToken" +
              (("（" + init_error + "）") if init_error else "") + PROXY_HINT}, 1)
    _, _, cp, _ = http_verify(certify_id, device_token)
    if not cp:
        emit({"ok": False, "error": "verify failed: VerifyCaptchaV3 未返回有效结果" + PROXY_HINT}, 1)
    status, txt, _ = post_json(VALIDATION_CODES_ENDPOINT,
                               {"target": phone, "action": "login", "channel": "sms",
                                "captchaVerifyParam": cp, "captchaVersion": "v2", "captcha": "true"},
                               cookie_str, ctoken)
    emit({"ok": status == 200, "status": status, "body": txt})


def cmd_login(phone, code):
    certify_id, device_token, cookie_str, ctoken, browser_cookies, init_error = browser_capture()
    if not certify_id or not device_token:
        emit({"ok": False, "error": "capture failed: 未获取到 certifyId/deviceToken" +
              (("（" + init_error + "）") if init_error else "") + PROXY_HINT}, 1)
    _, _, cp, _ = http_verify(certify_id, device_token)
    if not cp:
        emit({"ok": False, "error": "verify failed: VerifyCaptchaV3 未返回有效结果" + PROXY_HINT}, 1)
    status, txt, set_cookie_headers = post_json(LOGIN_ENDPOINT,
                                                {"login": phone, "code": code,
                                                 "csessionid": None, "sig": None, "token": None, "scene": None,
                                                 "captchaVerifyParam": cp, "captchaVersion": "v2", "captcha": "true",
                                                 "loginType": "sms"},
                                                cookie_str, ctoken)

    account = None
    try:
        data = json.loads(txt).get("data") or {}
        user = data.get("user")
        if user and user.get("id") is not None and user.get("login"):
            account = {
                "id": str(user.get("id")),
                "login": str(user.get("login")),
                "name": user.get("name") if user.get("name") is not None else None,
            }
    except Exception:
        account = None

    set_cookies = parse_set_cookies(set_cookie_headers)
    cookies = merge_cookies(browser_cookies, set_cookies)

    emit({"ok": status == 200 and account is not None,
          "status": status, "body": txt,
          "account": account, "cookies": cookies, "csrfToken": ctoken})


def main():
    args = sys.argv[1:]
    if not args:
        emit({"ok": False, "error": "usage: solve.py <captcha|send_sms|login> [args]"}, 1)
    cmd = args[0]
    try:
        if cmd == "captcha":
            cmd_captcha()
        elif cmd == "send_sms":
            cmd_send_sms(args[1])
        elif cmd == "login":
            cmd_login(args[1], args[2])
        else:
            emit({"ok": False, "error": "unknown command: " + cmd}, 1)
    except IndexError:
        emit({"ok": False, "error": "missing argument for " + cmd}, 1)
    except Exception as e:
        emit({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 1)


if __name__ == "__main__":
    main()
