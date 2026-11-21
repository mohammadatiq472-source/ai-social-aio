# -*- coding: utf-8 -*-
"""验证：大消息（srcdoc）走紧凑帧后，客户端能自动回补并正常渲染"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
CONV = 91
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)


def http_post(path, payload, cookie=None, headers=None):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("user-agent", UA)
    if cookie:
        req.add_header("cookie", cookie)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.loads(r.read() or b"{}"), r.headers


def main():
    problems = []
    # 先用 HTTP 登录，稍后发大消息
    status, body, headers = http_post("/api/auth/login", {"email": "demo@qqmini.dev", "password": "demo-qqmini-2026"})
    cookie = "; ".join(c.split(";")[0] for c in (headers.get_all("Set-Cookie") or []))
    title = f"紧凑帧验收-{int(time.time())}"
    srcdoc = f"<html><body><h1>{title}</h1>{'<p>padding</p>' * 900}</body></html>"

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 430, "height": 932}, device_scale_factor=2, locale="zh-CN")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.fill("input[type=email]", "demo@qqmini.dev")
        page.fill("input[type=password]", "demo-qqmini-2026")
        page.click("button[type=submit]")
        page.wait_for_selector(".conv__item", timeout=30000)
        items = page.locator(".conv__item")
        for i in range(items.count()):
            if "AI 圆桌" in (items.nth(i).inner_text() or ""):
                items.nth(i).click()
                break
        page.wait_for_selector(".msg", timeout=30000)
        page.wait_for_timeout(1200)

        # 发一条 20KB srcdoc 的 HTML 消息（WS 会以紧凑帧到达）
        st, sent, _ = http_post(
            f"/api/conversations/{CONV}/messages",
            {"client_msg_id": f"compact-{int(time.time() * 1000)}", "parts": [{"type": "html", "srcdoc": srcdoc, "title": title}]},
            cookie,
        )
        print("send:", st, sent.get("accepted"), "seq=", sent.get("seq"))
        page.wait_for_timeout(2500)
        page.evaluate("() => { const m = document.querySelector('.messages'); if (m) m.scrollTop = m.scrollHeight }")
        page.wait_for_timeout(800)

        found = page.evaluate(
            """(title) => {
              const cards = Array.from(document.querySelectorAll('.rich-card--html'))
              const card = cards.find((c) => (c.innerText || '').includes(title))
              return card ? { title: card.querySelector('.rich-card__name')?.innerText || '', hasPreviewBtn: !!Array.from(card.querySelectorAll('button')).find((b) => /预览/.test(b.innerText)) } : null
            }""",
            title,
        )
        print("rendered:", found)
        if not found:
            problems.append("紧凑帧之后没有回补出 HTML 卡片")
        else:
            page.screenshot(path=os.path.join(SHOTS, "84-compact-frame.png"))
            # 点预览，确认 iframe 有 srcdoc 内容
            card = page.locator(".rich-card--html", has_text=title).last
            btn = card.locator("button", has_text="预览")
            if btn.count():
                btn.first.click()
                page.wait_for_timeout(1200)
                iframe = page.evaluate(
                    """() => { const f = Array.from(document.querySelectorAll('.rich-html__frame')).pop(); return f ? { hasSrcdoc: Boolean(f.getAttribute('srcdoc')), len: (f.getAttribute('srcdoc') || '').length } : null }"""
                )
                print("iframe:", iframe)
                if not iframe or not iframe.get("hasSrcdoc") or iframe["len"] < 10000:
                    problems.append(f"iframe 没有 srcdoc 内容：{iframe}")
        if errs:
            problems.append("页面 JS 异常：" + str(errs[:2]))
        ctx.close()
        b.close()

    print(json.dumps({"problems": problems}, ensure_ascii=False, indent=2))
    print("COMPACT CLIENT CHECK FAILED" if problems else "COMPACT CLIENT CHECK PASSED")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
