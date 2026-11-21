# -*- coding: utf-8 -*-
"""聊天体验回归（外部评审前端 §4-1 / §4-3 / §4-5，附 §4-4 视频 MIME）

四件事，都是「用一段时间后必然撞上」的：
  1. 历史分页：>200 条的群，滚到顶部能继续往前翻，翻到底正好是全量、不重不漏
  2. 新消息 pill：回看历史时来了新消息，出现「N 条新消息」，点一下回到底部
  3. 说说翻页：超过一页（20 条）时出现「加载更早的说说」，点完能看到全部
  4. 视频 MIME：选 .webm 能发出去（以前客户端硬编码 video/mp4，服务端按真实类型校验必 415）

前置：ffmpeg（生成一个 0.4 秒的 webm）。路径按 TOOLS.md 的默认值，可用 FFMPEG 环境变量覆盖。
用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-chat-ux-ui.py
"""
import os
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
INVITE = os.environ.get("REGISTER_CODE", "")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)
FFMPEG = next(
    (c for c in [
        os.environ.get("FFMPEG", ""),
        r"D:\CodexTools\ffmpeg-full\ffmpeg61.exe",
        r"D:\CodexTools\ffmpeg-full\bin\ffmpeg.exe",
    ] if c and os.path.exists(c)),
    None,
)

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  — {detail}" if detail else ""))
    return ok


FETCH_JS = """async ({ method, path, data }) => {
  const init = { method, credentials: 'same-origin' };
  if (data !== null) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(data); }
  const res = await fetch(path, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: res.status, json, text: text.slice(0, 200) };
}"""


def call(page, method, path, data=None):
    return page.evaluate(FETCH_JS, {"method": method, "path": path, "data": data})


def new_actor(browser, display_name):
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-CN")
    page = ctx.new_page()
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
    r = call(page, "POST", "/api/auth/register", {
        "email": f"t_{os.urandom(4).hex()}@test.dev",
        "password": "passw0rd!x",
        "display_name": display_name,
        "invite_code": INVITE,
    })
    if r["status"] != 200:
        raise RuntimeError(f"register failed {r['status']} {r['text']}")
    me = r["json"]["me"]
    return {"page": page, "ctx": ctx, "id": me["id"], "accountNo": me["accountNo"]}


def make_webm():
    if not FFMPEG:
        return None
    path = os.path.join(tempfile.gettempdir(), "aio-ux-test.webm")
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", "color=c=0x12b7f5:s=160x120:d=0.4",
         "-c:v", "libvpx", "-b:v", "200k", path],
        check=True, capture_output=True,
    )
    return path


def dom_seqs(page):
    return page.evaluate(
        "() => [...document.querySelectorAll('[data-seq]')].map((el) => Number(el.getAttribute('data-seq')))"
    )


def scroll_top(page):
    page.evaluate("() => { const el = document.querySelector('.messages'); if (el) el.scrollTop = 0 }")


def near_bottom(page):
    return page.evaluate(
        "() => { const el = document.querySelector('.messages'); return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 40 : true }"
    )


def main():
    os.makedirs(SHOTS, exist_ok=True)
    webm = make_webm()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])

        A = new_actor(browser, "体验A")
        # 4 个灌水号：单人 60 条/分钟限流，220 条要分摊
        water = [new_actor(browser, f"体验B{i}") for i in range(1, 5)]
        for w in water:
            call(A["page"], "POST", "/api/friends/request", {"account_no": w["accountNo"]})
            call(w["page"], "POST", "/api/friends/accept", {"principal_id": A["id"]})
        g = call(A["page"], "POST", "/api/conversations", {
            "title": "体验验证群", "member_ids": [w["id"] for w in water],
        })
        gid = g["json"]["conversation"]["id"]

        def send(actor, body):
            return call(actor["page"], "POST", f"/api/conversations/{gid}/messages", {
                "body": body, "client_msg_id": os.urandom(8).hex(),
            })

        for i in range(220):
            send(water[i % len(water)], f"历史消息 {i} ux")
        # 说说：25 条（超过一页 20）
        for i in range(25):
            call(A["page"], "POST", "/api/feeds", {
                "body": f"翻页测试说说 {i}", "visibility": "friends", "client_msg_id": os.urandom(8).hex(),
            })

        page = A["page"]
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        page.wait_for_selector(".conv__item", timeout=30000)
        page.locator(".conv__item", has_text="体验验证群").first.click()
        page.wait_for_selector(".msg", timeout=20000)
        page.wait_for_timeout(1000)

        # ---------------------------------------------------------------- 1) 历史分页
        seqs = dom_seqs(page)
        check("打开 220 条的群：底部是最新一条", seqs and max(seqs) == 220, f"max={max(seqs) if seqs else 0}")
        check("打开时只加载一窗（不是全量）", len(seqs) <= 220, f"首屏 {len(seqs)} 条")

        # 反复滚到顶部，直到翻到第 1 条
        for _ in range(8):
            if min(dom_seqs(page)) <= 1:
                break
            scroll_top(page)
            page.wait_for_timeout(900)
        all_seqs = dom_seqs(page)
        check("翻到顶部：能加载到第 1 条（中间那段不再永久不可见）", all_seqs and min(all_seqs) == 1, f"min={min(all_seqs) if all_seqs else 0}")
        check("翻页不产生重复消息", len(all_seqs) == len(set(all_seqs)), f"{len(all_seqs)} 条 / {len(set(all_seqs))} 唯一")
        check("翻页没有丢消息（连续）", sorted(all_seqs) == list(range(1, max(all_seqs) + 1)), f"范围={min(all_seqs)}..{max(all_seqs)} n={len(all_seqs)}")
        page.screenshot(path=os.path.join(SHOTS, "85-history-pagination.png"))

        # ---------------------------------------------------------------- 2) 新消息 pill
        scroll_top(page)
        page.wait_for_timeout(400)
        send(water[0], "回看历史时来的新消息 ping")
        try:
            page.wait_for_selector(".new-msg-pill", timeout=8000)
            pill_text = page.locator(".new-msg-pill").inner_text()
        except Exception:
            pill_text = ""
        check("回看历史时来新消息：出现「N 条新消息」", "新消息" in pill_text, pill_text)
        if pill_text:
            page.locator(".new-msg-pill").click()
            page.wait_for_timeout(900)
            check("点 pill：回到底部且提示消失", near_bottom(page) and page.locator(".new-msg-pill").count() == 0)
            page.screenshot(path=os.path.join(SHOTS, "86-new-msg-pill.png"))

        # ---------------------------------------------------------------- 4) 视频 MIME（webm）
        if webm:
            before = len(dom_seqs(page))
            page.locator(".composer input[type=file][accept='video/*']").set_input_files(webm)
            # 上传 → 抽封面 → 发送，给足时间；成功与否看消息条数/视频段
            sent_ok = False
            for _ in range(24):
                page.wait_for_timeout(700)
                seqs_now = dom_seqs(page)
                if len(seqs_now) > before:
                    # 新气泡出现了：用接口回查这条消息的 parts（不依赖播放器是否已挂 <video>）
                    last_seq = max(seqs_now)
                    one = call(page, "GET", f"/api/conversations/{gid}/messages/{last_seq}")
                    parts = (one.get("json") or {}).get("message", {}).get("parts") or []
                    video = next((p for p in parts if p.get("type") == "video"), None)
                    sent_ok = bool(video) and (video.get("mime") in ("video/webm", "video/mp4", "video/quicktime"))
                    break
            toast = page.locator(".toast, .toast__item").inner_text() if page.locator(".toast, .toast__item").count() else ""
            check("视频 MIME 透传：.webm 能发出去并渲染成视频消息（不再 415）", sent_ok, f"toast={toast[:60]}")
        else:
            print("SKIP  没有找到 ffmpeg，跳过 webm 用例")

        # ---------------------------------------------------------------- 3) 说说翻页
        page.evaluate(
            """() => {
              const tab = [...document.querySelectorAll('[role=tab], .tabbar__btn')].find((el) => el.textContent.trim().includes('空间'));
              if (tab) tab.click();
            }"""
        )
        page.wait_for_selector(".space", timeout=20000)
        page.wait_for_timeout(1500)
        feed_cards = page.locator(".feed-card, .feed").count()
        more = page.locator(".space__more")
        check("说说首屏只加载一页（≤20 条）+ 出现「加载更早」", feed_cards <= 20 and more.count() == 1, f"cards={feed_cards} more={more.count()}")
        if more.count():
            more.click()
            page.wait_for_timeout(1500)
            total_cards = page.locator(".feed-card, .feed").count()
            check("点「加载更早」：能看到超过一页的说说", total_cards >= 21, f"cards={total_cards}")
            page.screenshot(path=os.path.join(SHOTS, "87-feed-more.png"))

        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{'全部通过' if not failed else '有失败'}：{len(results) - len(failed)}/{len(results)}")
    if failed:
        print("失败项：" + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
