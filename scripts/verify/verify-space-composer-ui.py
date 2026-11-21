# -*- coding: utf-8 -*-
"""空间互动 / 输入栏上传的「守卫」路径（2026-11-16 第二轮大组件拆分后固化）。

verify-composer 只验「能发」，verify-chat-ux-ui 只验「翻页/视频」，都不覆盖下面这些
一旦拆错就会退化的时序；本脚本把两个抽出来的 hook 的守卫钉死：

  A. useSpaceInteractions：点赞乐观切换（aria-pressed 与计数双向）、评论发表后出现在列表且计数 +1、
     评论区折叠再展开仍可见（状态缓存没有丢）
  B. useImageUpload：上传在途点取消 → 不发出消息、预览消失、共用闸被放掉（还能继续发文本）；
     上传在途切会话 → 丢弃且不回补；上传失败保留预览、点「重试」能发出

前置：本地服务 8787 + 演示账号（`node scripts/seed-demo.mjs` 可重建）。
用法：BASE=http://127.0.0.1:8787 SHOTS_DIR=tmp/shots-ci python scripts/verify/verify-space-composer-ui.py
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "tmp", "shots-ci"))
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63fcffff3f030005fe02fea72d5c1e0000000049454e44ae426082"
)
PNG_PATH = os.path.join(ROOT, "tmp", "split-smoke.png")

problems = []
passed = 0


def check(ok, label, detail=""):
    global passed
    print(("PASS  " if ok else "FAIL  ") + label + (("  — " + detail) if detail else ""))
    if ok:
        passed += 1
    else:
        problems.append(label)


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
            page.wait_for_timeout(600)
            return
    items.nth(0).click()
    page.wait_for_timeout(600)


def like_state(page):
    btn = page.locator(".feed__action").first
    return {
        "pressed": btn.get_attribute("aria-pressed") == "true",
        "label": btn.get_attribute("aria-label"),
        "text": (btn.inner_text() or "").strip(),
    }


def main():
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(os.path.dirname(PNG_PATH), exist_ok=True)
    with open(PNG_PATH, "wb") as fh:
        fh.write(PNG * 400)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN", timezone_id="Asia/Shanghai")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)

        # ---------------- A. 空间：点赞 / 评论 ----------------
        page.click(".tab:has-text('空间')")
        page.wait_for_selector(".feed", timeout=30000)
        page.wait_for_timeout(500)

        first = like_state(page)
        page.locator(".feed__action").first.click()
        page.wait_for_timeout(1200)
        second = like_state(page)
        check(first["pressed"] != second["pressed"], "点赞切换 aria-pressed 翻转", f"{first['pressed']} -> {second['pressed']}")
        # 计数必须跟着 +/-1（服务端以 res.liked 为准，这里等回调落地）
        page.wait_for_timeout(800)
        third = like_state(page)
        n_first, n_third = first["text"], third["text"]
        check(n_first != n_third, "点赞计数变化", f"{n_first} -> {n_third}")
        # 再点回去，确认双向都可用（likeBusy 正确释放）
        page.locator(".feed__action").first.click()
        page.wait_for_timeout(1500)
        back = like_state(page)
        check(back["pressed"] == first["pressed"], "取消点赞回到初始态", f"{back['pressed']}")

        # 评论：展开 → 输入 → 发送 → 出现在列表且计数 +1
        comment_btn = page.locator(".feed__action").nth(1)
        before_comment = (comment_btn.inner_text() or "").strip()
        comment_btn.click()
        page.wait_for_selector(".feed-comments__form", timeout=20000)
        tag = f"拆分冒烟{int(time.time())}"
        page.fill(".feed-comments__input", tag)
        page.click(".feed-comments__send")
        ok = False
        for _ in range(30):
            if page.evaluate(
                "(t) => Array.from(document.querySelectorAll('.feed-comment__body')).some((e) => e.textContent.includes(t))", tag
            ):
                ok = True
                break
            page.wait_for_timeout(200)
        check(ok, "评论发出后出现在评论区")
        after_comment = (page.locator(".feed__action").nth(1).inner_text() or "").strip()
        check(before_comment != after_comment, "评论计数 +1", f"{before_comment} -> {after_comment}")
        # 评论区折叠再展开：不重复拉（openIds / comments 缓存生效的可见证据 = 评论仍在）
        page.locator(".feed__action").nth(1).click()
        page.wait_for_timeout(300)
        page.locator(".feed__action").nth(1).click()
        page.wait_for_timeout(1200)
        still = page.evaluate(
            "(t) => Array.from(document.querySelectorAll('.feed-comment__body')).some((e) => e.textContent.includes(t))", tag
        )
        check(still, "评论折叠再展开仍可见（未重复拉空）")
        page.screenshot(path=os.path.join(SHOTS, "90-split-space.png"))

        # ---------------- B. 输入栏：取消在途上传 / 切会话丢弃 ----------------
        page.click(".tab:has-text('聊天')")
        open_group(page)
        page.wait_for_selector("textarea", timeout=20000)

        # 用 CDP 网络延迟造「在途」窗口：同步 API 里在 route 回调里 sleep 会把 Playwright 自己卡住
        cdp = ctx.new_cdp_session(page)
        cdp.send("Network.enable")

        def set_latency(ms):
            cdp.send("Network.emulateNetworkConditions", {
                "offline": False, "latency": ms, "downloadThroughput": -1, "uploadThroughput": -1,
            })

        # ① 在途点取消：不发出、卡片消失、闸放掉
        before_msgs = page.evaluate("() => document.querySelectorAll('.msg').length")
        set_latency(4000)
        page.set_input_files("input[accept='image/*']", PNG_PATH)
        page.wait_for_selector(".composer__upload-cancel", timeout=10000)
        page.click(".composer__upload-cancel")
        page.wait_for_timeout(300)
        set_latency(0)
        page.wait_for_timeout(5000)  # 让被取消的那次上传真的返回
        after_msgs = page.evaluate("() => document.querySelectorAll('.msg').length")
        check(after_msgs == before_msgs, "取消后图片没有被发出去", f"{before_msgs} -> {after_msgs}")
        check(page.locator(".composer__upload").count() == 0, "取消后待发卡片消失")
        tag2 = f"取消后仍可发送{int(time.time())}"
        page.fill("textarea", tag2)
        page.press("textarea", "Enter")
        page.wait_for_timeout(1500)
        sent = page.evaluate(
            "(t) => Array.from(document.querySelectorAll('.bubble__body')).some((e) => e.textContent.includes(t))", tag2
        )
        check(sent, "取消上传后闸已放掉（文本能发出）")

        # ② 上传在途切会话：内容属于旧会话，直接丢弃、不回补
        before_images = page.evaluate("() => document.querySelectorAll('.msg__image').length")
        set_latency(4000)
        page.set_input_files("input[accept='image/*']", PNG_PATH)
        page.wait_for_selector(".composer__upload-cancel", timeout=10000)
        items = page.locator(".conv__item")
        target = 0 if "AI 圆桌" not in (items.nth(0).inner_text() or "") else 1
        items.nth(target).click()
        page.wait_for_timeout(400)
        set_latency(0)
        page.wait_for_timeout(5000)
        check(page.locator(".composer__upload").count() == 0, "切会话后在途卡片被丢弃")
        open_group(page)
        page.wait_for_timeout(2000)
        after_images = page.evaluate("() => document.querySelectorAll('.msg__image').length")
        check(after_images == before_images, "切会话丢弃的上传没有被补发", f"{before_images} -> {after_images}")

        # 失败保留预览 + 重试：让上传直接失败
        def fail_route(route):
            route.fulfill(status=500, body='{"error":"boom"}', content_type="application/json")

        page.route("**/api/attachments", fail_route)
        page.set_input_files("input[accept='image/*']", PNG_PATH)
        failed = False
        for _ in range(40):
            if page.locator(".composer__upload-title:has-text('图片上传失败')").count():
                failed = True
                break
            page.wait_for_timeout(150)
        check(failed, "上传失败后保留卡片并提示失败")
        check(page.locator(".composer__upload-btn:has-text('重试')").count() == 1, "失败卡片带「重试」按钮")
        # 重试成功
        page.unroute("**/api/attachments")
        before_retry = page.evaluate("() => document.querySelectorAll('.msg__image').length")
        page.click(".composer__upload-btn:has-text('重试')")
        page.wait_for_timeout(3000)
        after_retry = page.evaluate("() => document.querySelectorAll('.msg__image').length")
        check(after_retry > before_retry, "点重试后图片发出", f"{before_retry} -> {after_retry}")
        check(page.locator(".composer__upload").count() == 0, "重试成功后卡片消失")
        page.screenshot(path=os.path.join(SHOTS, "91-split-composer.png"))

        if errors:
            check(False, "页面 JS 异常", str(errors[:3]))
        ctx.close()
        browser.close()

    print("---")
    total = passed + len(problems)
    if problems:
        print(f"有失败：{passed}/{total}")
        for item in problems:
            print(" -", item)
        sys.exit(1)
    print(f"全部通过：{passed}/{total}")


main()
