# -*- coding: utf-8 -*-
"""UI 验收：图片头像（我的 / 顶栏 / 消息 / 成员面板）+ Agent 外链头像 + 回退"""
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
  const imgs = Array.from(document.querySelectorAll('img.avatar__img'))
  const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0)
  const external = imgs.filter((i) => /^https:\/\//.test(i.getAttribute('src') || ''))
  const media = imgs.filter((i) => /\/media\//.test(i.getAttribute('src') || ''))
  return {
    avatarImgs: imgs.length,
    loaded: loaded.length,
    external: external.length,
    media: media.length,
    topnav: document.querySelectorAll('.topnav .avatar__img').length,
    messages: document.querySelectorAll('.msg .avatar__img').length,
    members: document.querySelectorAll('.member-row .avatar__img').length,
    sample: imgs.slice(0, 3).map((i) => (i.getAttribute('src') || '').slice(0, 60)),
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
            viewport={"width": 430, "height": 932},
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
        page.wait_for_timeout(1200)

        # 顶栏：登录返回的 me 就应带头像（不需要刷新）
        out["topnavAfterLogin"] = page.evaluate("() => document.querySelectorAll('.topnav .avatar__img').length")

        # 聊天页
        items = page.locator(".conv__item")
        for i in range(items.count()):
            if "AI 圆桌" in (items.nth(i).inner_text() or ""):
                items.nth(i).click()
                break
        page.wait_for_selector(".msg", timeout=30000)
        page.wait_for_timeout(2000)
        out["chat"] = page.evaluate(EVAL)
        page.screenshot(path=os.path.join(SHOTS, "74-avatar-chat.png"))

        # 成员面板
        page.click("button[aria-label='查看成员']")
        page.wait_for_selector(".members", timeout=20000)
        page.wait_for_timeout(1200)
        out["members"] = page.evaluate(EVAL)
        page.screenshot(path=os.path.join(SHOTS, "75-avatar-members.png"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # 我的页：手机端聊天详情会藏底栏，先返回会话列表
        page.click("button[aria-label='返回会话列表']")
        page.wait_for_timeout(500)
        page.click(".tabbar button:has-text('我的')")
        page.wait_for_selector(".me", timeout=20000)
        page.wait_for_timeout(1200)
        out["me"] = page.evaluate(EVAL)
        out["meBlock"] = page.evaluate(
            "() => { const el = document.querySelector('.me-profile__avatar'); return el ? { imgs: el.querySelectorAll('img.avatar__img').length, text: el.innerText.slice(0, 20) } : null }"
        )
        out["overflow"] = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
        page.screenshot(path=os.path.join(SHOTS, "76-avatar-me.png"))

        if errs:
            problems.append("页面 JS 异常：" + json.dumps(errs[:3], ensure_ascii=False))
        if out["topnavAfterLogin"] < 1:
            problems.append("顶栏头像没出图（登录返回的 me 仍缺 avatarUrl？）")
        if out["chat"].get("messages", 0) < 1:
            problems.append("聊天消息里没有图片头像")
        if out["chat"].get("external", 0) < 1:
            problems.append("聊天里没有外链头像（Agent 的）")
        if out["members"].get("members", 0) < 1:
            problems.append("成员面板里没有图片头像")
        if not out["meBlock"] or out["meBlock"].get("imgs", 0) < 1:
            problems.append("「我的」页头像没出图")
        if out["overflow"] > 1:
            problems.append(f"页面横向溢出 {out["overflow"]}px")

        ctx.close()
        browser.close()

    print(json.dumps(out, ensure_ascii=False, indent=2))
    if problems:
        print("\nAVATAR UI CHECK FAILED")
        for x in problems:
            print(" -", x)
        return 1
    print("\nAVATAR UI CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
