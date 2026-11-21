# -*- coding: utf-8 -*-
"""验收：群系统消息（表情包分享）在聊天页渲染成居中灰字胶囊"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）

CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

EVAL = r"""
() => {
  const nodes = Array.from(document.querySelectorAll('.sys-notice'))
  return nodes.map((n) => {
    const span = n.querySelector('span')
    const cs = span ? getComputedStyle(span) : null
    return {
      text: (n.innerText || '').trim().slice(0, 60),
      fontSize: cs ? cs.fontSize : null,
      color: cs ? cs.color : null,
      background: cs ? cs.backgroundColor : null,
      radius: cs ? cs.borderRadius : null,
      hasAvatar: !!n.querySelector('.msg__avatar-btn, .avatar'),
      hasBubble: !!n.querySelector('.bubble'),
      width: Math.round(n.getBoundingClientRect().width),
    }
  })
}
"""


def main():
    os.makedirs(SHOTS, exist_ok=True)
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 430, "height": 900},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
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
        page.evaluate("() => { const m = document.querySelector('.messages'); if (m) m.scrollTop = m.scrollHeight }")
        page.wait_for_timeout(600)
        nodes = page.evaluate(EVAL)
        page.screenshot(path=os.path.join(SHOTS, "67-sys-notice.png"))

        msgs = page.locator(".messages").first
        if msgs.count():
            msgs.screenshot(path=os.path.join(SHOTS, "68-sys-notice-messages.png"))

        if not nodes:
            problems.append("页面上没有 .sys-notice")
        for n in nodes:
            if n["fontSize"] != "12px":
                problems.append("系统消息字号 %s != 12px" % n["fontSize"])
            if n["hasAvatar"]:
                problems.append("系统消息不该带头像")
            if n["hasBubble"]:
                problems.append("系统消息不该带气泡")
        if errs:
            problems.append("页面 JS 异常：%s" % errs[:3])

        print(json.dumps({"sysNotices": nodes, "problems": problems}, ensure_ascii=False, indent=2))
        ctx.close()
        browser.close()

    if problems:
        print("\nSYSTEM NOTICE UI CHECK FAILED")
        return 1
    print("\nSYSTEM NOTICE UI CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
