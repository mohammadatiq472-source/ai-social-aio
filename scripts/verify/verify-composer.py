# -*- coding: utf-8 -*-
"""Composer 回归：文本发送 / 加号面板 / 图片 / 语音（假麦克风）。

用法：python scripts/verify/verify-composer.py
前置：demo 账号；Chromium 用 --use-fake-device-for-media-stream 提供假麦克风。
"""
import os
import sys
import time

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

# 1x1 PNG
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63fcffff3f030005fe02fea72d5c1e0000000049454e44ae426082"
)


def png_path():
    path = os.path.join(ROOT, "tmp", "composer-test.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(PNG * 400)  # 约 30KB，避免 <64 字节被判无效
    return path


def login(page):
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("input[type=email]", timeout=30000)
    page.fill("input[type=email]", EMAIL)
    page.fill("input[type=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_selector(".conv__item", timeout=30000)


def open_group(page):
    items = page.locator(".conv__item")
    for i in range(items.count()):
        if "AI 圆桌" in (items.nth(i).inner_text() or ""):
            items.nth(i).click()
            return True
    items.nth(0).click()
    return False


def count(page, sel):
    return page.evaluate("(s) => document.querySelectorAll(s).length", sel)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    problems = []
    result = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 430, "height": 900},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            permissions=["microphone"],
        )
        page = ctx.new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        login(page)
        open_group(page)
        page.wait_for_selector(".msg, .messages", timeout=30000)
        page.wait_for_timeout(800)

        # ① 文本发送
        tag = f"composer验收{int(time.time())}"
        box = page.locator("textarea").first
        box.fill(tag)
        box.press("Enter")
        page.wait_for_timeout(1500)
        text_ok = page.evaluate("(t) => Array.from(document.querySelectorAll('.bubble__body')).some((el) => el.textContent.includes(t))", tag)
        result["text"] = text_ok
        if not text_ok:
            problems.append("文本消息没有出现在气泡里")

        # ② 加号面板
        page.click("button[aria-label^='更多功能']")
        page.wait_for_timeout(400)
        panel_open = page.evaluate("() => !!document.querySelector('.composer__panel--open')")
        items = page.evaluate("() => Array.from(document.querySelectorAll('.composer__panel-item .composer__panel-label')).map((e) => e.innerText)")
        result["panel"] = {"open": panel_open, "items": items}
        if not panel_open:
            problems.append("加号面板没有展开")
        for want in ["相册", "拍摄", "语音", "视频", "表情"]:
            if want not in items:
                problems.append(f"加号面板缺少「{want}」")
        page.screenshot(path=os.path.join(SHOTS, "85-composer-panel.png"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        # ③ 图片（隐藏 input 直接投文件）
        before_img = count(page, ".msg__image, .msg__image img")
        page.set_input_files("input[accept='image/*']", png_path())
        page.wait_for_timeout(2500)
        after_img = count(page, ".msg__image, .msg__image img")
        result["image"] = {"before": before_img, "after": after_img}
        if after_img <= before_img:
            problems.append("图片没有被发出（未出现 .msg__image）")

        # ④ 语音（假麦克风：点一下开始，1.5s 后再点结束）
        before_voice = count(page, ".voice, .msg__voice")
        # 手机端麦克风工具条平时隐藏：从「＋」面板的「语音」进入录制
        page.click("button[aria-label^='更多功能']")
        page.wait_for_timeout(300)
        page.locator(".composer__panel-item", has_text="语音").first.click()
        rec = False
        for _ in range(20):
            if page.locator(".composer__rec").count():
                rec = True
                break
            page.wait_for_timeout(150)
        page.wait_for_timeout(1500)
        if rec:
            page.click("button[aria-label='结束录音并发送']")
            page.wait_for_timeout(3000)
        after_voice = count(page, ".voice, .msg__voice")
        result["voice"] = {"recordingUi": rec, "before": before_voice, "after": after_voice}
        if not rec:
            problems.append("点麦克风后没有出现录音 UI（假麦克风未生效？）")
        elif after_voice <= before_voice:
            problems.append("语音没有被发出（未出现 .voice）")

        page.screenshot(path=os.path.join(SHOTS, "86-composer-result.png"))

        if page_errors:
            problems.append("页面 JS 异常：" + str(page_errors[:3]))
        ctx.close()
        browser.close()

    print(json_dumps(result))
    print("---")
    if problems:
        print("COMPOSER CHECK FAILED")
        for item in problems:
            print(" -", item)
        return 1
    print("COMPOSER CHECK PASSED")
    return 0


def json_dumps(obj):
    import json

    return json.dumps(obj, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    sys.exit(main())
