# -*- coding: utf-8 -*-
"""验收「点头像换图 + 恢复默认」交互，以及桌面端我的页布局"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = "demo@qqmini.dev"
PASSWORD = "demo-qqmini-2026"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
IMG = os.path.join(ROOT, "tmp", "avatar-human.jpg")

CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)


def login(page):
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("input[type=email]", timeout=30000)
    page.fill("input[type=email]", EMAIL)
    page.fill("input[type=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_selector(".conv__item", timeout=30000)


def goto_me(page):
    """手机端点底部 Tab，桌面端点顶部 Tab（两者互斥）"""
    tab = page.locator(".tabbar button:has-text('我的')")
    if not tab.is_visible():
        tab = page.locator(".topnav .tabs button:has-text('我的')")
    tab.click()
    page.wait_for_selector(".me-profile", timeout=20000)
    page.wait_for_timeout(400)


def probe(page):
    return page.evaluate(
        r"""
        () => {
          const box = document.querySelector('.me-profile__avatar')
          const img = box ? box.querySelector('img.avatar__img') : null
          const reset = document.querySelector('.me-account__reset')
          return {
            hasImg: !!img,
            loaded: !!img && img.complete && img.naturalWidth > 0,
            src: img ? (img.getAttribute('src') || '').slice(0, 40) : null,
            resetVisible: !!reset,
            cards: document.querySelectorAll('.me-card').length,
            meta: (document.querySelector('.me-meta') || {}).innerText || null,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          }
        }
        """
    )


def main():
    problems = []
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True, viewport={"width": 430, "height": 932}, device_scale_factor=2, locale="zh-CN")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        login(page)
        goto_me(page)
        out["before"] = probe(page)

        # 点头像应该弹文件选择
        with page.expect_file_chooser(timeout=8000) as fc:
            page.click(".me-profile__avatar")
        chooser = fc.value
        out["fileChooser"] = bool(chooser)
        chooser.set_files(IMG)
        page.wait_for_timeout(2500)
        out["afterUpload"] = probe(page)
        page.screenshot(path=os.path.join(SHOTS, "77-me-avatar-interaction.png"))

        # 恢复默认
        if out["afterUpload"]["resetVisible"]:
            page.click(".me-account__reset")
            page.wait_for_timeout(1800)
        out["afterReset"] = probe(page)
        page.screenshot(path=os.path.join(SHOTS, "78-me-avatar-reset.png"))

        # 桌面端布局
        ctx2 = browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900}, device_scale_factor=1, locale="zh-CN")
        page2 = ctx2.new_page()
        login(page2)
        goto_me(page2)
        page2.wait_for_timeout(800)
        out["desktop"] = probe(page2)
        page2.screenshot(path=os.path.join(SHOTS, "79-me-desktop.png"))

        if errs:
            problems.append("页面 JS 异常：" + json.dumps(errs[:3], ensure_ascii=False))
        if not out["fileChooser"]:
            problems.append("点头像没有触发文件选择")
        if not out["afterUpload"]["hasImg"] or not out["afterUpload"]["loaded"]:
            problems.append("上传后头像没换图")
        if out["afterUpload"]["cards"] > 3:
            problems.append(f"我的页卡片仍太多：{out['afterUpload']['cards']}")
        if out["afterReset"]["hasImg"]:
            problems.append("恢复默认后仍显示图片头像")
        if out["afterReset"]["resetVisible"]:
            problems.append("恢复默认后按钮没隐藏")
        if out["desktop"]["overflow"] > 1:
            problems.append(f"桌面端横向溢出 {out['desktop']['overflow']}px")

        ctx.close()
        ctx2.close()
        browser.close()

    print(json.dumps(out, ensure_ascii=False, indent=2))
    if problems:
        print("\nME AVATAR UX CHECK FAILED")
        for x in problems:
            print(" -", x)
        return 1
    print("\nME AVATAR UX CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
