# -*- coding: utf-8 -*-
"""阿里云 RPC v1.0 签名 + 常量（已验证）。"""
import base64, hashlib, hmac, json, time, uuid
import urllib.parse

VERIFY_AADUANE_ID = "111jdk439dJJIjd023823201"
VERIFY_KEY_SECRET = "222aiJodos2938JDdosko2djd82sf0"
VERIFY_VERSION = "2023-03-05"
VERIFY_ENDPOINT = "https://1buwf8.captcha-open.aliyuncs.com/"
VERIFY_VERIFY_ENDPOINT = "https://1buwf8-verify.captcha-open.aliyuncs.com/"

DEVICE_AADUANE_ID = "DuaneAprqkYsF3nt1yjK29Bf"
DEVICE_KEY_SECRET = "DuanemHmyeE6LXCC46sJEDUw5DTlSZ"
DEVICE_VERSION = "2020-10-15"
DEVICE_ENDPOINT = "https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com/"

SCENE_ID = "19tne5l5"


def percent_encode(s):
    s = urllib.parse.quote(str(s), safe='')
    s = s.replace('+', '%20').replace('*', '%2A').replace('%7E', '~')
    return s


def sign(params: dict, secret: str) -> str:
    canonical = '&'.join(
        f"{percent_encode(k)}={percent_encode(params[k])}"
        for k in sorted(params)
    )
    string_to_sign = "POST" + "&" + percent_encode("/") + "&" + percent_encode(canonical)
    sig = base64.b64encode(
        hmac.new((secret + "&").encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    return sig


def build_signed_body(params: dict, secret: str) -> str:
    p = dict(params)
    p.setdefault("SignatureMethod", "HMAC-SHA1")
    p.setdefault("SignatureVersion", "1.0")
    p.setdefault("Format", "JSON")
    p["SignatureNonce"] = str(uuid.uuid4())
    p["Signature"] = sign(p, secret)
    return urllib.parse.urlencode(p)
