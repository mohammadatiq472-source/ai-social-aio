# -*- coding: utf-8 -*-
"""验收：AI 头像不再有外圈；只留右下角一个小「AI」字"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
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
  const list = Array.from(document.querySelectorAll('.avatar--ai'))
  return list.slice(0, 6).map((el) => {
    const cs = getComputedStyle(el)
    const tag = el.querySelector('.avatar__ai')
    const tcs = tag ? getComputedStyle(tag) : null
    const r = el.getBoundingClientRect()
    const tr = tag ? tag.getBoundingClientRect() : null
    return {
      ring: cs.boxShadow,
      tagText: tag ? tag.textContent : null,
      tagFontSize: tcs ? tcs.fontSize : null,
      tagBg: tcs ? tcs.backgroundColor : null,
      tagBorder: tcs ? tcs.borderTopWidth : null,
      // 角标中心应落在头像右下象限
      tagInBottomRight: !!(tr && tr.left + tr.width / 2 > r.left + r.width / 2 && tr.top + tr.height / 2 > r.top + r.height / 2),
      avatarSize: Math.round(r.width),
    }
  })
}
"""


def main():
    problems = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 430, "height": 932}, device_scale_factor=2, locale="zh-CN")
        page = ctx.new_page()
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
        page.wait_for_timeout(1800)
        # 找一条 AI 消息
        page.evaluate("() => { const m = document.querySelectorAll('.msg--ai'); if (m.length) m[m.length-1].scrollIntoView({block:'center'}) }")
        page.wait_for_timeout(600)
        boxes = page.evaluate(EVAL)
        page.screenshot(path=os.path.join(SHOTS, "81-avatar-ai-tag.png"))

        if not boxes:
            problems.append("页面上没找到 AI 头像")
        for x in boxes:
            if x["ring"] not in ("none", "", None):
                problems.append(f"AI 头像仍有外圈：{x['ring']}")
            if x["tagText"] != "AI":
                problems.append("角标文字不是 AI")
            if x["tagFontSize"] not in ("8.5px",):
                problems.append(f"角标字号偏大：{x['tagFontSize']}")
            if x["tagBorder"] not in ("0px", "0"):
                problems.append(f"角标仍有边框：{x['tagBorder']}")
            if not x["tagInBottomRight"]:
                problems.append("角标不在头像右下角")

        print(json.dumps({"boxes": boxes, "problems": problems}, ensure_ascii=False, indent=2))
        ctx.close()
        b.close()

    if problems:
        print("\nAI AVATAR TAG CHECK FAILED")
        return 1
    print("\nAI AVATAR TAG CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
