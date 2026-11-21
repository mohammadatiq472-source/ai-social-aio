# -*- coding: utf-8 -*-
"""验收：视频上传进度条 + 取消 + 失败重试（真机浏览器 + CDP 限速）。

用法：python tmp/verify-video-upload.py
产物：docs/shots/63-video-progress.png、64-video-retry.png
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
BIG = os.path.join(ROOT, "tmp", "test-big.mp4")
SMALL = os.path.join(ROOT, "tmp", "test-small.mp4")

CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

CARD = ".composer__upload--video"
BAR = CARD + " [role=progressbar]"


def throttle(cdp, up_bps: int, latency_ms: int = 40):
    cdp.send(
        "Network.emulateNetworkConditions",
        {
            "offline": False,
            "latency": latency_ms,
            "downloadThroughput": 4 * 1024 * 1024,
            "uploadThroughput": up_bps,
            "connectionType": "cellular3g",
        },
    )


def offline(cdp, on: bool):
    cdp.send(
        "Network.emulateNetworkConditions",
        {
            "offline": on,
            "latency": 20,
            "downloadThroughput": 1024 * 1024,
            "uploadThroughput": 512 * 1024,
            "connectionType": "wifi" if not on else "none",
        },
    )


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


def video_message_count(page):
    return page.evaluate("() => document.querySelectorAll('.msg__video, .msg__video-player').length")


def main():
    os.makedirs(SHOTS, exist_ok=True)
    result = {"steps": []}
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
        cdp = ctx.new_cdp_session(page)
        cdp.send("Network.enable")
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        login(page)
        open_group(page)
        page.wait_for_selector(".msg", timeout=30000)
        before = video_message_count(page)

        # ---------- ① 进度条：3G 上传限速，18MB 视频 ----------
        throttle(cdp, 400 * 1024)
        page.set_input_files("input[accept='video/*']", BIG)
        page.wait_for_selector(CARD, timeout=15000)
        samples = []
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                val = page.get_attribute(BAR, "aria-valuenow")
                title = page.inner_text(CARD + " .composer__upload-title")
            except Exception:
                val, title = None, ""
            if val is not None:
                samples.append((time.time(), int(val), title))
            if val is not None and int(val) >= 5:
                break
            if page.locator(CARD + " .composer__upload-cancel").count() == 0:
                break
            page.wait_for_timeout(250)
        page.screenshot(path=os.path.join(SHOTS, "63-video-progress.png"))
        result["steps"].append({"step": "progress", "samples": samples[:12], "card": True})
        if not samples:
            problems.append("进度条没有出现或没有 aria-valuenow")
        elif max(s[1] for s in samples) < 5:
            problems.append("进度没走动：%s" % samples)

        # ---------- ② 取消：点 ✕，卡片消失且不发消息 ----------
        page.click(CARD + " .composer__upload-cancel")
        page.wait_for_timeout(800)
        if page.locator(CARD).count() != 0:
            problems.append("取消后卡片还在")
        if video_message_count(page) != before:
            problems.append("取消后仍然发出了视频消息")
        result["steps"].append({"step": "cancel", "cardGone": page.locator(CARD).count() == 0})

        # ---------- ③ 失败 + 重试 ----------
        offline(cdp, True)
        page.set_input_files("input[accept='video/*']", SMALL)
        page.wait_for_selector(CARD, timeout=15000)
        failed = False
        for _ in range(60):
            txt = page.inner_text(CARD).replace("\n", " ")
            if "失败" in txt:
                failed = True
                break
            page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SHOTS, "64-video-retry.png"))
        retry_visible = page.locator(CARD + " .composer__upload-btn").count() > 0
        result["steps"].append({"step": "failed", "failed": failed, "retryButton": retry_visible})
        if not failed:
            problems.append("断网后没有出现「视频上传失败」")
        if not retry_visible:
            problems.append("失败后没有「重试」按钮")

        offline(cdp, False)
        if retry_visible:
            page.click(CARD + " .composer__upload-btn")
            ok = False
            deadline = time.time() + 40
            while time.time() < deadline:
                if video_message_count(page) > before:
                    ok = True
                    break
                if page.locator(CARD).count() == 0:
                    break
                page.wait_for_timeout(400)
            result["steps"].append({"step": "retry", "sent": ok, "videos": video_message_count(page)})
            if not ok:
                problems.append("点了重试没有把视频发出去")

        if page_errors:
            problems.append("页面 JS 异常: %s" % page_errors[:3])
        result["problems"] = problems
        ctx.close()
        browser.close()

    print(json.dumps(result, ensure_ascii=False, indent=2))
    if problems:
        print("\nVIDEO UPLOAD CHECK FAILED")
        return 1
    print("\nVIDEO UPLOAD CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
