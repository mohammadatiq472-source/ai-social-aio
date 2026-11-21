# -*- coding: utf-8 -*-
"""端到端：Agent 通过 MCP 发「文字 / 表情 / 外链语音 / 外链视频 / 外链文件包 / 外链 HTML」，
再用真浏览器验收渲染（沙箱 iframe、文件清单、播放器）。

用法：python tmp/verify-rich-e2e.py
前置：服务端已部署本次改动（CSP 放行 https: 外链）。
产物：docs/shots/70-rich-*.png
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
CONV = int(os.environ.get("CONV", "91"))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）

CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

ASSETS = {
    "image": "https://interactive-examples.mdn.mozilla.net/media/cc0-images/grapefruit-slice-332-332.jpg",
    "voice": "https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3",
    "video": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    "html": "https://example.com/",
    "file": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
}
TAG = os.environ.get("TAG", str(int(time.time())))

# Cloudflare 会拦 Python-urllib 默认 UA（Error 1010），带一个正常浏览器的 UA
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class Http:
    def __init__(self):
        self.cookie = None

    def post(self, path, payload, headers=None, raw=False):
        data = json.dumps(payload).encode()
        req = urllib.request.Request(BASE + path, data=data, method="POST")
        req.add_header("content-type", "application/json")
        req.add_header("accept", "application/json")
        req.add_header("user-agent", UA)
        if self.cookie:
            req.add_header("cookie", self.cookie)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode()
                if raw:
                    return resp.status, body, resp.headers
                return resp.status, json.loads(body) if body else None, resp.headers
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            if raw:
                return e.code, body, e.headers
            try:
                return e.code, json.loads(body) if body else None, e.headers
            except json.JSONDecodeError:
                return e.code, body, e.headers

    def login(self):
        status, body, headers = self.post("/api/auth/login", {"email": EMAIL, "password": PASSWORD})
        if status != 200:
            raise SystemExit(f"login failed: {status} {body}")
        cookies = headers.get_all("Set-Cookie") or []
        self.cookie = "; ".join(c.split(";")[0] for c in cookies)
        return body

    def mcp(self, token, method, params):
        data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(BASE + "/mcp", data=data, method="POST")
        req.add_header("authorization", f"Bearer {token}")
        req.add_header("content-type", "application/json")
        req.add_header("accept", "application/json")
        req.add_header("user-agent", UA)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return {"httpStatus": e.code, "body": e.read().decode()[:300]}


def mcp_call(http, token, args):
    r = http.mcp(token, "tools/call", {"name": "send_message", "arguments": args})
    res = r.get("result") or {}
    text = (res.get("content") or [{}])[0].get("text")
    try:
        parsed = json.loads(text) if text else None
    except json.JSONDecodeError:
        parsed = text
    return res.get("isError"), parsed, r


def main():
    os.makedirs(SHOTS, exist_ok=True)
    out = {"sent": [], "problems": []}
    http = Http()
    http.login()

    # 1) 造一只新 Agent 并拉进演示群
    status, body, _ = http.post("/api/agents", {"display_name": f"富内容AI{TAG[-4:]}", "unused_persona": "端到端验收"})
    if status != 200 or not body.get("token"):
        out["problems"].append(f"创建 Agent 失败：{status} {body}")
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 1
    agent_id, token = body["agent"]["id"], body["token"]
    status, body, _ = http.post(f"/api/conversations/{CONV}/members", {"principal_id": agent_id})
    out["agent"] = {"id": agent_id, "addMember": status}
    # 新 Agent 默认「只回 @」，连发会被门控拦住；验收期设成「自由回复」，仍受 15s 冷却
    status, body, _ = http.post(f"/api/conversations/{CONV}/reply-mode", {"principal_id": agent_id, "reply_mode": "high"})
    out["agent"]["replyMode"] = {"status": status, "body": body}

    http.mcp(token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}})

    # 2) 六种消息
    cases = [
        ("text", {"body": f"外链富内容验收 {TAG}：下面依次是语音、视频、图片、文件包、网页"}),
        ("sticker", {"parts": [{"type": "sticker", "pack": "deepwhale-placeholder", "key": "ok"}]}),
        ("voice", {"parts": [{"type": "voice", "url": ASSETS["voice"], "duration_ms": 4200}]}),
        ("video", {"parts": [{"type": "video", "url": ASSETS["video"], "poster_url": ASSETS["image"], "duration_ms": 30000}]}),
        ("image", {"parts": [{"type": "image", "url": ASSETS["image"], "width": 332, "height": 332, "alt": "葡萄柚"}]}),
        ("file", {"parts": [{"type": "file", "url": ASSETS["file"], "name": f"验收包-{TAG}.zip", "bytes": 13264,
                             "mime": "application/zip",
                             "files": [{"name": "README.md", "bytes": 2048}, {"name": "assets/cover.png", "bytes": 8192},
                                       {"name": "data/report.csv", "bytes": 3024}]}]}),
        ("html", {"parts": [{"type": "html", "url": ASSETS["html"], "title": f"外链网页 {TAG}", "height": 360}]}),
    ]
    for i, (kind, payload) in enumerate(cases):
        args = {"conversation_id": CONV, "client_msg_id": f"e2e-{kind}-{TAG}"}
        args.update(payload)
        if i:
            time.sleep(16)  # AI 发言冷却（high 档 15s），别把自己卡在 gating_too_fast
        err, parsed, raw = mcp_call(http, token, args)
        ok = isinstance(parsed, dict) and parsed.get("accepted") is True
        out["sent"].append({"kind": kind, "ok": ok, "seq": (parsed or {}).get("seq"), "err": None if ok else (parsed or raw)})
        if not ok:
            out["problems"].append(f"{kind} 发送失败：{parsed or raw}")

    # 3) 浏览器验收
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 430, "height": 932},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = ctx.new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("input[type=email]", timeout=30000)
        page.fill("input[type=email]", EMAIL)
        page.fill("input[type=password]", PASSWORD)
        page.click("button[type=submit]")
        page.wait_for_selector(".conv__item", timeout=30000)
        items = page.locator(".conv__item")
        for i in range(items.count()):
            if "AI 圆桌" in (items.nth(i).inner_text() or ""):
                items.nth(i).click()
                break
        page.wait_for_selector(".msg", timeout=30000)
        page.wait_for_timeout(1500)
        page.evaluate("() => { const m = document.querySelector('.messages'); if (m) m.scrollTop = m.scrollHeight }")
        page.wait_for_timeout(2500)

        checks = page.evaluate(
            r"""
            () => {
              const q = (s) => document.querySelector(s)
              const qa = (s) => Array.from(document.querySelectorAll(s))
              const ext = qa('.msg__ext-wrap')
              const img = ext.map((w) => w.querySelector('img')).filter(Boolean).pop() || q('.msg__image img')
              const fileCard = qa('.rich-card--file').pop()
              const htmlCard = qa('.rich-card--html').pop()
              const voiceBtn = (qa('.msg__ext-wrap--voice .voice').pop()) || qa('.voice').pop()
              const videoBtn = (qa('.msg__ext-wrap .msg__video').pop()) || qa('.msg__video').pop()
              return {
                extBadges: qa('.rich-card__ext').length,
                voice: voiceBtn ? { aria: voiceBtn.getAttribute('aria-label'), text: (voiceBtn.innerText || '').slice(0, 20) } : null,
                video: videoBtn ? { hasPoster: !!videoBtn.querySelector('img'), poster: videoBtn.querySelector('img')?.src || null } : null,
                image: img ? { src: img.src.slice(0, 80), natural: img.naturalWidth } : null,
                file: fileCard ? {
                  name: fileCard.querySelector('.rich-card__name')?.innerText,
                  sub: fileCard.querySelector('.rich-card__sub')?.innerText,
                  openHref: fileCard.querySelector('a.rich-card__btn')?.href || null,
                  listBtn: !!Array.from(fileCard.querySelectorAll('button')).find((b) => /清单/.test(b.innerText)),
                } : null,
                html: htmlCard ? {
                  title: htmlCard.querySelector('.rich-card__name')?.innerText,
                  sub: htmlCard.querySelector('.rich-card__sub')?.innerText,
                  previewBtn: !!Array.from(htmlCard.querySelectorAll('button')).find((b) => /预览/.test(b.innerText)),
                } : null,
              }
            }
            """
        )
        out["dom"] = checks
        page.screenshot(path=os.path.join(SHOTS, "70-rich-messages.png"))

        # 文件包清单展开
        if checks.get("file"):
            card = page.locator(".rich-card--file").last
            btn = card.locator("button", has_text="清单")
            if btn.count():
                btn.first.click()
                page.wait_for_timeout(400)
                out["fileList"] = page.evaluate(
                    "() => Array.from(document.querySelectorAll('.rich-filelist__name')).map((e) => e.innerText).slice(-6)"
                )
                page.screenshot(path=os.path.join(SHOTS, "71-rich-filelist.png"))

        # HTML 预览：sandbox iframe + 跨域拿不到我们 cookie
        if checks.get("html"):
            card = page.locator(".rich-card--html").last
            preview = card.locator("button", has_text="预览")
            if preview.count():
                preview.first.click()
                page.wait_for_timeout(3000)
                frame = page.locator(".rich-html__frame").last
                out["iframe"] = page.evaluate(
                    r"""
                    () => {
                      const f = Array.from(document.querySelectorAll('.rich-html__frame')).pop()
                      if (!f) return null
                      let cookieRead = null
                      try { cookieRead = f.contentDocument ? (f.contentDocument.cookie || '') : 'null-document' }
                      catch (e) { cookieRead = 'blocked:' + e.name }
                      return { sandbox: f.getAttribute('sandbox'), src: (f.getAttribute('src') || '').slice(0, 60),
                               height: f.getBoundingClientRect().height, cookieRead }
                    }
                    """
                )
                page.screenshot(path=os.path.join(SHOTS, "72-rich-html-preview.png"))

        # 视频点开播放
        if checks.get("video"):
            page.locator(".msg__video").last.click()
            page.wait_for_timeout(1500)
            out["videoPlayer"] = page.evaluate(
                "() => { const v = document.querySelector('.msg__video-player'); return v ? { src: (v.src||'').slice(0,60), readyState: v.readyState } : null }"
            )
            page.screenshot(path=os.path.join(SHOTS, "73-rich-video.png"))

        if page_errors:
            out["problems"].append(f"页面 JS 异常：{page_errors[:3]}")
        ctx.close()
        browser.close()

    # 4) 断言
    d = out.get("dom") or {}
    if not d.get("voice"):
        out["problems"].append("没有渲染外链语音胶囊")
    if not d.get("video") or not d["video"].get("hasPoster"):
        out["problems"].append("没有渲染外链视频（或封面缺失）")
    if not d.get("image") or not d["image"].get("natural"):
        out["problems"].append(f"外链图片没加载出来：{d.get('image')}")
    if not d.get("file") or not d["file"].get("openHref"):
        out["problems"].append(f"文件卡片不完整：{d.get('file')}")
    if not d.get("html") or not d["html"].get("previewBtn"):
        out["problems"].append(f"HTML 卡片不完整：{d.get('html')}")
    if (d.get("extBadges") or 0) < 4:
        out["problems"].append(f"「外链」小标太少：{d.get('extBadges')}")
    iframe = out.get("iframe") or {}
    if iframe:
        if "allow-same-origin" in (iframe.get("sandbox") or ""):
            out["problems"].append("iframe 允许了 allow-same-origin（危险）")
        if iframe.get("cookieRead") not in ("blocked:SecurityError", "", "null-document", None):
            out["problems"].append(f"iframe 竟然能读到本站 cookie：{iframe.get('cookieRead')}")
    else:
        out["problems"].append("点「预览」没出现 iframe")

    print(json.dumps(out, ensure_ascii=False, indent=2))
    if out["problems"]:
        print("\nRICH E2E FAILED")
        return 1
    print("\nRICH E2E PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
