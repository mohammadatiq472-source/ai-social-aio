# -*- coding: utf-8 -*-
"""验收：300 人成员面板虚拟化（DOM 只挂可视区，滚动仍然到得了最后一行）"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
GROUP = os.environ.get("GROUP", "压测 300 人")

CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

MEASURE = r"""
() => {
  const list = document.querySelector('.members__list--virtual')
  const scroll = document.querySelector('.members__scroll')
  const slots = document.querySelectorAll('.member-row-slot')
  const rows = document.querySelectorAll('.member-row')
  return {
    listHeight: list ? Math.round(list.getBoundingClientRect().height) : null,
    slotCount: slots.length,
    rowCount: rows.length,
    scrollHeight: scroll ? scroll.scrollHeight : null,
    clientHeight: scroll ? scroll.clientHeight : null,
    firstVisible: slots.length ? slots[0].innerText.replace(/\n/g, ' ').slice(0, 18) : null,
    lastVisible: slots.length ? slots[slots.length - 1].innerText.replace(/\n/g, ' ').slice(0, 18) : null,
    totalInDom: document.querySelectorAll('*').length,
  }
}
"""


def main():
    os.makedirs(SHOTS, exist_ok=True)
    problems = []
    out = {}
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
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("input[type=email]", timeout=30000)
        page.fill("input[type=email]", EMAIL)
        page.fill("input[type=password]", PASSWORD)
        page.click("button[type=submit]")
        page.wait_for_selector(".conv__item", timeout=30000)

        items = page.locator(".conv__item")
        opened = False
        for i in range(items.count()):
            if GROUP in (items.nth(i).inner_text() or ""):
                items.nth(i).click()
                opened = True
                break
        out["opened300"] = opened
        if not opened:
            problems.append("会话列表里找不到压测群")

        page.wait_for_selector(".msg, .messages", timeout=20000)
        page.click("button[aria-label='查看成员']")
        page.wait_for_selector(".members__list--virtual", timeout=30000)
        page.wait_for_timeout(800)

        top = page.evaluate(MEASURE)
        out["top"] = top
        page.screenshot(path=os.path.join(SHOTS, "65-members-virtual-top.png"))

        # 滚到底
        page.evaluate("() => { const s = document.querySelector('.members__scroll'); s.scrollTop = s.scrollHeight }")
        page.wait_for_timeout(700)
        bottom = page.evaluate(MEASURE)
        out["bottom"] = bottom
        page.screenshot(path=os.path.join(SHOTS, "66-members-virtual-bottom.png"))

        # 断言
        if top["listHeight"] is None:
            problems.append("没有虚拟列表")
        else:
            row_h = top["listHeight"] / max(1, 300) if top["listHeight"] else 0
            out["rowHeight"] = round(row_h, 1)
            if not (30 <= row_h <= 90):
                problems.append("行高异常：%s px" % row_h)
        if top["slotCount"] > 60:
            problems.append("虚拟列表挂了太多行：%s" % top["slotCount"])
        if top["slotCount"] < 5:
            problems.append("虚拟列表行数太少：%s" % top["slotCount"])
        # 滚到底：编号要进入 2xx/3xx 区间，且 DOM 行数依然很少
        texts = page.evaluate(
            "() => Array.from(document.querySelectorAll('.member-row-slot')).map((el) => el.innerText.replace(/\\n/g, ' '))"
        )
        deep = [t for t in texts if "压测成员 2" in t or "压测成员 3" in t]
        out["bottomTexts"] = texts[:3] + ["…"] + texts[-3:]
        if not deep:
            problems.append("滚到底没看到 200/300 号段的成员：%s" % texts[-3:])
        if bottom["slotCount"] > 60:
            problems.append("滚到底后 DOM 行数又涨回去了：%s" % bottom["slotCount"])
        if page_errors:
            problems.append("页面 JS 异常：%s" % page_errors[:3])
        out["problems"] = problems
        ctx.close()
        browser.close()

    print(json.dumps(out, ensure_ascii=False, indent=2))
    if problems:
        print("\nMEMBER PANEL CHECK FAILED")
        return 1
    print("\nMEMBER PANEL CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
