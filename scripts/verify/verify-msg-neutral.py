# -*- coding: utf-8 -*-
"""验收：消息区去紫、去「由谁创建」、AI 气泡与普通气泡一致、短消息气泡贴合内容"""
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
  const aiRows = Array.from(document.querySelectorAll('.msg--ai'))
  const humanRows = Array.from(document.querySelectorAll('.msg:not(.msg--ai)'))
  const aiBubble = aiRows.length ? aiRows[aiRows.length - 1].querySelector('.bubble') : null
  const humanBubble = humanRows.length ? humanRows.find((r) => !r.classList.contains('msg--mine'))?.querySelector('.bubble') : null
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const b1 = cs(aiBubble)
  const b2 = cs(humanBubble)
  const ownerNodes = document.querySelectorAll('.msg__owner')
  const badges = document.querySelectorAll('.msg .ai-badge')
  return {
    aiBubble: b1 ? { border: b1.borderTopWidth + ' ' + b1.borderTopColor, bg: b1.backgroundColor, radius: b1.borderTopLeftRadius } : null,
    humanBubble: b2 ? { border: b2.borderTopWidth + ' ' + b2.borderTopColor, bg: b2.backgroundColor, radius: b2.borderTopLeftRadius } : null,
    ownerLines: ownerNodes.length,
    nameBadges: badges.length,
    avatarTags: document.querySelectorAll('.msg .avatar__ai').length,
    anyPurple: (() => {
      const bad = []
      const isPurple = (c) => /124, 77, 255|7c4dff/i.test(c)
      document.querySelectorAll('.msg, .msg *').forEach((el) => {
        const s = getComputedStyle(el)
        for (const k of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'boxShadow']) {
          if (isPurple(s[k])) { bad.push(el.className + ':' + k); break }
        }
      })
      return bad.slice(0, 5)
    })(),
    // 气泡贴合度：气泡宽度不应明显大于文字宽度（一行短消息）
    shortBubble: (() => {
      const rows = Array.from(document.querySelectorAll('.msg:not(.msg--ai) .bubble'))
      const el = rows.find((b) => (b.innerText || '').trim().length <= 6)
      if (!el) return null
      const text = el.innerText.trim()
      return { text, bubbleWidth: Math.round(el.getBoundingClientRect().width), chars: text.length }
    })(),
  }
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
        page.wait_for_timeout(1600)
        page.evaluate("() => { const m = document.querySelectorAll('.msg--ai'); if (m.length) m[m.length-1].scrollIntoView({block:'center'}) }")
        page.wait_for_timeout(600)
        out = page.evaluate(EVAL)
        page.screenshot(path=os.path.join(SHOTS, "82-msg-neutral.png"))

        if out["ownerLines"]:
            problems.append(f"还有 {out['ownerLines']} 条「由谁创建」")
        if out["nameBadges"]:
            problems.append(f"名字后还有 {out['nameBadges']} 个 AI 徽标")
        if out["avatarTags"] < 1:
            problems.append("头像上的 AI 小字没了")
        if out["anyPurple"]:
            problems.append("消息区仍有紫色：" + json.dumps(out["anyPurple"], ensure_ascii=False))
        if out["aiBubble"] and out["humanBubble"]:
            if out["aiBubble"]["bg"] != out["humanBubble"]["bg"]:
                problems.append(f"AI 气泡底色仍不同：{out['aiBubble']['bg']} vs {out['humanBubble']['bg']}")
            if out["aiBubble"]["border"].split()[1] != out["humanBubble"]["border"].split()[1]:
                problems.append(f"AI 气泡描边颜色仍不同：{out['aiBubble']['border']} vs {out['humanBubble']['border']}")
        short = out.get("shortBubble")
        if short and short["bubbleWidth"] > 220:
            problems.append(f"短消息气泡偏宽：{short}")

        print(json.dumps({"out": out, "problems": problems}, ensure_ascii=False, indent=2))
        ctx.close()
        b.close()

    if problems:
        print("\nMESSAGE NEUTRAL CHECK FAILED")
        return 1
    print("\nMESSAGE NEUTRAL CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
