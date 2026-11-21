# -*- coding: utf-8 -*-
"""验收「我的 → 邀请朋友」卡片（邀请制）。

覆盖：
1. 顶部「剩余名额 N / 共 M」；
2. 已有有效码：只显示掩码 AIO-XXXX-****-****、没有「复制旧码」入口，吊销走 ConfirmDialog；
3. 没有有效码：默认人数 = min(remaining,100)，创建后明文**只显示一次**（刷新后消失）+「复制邀请码」；
4. 邀请人列表 / 空态「还没有人通过你的邀请加入」；
5. 吊销后回到可创建状态，且「创建/吊销都不改变剩余名额」；页面无 JS 异常、手机端无横向溢出。

为什么只查「明文出现一次」：服务端只存哈希，GET 永远只有 codePrefix；
本脚本只断言明文格式，**不打印、不截图**明文态，避免邀请码进日志/截图库。

为什么断言名额不变：quota.used 只在「被邀请人真的注册成功」时 +1，创建/吊销码都不扣也不退。
如果哪天有人把吊销实现成「退回名额」，用户就能靠反复重建刷名额——这里提前把语义钉死。

用法：
    BASE=http://127.0.0.1:8787 SHOTS_DIR=tmp/shots-ci python scripts/verify/verify-invites-ui.py
    （无图形环境时可用 CHROME_PATH 指定本机 Chrome；CLEANUP=0 保留新建的码不吊销）

注意：会以 demo 账号真实创建并（默认）吊销一个邀请码；
demo 账号名额为 0 时只验证禁用态，不创建。
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = "demo@qqmini.dev"
PASSWORD = "demo-qqmini-2026"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))
CHROME = next(
    (
        c
        for c in [
            os.environ.get("CHROME_PATH", ""),
            r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
        ]
        if c and os.path.exists(c)
    ),
    None,
)
CLEANUP = os.environ.get("CLEANUP", "1") == "1"

problems = []


def expect(cond, message):
    print(("ok   " if cond else "FAIL ") + message)
    if not cond:
        problems.append(message)


def login(page):
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("input[type=email]", timeout=30000)
    page.fill("input[type=email]", EMAIL)
    page.fill("input[type=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_selector(".conv__item", timeout=30000)


def goto_me(page):
    tab = page.locator(".tabbar button:has-text('我的')")
    if not tab.is_visible():
        tab = page.locator(".topnav .tabs button:has-text('我的')")
    tab.click()
    page.wait_for_selector(".me-profile", timeout=20000)
    page.wait_for_selector(".invite", timeout=20000)


def read_remaining(page):
    """读「剩余名额 N / 共 M」里的 N；读不到返回 -1（断言会失败并暴露原因）。"""
    text = page.locator(".invite__quota").inner_text()
    m = re.search(r"剩余名额\s*(\d+)\s*/\s*共\s*(\d+)", text)
    return int(m.group(1)) if m else -1


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 430, "height": 932},
            device_scale_factor=2,
            locale="zh-CN",
        )
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        login(page)
        goto_me(page)
        page.wait_for_timeout(1000)
        card = page.locator(".invite")
        text = card.inner_text()
        print("CARD:", text.replace("\n", " | ")[:400])

        # 1) 名额文案
        quota_text = page.locator(".invite__quota").inner_text()
        expect(re.search(r"剩余名额\s*(\d+)\s*/\s*共\s*(\d+)", quota_text) is not None, "顶部显示「剩余名额 N / 共 M」")
        remaining = read_remaining(page)

        # 2) 已有有效码：只给掩码 + 吊销（不能复制旧码）
        if page.locator(".invite__code").count():
            prefix = page.locator(".invite__prefix").inner_text().strip()
            expect(bool(re.fullmatch(r"AIO-[A-Z0-9]{4}-\*{4}-\*{4}", prefix)), "已有码显示掩码 AIO-XXXX-****-****")
            expect(page.locator("button:has-text('复制旧码')").count() == 0, "没有「复制旧码」这类不可用入口")
            expect(page.locator("button:has-text('吊销邀请码')").count() == 1, "已有码提供「吊销邀请码」")
            page.click("button:has-text('吊销邀请码')")
            page.wait_for_selector(".modal", timeout=5000)
            expect(page.locator(".modal .btn--danger").count() >= 1, "吊销走 ConfirmDialog 二次确认")
            page.click(".modal button:has-text('吊销')")
            page.wait_for_selector(".invite__form", timeout=12000)
            page.wait_for_timeout(700)

        # 3) 创建 → 明文只显示一次
        if remaining > 0:
            expect(page.locator(".invite__form").count() == 1, "没有有效码时显示创建表单")
            number = page.locator(".invite__row input[type=number]")
            expect(number.input_value() == str(min(remaining, 100)), "邀请人数默认 = min(剩余名额,100)")
            number.fill("1")
            page.fill(".invite__row input[type=text]", "自动化验证")
            card.screenshot(path=os.path.join(SHOTS, "invite-form.png"))
            page.click("button:has-text('生成邀请码')")
            page.wait_for_selector(".invite .token-box__value, .invite .invite__error", timeout=20000)
            page.wait_for_timeout(600)
            if page.locator(".invite .invite__error").count() and not page.locator(".invite .token-box__value").count():
                # 常见原因：并发验证把名额/限流用完。把服务端 message 带进失败原因，别只报一个超时。
                problems.append("创建邀请码失败：" + page.locator(".invite .invite__error").inner_text())
            else:
                plain = page.locator(".invite .token-box__value").inner_text().strip()
                expect(bool(re.fullmatch(r"AIO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}", plain)), "创建成功后显示明文邀请码")
                expect("只显示这一次" in page.locator(".invite .token-box__warn").inner_text(), "明文旁提示「只显示一次」")
                expect(page.locator("button:has-text('复制邀请码')").count() == 1, "明文提供「复制邀请码」按钮")
                expect(page.locator(".invite__prefix").count() == 1, "创建后卡片同时显示掩码")
                # 名额只在被邀请人注册成功时扣减：建码不扣
                expect(read_remaining(page) == remaining, "创建邀请码不扣名额（remaining 不变）")

                # 刷新后明文必须消失（库里只有哈希）
                page.reload(wait_until="domcontentloaded")
                page.wait_for_selector(".conv__item", timeout=30000)
                goto_me(page)
                page.wait_for_timeout(1500)
                expect(page.locator(".invite .token-box__value").count() == 0, "刷新后明文不再出现（只显示一次）")
                expect(page.locator(".invite__prefix").count() == 1, "刷新后仍能看到掩码")
                expect(
                    "完整邀请码只在创建时显示一次" in page.locator(".invite").inner_text(),
                    "卡片说明「之后无法再查看」",
                )
                card.screenshot(path=os.path.join(SHOTS, "invite-active.png"))

                if CLEANUP:
                    page.click("button:has-text('吊销邀请码')")
                    page.wait_for_selector(".modal", timeout=5000)
                    page.click(".modal button:has-text('吊销')")
                    page.wait_for_selector(".invite__form", timeout=12000)
                    page.wait_for_timeout(900)
                    expect(page.locator(".invite__code").count() == 0, "吊销后回到可创建状态")
                    # 吊销只作废未用次数，不退回名额（否则能靠反复重建刷名额）
                    expect(read_remaining(page) == remaining, "吊销不退回名额（remaining 不变）")
        else:
            expect("邀请名额已用完" in text, "没有名额时说明「邀请名额已用完」")
            expect(page.locator(".invite button:has-text('生成邀请码')").is_disabled(), "没有名额时禁用创建按钮")

        # 4) 邀请人列表：真实列表或空态
        expect(page.locator(".invite__section-title").count() == 1, "有「通过你的邀请加入」列表区")
        if not page.locator(".invite__item").count():
            expect("还没有人通过你的邀请加入" in page.locator(".invite").inner_text(), "空态文案正确")

        expect(not errs, "页面无 JS 异常")
        expect(page.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 1, "手机端无横向溢出")
        browser.close()

    if problems:
        print("\nINVITES UI CHECK FAILED")
        for x in problems:
            print(" -", x)
        return 1
    print("\nINVITES UI CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
