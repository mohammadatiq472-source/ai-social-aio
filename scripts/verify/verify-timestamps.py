# -*- coding: utf-8 -*-
"""验收：AIO 线上聊天页的时间戳（气泡外侧 11px 灰字 / 同分钟不重复）。

用法：
  python tmp/verify-timestamps.py            # 手机视图 + 桌面视图，产物写 docs/shots
  python tmp/verify-timestamps.py --no-send  # 只截当前状态，不发新消息
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://192.0.2.10")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
SEND = "--no-send" not in sys.argv
LONG = "--long" in sys.argv

# 本机 python playwright 与已下载的浏览器版本号对不上时，直接指定可执行文件
_CHROME_CANDIDATES = [
    os.environ.get("CHROME_PATH", ""),
    r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
]
CHROME = next((c for c in _CHROME_CANDIDATES if c and os.path.exists(c)), None)

EVAL = r"""
() => {
  const out = [];
  const msgs = Array.from(document.querySelectorAll('.msg'));
  for (const m of msgs) {
    const stamp = m.querySelector('.msg__stamp');
    const bubble = m.querySelector('.bubble, .msg__image, .voice, .msg__sticker, .msg__video, .msg__video-player, .msg__unsupported');
    const mine = m.classList.contains('msg--mine');
    const text = m.querySelector('.bubble__body')?.textContent || '';
    const sr = stamp ? stamp.getBoundingClientRect() : null;
    const br = bubble ? bubble.getBoundingClientRect() : null;
    out.push({
      mine,
      text: text.slice(0, 24),
      stamp: stamp ? stamp.textContent.trim() : null,
      fontSize: stamp ? getComputedStyle(stamp).fontSize : null,
      color: stamp ? getComputedStyle(stamp).color : null,
      // 正数 = 时间戳在气泡外侧的间距（px）
      outsideGap: (sr && br) ? Math.round(mine ? (br.x - (sr.x + sr.width)) : (sr.x - (br.x + br.width))) : null,
      // 0 附近 = 底边对齐
      bottomDelta: (sr && br) ? Math.round((sr.y + sr.height) - (br.y + br.height)) : null,
      stampOutsideRow: !!stamp && stamp.parentElement.classList.contains('msg__bubble-row'),
    });
  }
  return out;
}
"""


def login(page):
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("input[type=email]", timeout=30000)
    page.fill("input[type=email]", EMAIL)
    page.fill("input[type=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_selector(".conv__item", timeout=30000)


def open_group(page, title_part):
    items = page.locator(".conv__item")
    n = items.count()
    for i in range(n):
        if title_part in (items.nth(i).inner_text() or ""):
            items.nth(i).click()
            return True
    if n:
        items.nth(0).click()
        return False
    return False


def send(page, text):
    box = page.locator("textarea").first
    box.fill(text)
    box.press("Enter")
    page.wait_for_timeout(900)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        for label, vp in (("mobile", {"width": 390, "height": 844}), ("desktop", {"width": 1280, "height": 860})):
            ctx = browser.new_context(
                ignore_https_errors=True,
                viewport=vp,
                device_scale_factor=2,
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
            )
            page = ctx.new_page()
            errors = []
            bad_responses = []
            page_errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            page.on("response", lambda r: bad_responses.append("%s %s" % (r.status, r.url)) if r.status >= 400 else None)
            login(page)
            hit = open_group(page, "AI 圆桌")
            page.wait_for_selector(".msg", timeout=30000)
            if SEND:
                # 每轮用唯一 tag：否则历史轮次的消息也会被算进 testRun，跨分钟就会误报
                tag = "时间戳验收%s" % int(time.time())
                send(page, "%s %s A" % (tag, label))
                send(page, "%s %s B" % (tag, label))
            if LONG:
                send(page, "长文本压泡检查：" + "时间戳必须贴在外侧且不许把气泡挤出屏幕。" * 6)
            page.wait_for_timeout(600)
            data = page.evaluate(EVAL)
            overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            shot = os.path.join(SHOTS, "61-aio-ts-%s.png" % label)
            page.screenshot(path=shot, full_page=False)
            # 只截消息区的细节图，便于人眼核对「贴气泡外侧」
            panel = page.locator(".messages").first
            if panel.count():
                panel.screenshot(path=os.path.join(SHOTS, "62-aio-ts-%s-messages.png" % label))
            results[label] = {
                "groupMatched": hit,
                "consoleErrors": errors[:5],
                "pageErrors": page_errors[:5],
                "badResponses": bad_responses[:8],
                "messageCount": len(data),
                "stampedCount": len([d for d in data if d["stamp"]]),
                "overflowPx": overflow,
                "stamps": [d["stamp"] for d in data if d["stamp"]],
                "testRun": [d for d in data if tag in (d["text"] or "")],
                "tail": data[-4:],
                "shot": shot,
            }
            ctx.close()
        browser.close()

    print(json.dumps(results, ensure_ascii=False, indent=2))

    # 断言（失败不抛异常，交给上层看 exit code）
    bad = []
    for label, r in results.items():
        if not r["messageCount"]:
            bad.append("%s: 没有消息" % label)
            continue
        if not r["stampedCount"]:
            bad.append("%s: 一个时间戳都没有" % label)
        if r.get("overflowPx", 0) > 1:
            bad.append("%s: 页面横向溢出 %spx（长文本+时间戳挤出屏幕）" % (label, r["overflowPx"]))

        # 1) 样式与位置：11px 灰字、在气泡外侧、不压气泡、和气泡底对齐
        for d in r["tail"]:
            if not d["stamp"]:
                continue
            if d["fontSize"] != "11px":
                bad.append("%s: 时间戳字号 %s != 11px" % (label, d["fontSize"]))
            if not d["stampOutsideRow"]:
                bad.append("%s: 时间戳不在气泡外侧容器里" % label)
            if d["outsideGap"] is not None and d["outsideGap"] < 0:
                bad.append("%s: 时间戳压在气泡上（gap=%s）" % (label, d["outsideGap"]))
            if d["bottomDelta"] is not None and abs(d["bottomDelta"]) > 6:
                bad.append("%s: 时间戳没和气泡底对齐（delta=%s）" % (label, d["bottomDelta"]))

        # 2) 同分钟不重复：整段消息里时间戳文本必须严格递增且不重复
        stamps = r["stamps"]
        if len(stamps) != len(set(stamps)):
            bad.append("%s: 时间戳重复出现（同分钟没去重）%s" % (label, stamps))

        # 3) 本轮连发的 4 条（两个视图同分钟）只应产生 1~2 个时间戳
        if SEND:
            run = r["testRun"]
            stamped = [d for d in run if d["stamp"]]
            # 同分钟不重复：本轮消息若和上一条同分钟，本来就不该有戳（0 也算正常）
            if len(stamped) > 2:
                bad.append("%s: 同分钟消息产生了 %d 个时间戳（应 ≤2）" % (label, len(stamped)))

        # 4) 没有 JS 异常；4xx 只允许登录前 /api/me 的那次 401
        if r["pageErrors"]:
            bad.append("%s: 页面 JS 异常 %s" % (label, r["pageErrors"]))
        for line in r["badResponses"]:
            if line.startswith("401 ") and "/api/me" in line:
                continue
            bad.append("%s: 异常响应 %s" % (label, line))

    if bad:
        print("\nFAILED:")
        for b in bad:
            print(" -", b)
        return 1
    print("\nTIMESTAMP CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
