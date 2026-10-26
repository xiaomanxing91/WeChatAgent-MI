#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端测试：生成语音 -> 通过 hook 直接发到指定会话

用法:
  python test_voice_send.py <wxid_or_groupid> ["文本"] [--voice zh-CN-XiaoxiaoNeural]

会：
 1. 调 wechat_voice.py 生成 SILK（落到 state/generated-voices）
 2. 直接 POST /SendVoiceMsg 到 hook（用 native-token）
 3. 打印返回
"""
import sys, os, json, argparse, urllib.request, subprocess

WS = r"C:\Users\star\AppData\Roaming\WeChatAgent\workspace"
PYEXE = r"C:\Users\star\AppData\Local\Python\pythoncore-3.14-64\python.exe"


def gen_voice(text, voice):
    script = os.path.join(WS, "scripts", "wechat_voice.py")
    out = subprocess.run([PYEXE, script, text, "--voice", voice],
                         capture_output=True, text=True, timeout=180)
    line = (out.stdout or "").strip().splitlines()[-1] if out.stdout else ""
    try:
        return json.loads(line)
    except Exception:
        return {"ok": False, "error": "gen failed: " + (out.stdout or "")[-300:] + (out.stderr or "")[-300:]}


def read_token():
    p = os.path.join(WS, "state", "hook", "native-token.txt")
    return open(p, encoding="utf-8").read().strip()


def post_voice(target, path, duration, token, account):
    body = json.dumps({"wxidorgid": target, "path": path, "duration": duration, "test": True}).encode()
    req = urllib.request.Request("http://127.0.0.1:30001/SendVoiceMsg", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + token,
                 "X-WeChatAgent-Account": account})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, "%s: %s" % (type(e).__name__, e)


def health(token):
    req = urllib.request.Request("http://127.0.0.1:30001/WeChatAgent/health",
        headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("text", nargs="?", default="测试语音，我是风栖。")
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    ap.add_argument("--account", default="")
    a = ap.parse_args()

    token = read_token()
    print("== health ==")
    h = health(token)
    print(json.dumps(h, ensure_ascii=False)[:400])
    account = a.account or (h.get("databaseAccounts") or [""])[0]
    print("account:", account)

    print("== 生成语音 ==")
    g = gen_voice(a.text, a.voice)
    print(json.dumps(g, ensure_ascii=False))
    if not g.get("ok"):
        sys.exit(1)

    print("== 发送 ==")
    st, body = post_voice(a.target, g["path"], g["duration"], token, account)
    print("HTTP", st, body)


if __name__ == "__main__":
    main()
