# -*- coding: utf-8 -*-
"""消息搜索 UI 回归：搜索框 → 结果面板 → 点结果跳到那条消息（含补拉老消息）。

为什么要有这一条：
  后端 verify-search.mjs 验的是接口契约，但「点结果能不能真的滚到那条」是前端两段逻辑拼起来的
  （ChatView.onSearchPick → useChatStream.loadAroundSeq → MessageList.jumpSeq），
  接口全绿也可能没接上。这里用真浏览器点一遍。

做法：
  1. 每个测试账号一个独立的浏览器上下文（cookie 各自独立），**用页面内 fetch 造数**
     —— 不用 Playwright 的 APIRequestContext：它（undici）在 http://127.0.0.1 上会丢掉
     生产下发的 Secure cookie，而 Chrome 认为 localhost 可信、会保存。这样同一个脚本能跑
     本机 dev、SSH 隧道进生产、公网 https 三种入口。
  2. 造 1 个群 242 条消息（5 个灌水号分摊，避开单人 60 条/分钟限流）
  3. 在会话列表的搜索框里搜「早期消息」，断言结果面板出现、群名正确、关键词高亮
  4. 点第一条结果，断言切到该群且目标那条被高亮（.msg--flash）
  5. 搜别人群的独有词，断言「没有找到匹配的消息」
  6. 242 条消息的群：打开后就该看到最新那条（列表拉取不能只停在旧窗口）
  7. 手机视口（390×844）返回列表再搜一次，确认结果面板整宽可用

用法：
  BASE=http://127.0.0.1:8787 python scripts/verify/verify-search-ui.py          # 本机 dev
  BASE=https://chat.example.com REGISTER_CODE=… python scripts/verify/verify-search-ui.py
  可选：CHROME_PATH=… / NAV_TIMEOUT_MS=… / SLOW=1
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
INVITE = os.environ.get("REGISTER_CODE", "")
NAV_TIMEOUT = int(os.environ.get("NAV_TIMEOUT_MS", "120000"))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
SLOW = os.environ.get("SLOW") == "1"
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  — {detail}" if detail else ""))
    return ok


def slow(page, ms=400):
    if SLOW:
        time.sleep(ms / 1000)


FETCH_JS = """async ({ method, path, data }) => {
  const init = { method, credentials: 'same-origin' };
  if (data !== null) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(data);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}"""


def call(page, method, path, data=None):
    return page.evaluate(FETCH_JS, {"method": method, "path": path, "data": data})


def new_actor(browser, display_name):
    """独立上下文 + 注册；返回 {page, ctx, id, accountNo}"""
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-CN")
    page = ctx.new_page()
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
    email = f"t_{os.urandom(4).hex()}@test.dev"
    r = call(page, "POST", "/api/auth/register", {
        "email": email,
        "password": "passw0rd!x",
        "display_name": display_name,
        "invite_code": INVITE,
    })
    if r["status"] != 200:
        raise RuntimeError(f"register failed {r['status']} {r['text']}")
    me = r["json"]["me"]
    return {"page": page, "ctx": ctx, "id": me["id"], "accountNo": me["accountNo"], "email": email}


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox", "--disable-dev-shm-usage"])

        # ---------------------------------------------------------------- 造数据
        water = [new_actor(browser, f"搜索UI-B{i}") for i in range(1, 6)]
        b = water[0]
        a = new_actor(browser, "搜索UI-A")
        # 建群只能拉好友：A 逐个加好友，对方接受
        for w in water:
            call(a["page"], "POST", "/api/friends/request", {"account_no": w["accountNo"]})
            call(w["page"], "POST", "/api/friends/accept", {"principal_id": a["id"]})

        g = call(a["page"], "POST", "/api/conversations", {
            "title": "搜索UI群", "member_ids": [w["id"] for w in water],
        })
        if g["status"] != 200:
            raise RuntimeError(f"create group failed {g['status']} {g['text']}")
        gid = g["json"]["conversation"]["id"]
        # 别人的群：B 自己建，A 不在里面
        g2 = call(b["page"], "POST", "/api/conversations", {"title": "别人的搜索群", "member_ids": []})
        gid2 = g2["json"]["conversation"]["id"]

        def send(page, conv, body):
            r = call(page, "POST", f"/api/conversations/{conv}/messages", {
                "body": body, "client_msg_id": os.urandom(8).hex(),
            })
            if r["status"] != 200:
                raise RuntimeError(f"send failed {r['status']} {r['text']}")
            return r["json"]

        tok = os.urandom(4).hex()
        send(b["page"], gid2, f"别人的独特词 other-{tok}")
        send(a["page"], gid, f"早期消息 early-{tok}")
        # 灌 240 条（5 人各 48 条）：单号 60 条/分钟的限流绕开，同时制造 >200 条的会话
        for i in range(240):
            send(water[i % len(water)]["page"], gid, f"灌水第 {i} 条 #{tok}")
        send(a["page"], gid, f"最新消息 late-{tok}")

        # ---------------------------------------------------------------- 打开页面（cookie 已在上下文里）
        page = a["page"]
        last_err = None
        for attempt in range(3):
            try:
                page.goto(BASE + "/", wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
                last_err = None
                break
            except Exception as err:  # noqa: BLE001 — 公网首包偶尔很慢
                last_err = err
                print(f"  页面加载第 {attempt + 1} 次超时，重试…")
                time.sleep(2)
        if last_err is not None:
            raise last_err
        page.wait_for_selector(".conv__item", timeout=30000)
        check("页面已登录（会话列表可见）", page.locator(".conv__item").count() >= 1)
        check("会话列表里有搜索框", page.locator(".conv__search-input").is_visible())

        page.locator(".conv__item", has_text="搜索UI群").first.click()
        page.wait_for_selector(".msg", timeout=20000)
        slow(page)
        last_seq = page.evaluate(
            "() => { const nodes=[...document.querySelectorAll('[data-seq]')]; return nodes.length ? Number(nodes[nodes.length-1].getAttribute('data-seq')) : 0 }"
        )
        newest_ok = page.locator(".msg", has_text=f"最新消息 late-{tok}").count() > 0
        check("打开 242 条消息的群：底部就是最新消息（不能停在旧窗口）", newest_ok, f"最后一条 data-seq={last_seq}")

        # ---------------------------------------------------------------- 搜本群词
        box = page.locator(".conv__search-input")
        box.click()
        box.fill(f"early-{tok}")
        page.wait_for_selector(".sr__item", timeout=15000)
        slow(page)
        hit = page.locator(".sr__item").first
        check("结果面板出现且命中 1 条", page.locator(".sr__item").count() == 1, hit.inner_text().replace("\n", " | "))
        check("结果里带群名", "搜索UI群" in hit.inner_text())
        check("结果里高亮关键词", page.locator(".sr__body mark").count() >= 1)
        page.screenshot(path=os.path.join(SHOTS, "77-search-desktop.png"))

        hit.click()
        page.wait_for_selector(".msg--flash", timeout=15000)
        slow(page)
        seq_attr = page.evaluate("() => document.querySelector('.msg--flash')?.getAttribute('data-seq') || ''")
        check("点结果：会话内目标消息高亮（跳转成功）", seq_attr == "1", f"data-seq={seq_attr}")
        check("跳转目标是那条早期消息", page.locator(".msg--flash", has_text=f"early-{tok}").count() == 1)
        check("跳转后搜索面板仍保留（能继续点别的结果）", page.locator(".sr__item").count() >= 1)
        page.screenshot(path=os.path.join(SHOTS, "78-search-jump.png"))

        # ---------------------------------------------------------------- 搜别人群
        box.fill(f"other-{tok}")
        page.wait_for_timeout(900)
        empty_text = page.locator(".sr__status").inner_text() if page.locator(".sr__status").count() else ""
        check("别人群的独有词：没有结果", page.locator(".sr__item").count() == 0 and "没有找到" in empty_text, empty_text)

        # ---------------------------------------------------------------- 手机视口
        page.set_viewport_size({"width": 390, "height": 844})
        back = page.locator(".chat__back")
        if back.count() and back.is_visible():
            back.click()
            page.wait_for_timeout(300)
        box = page.locator(".conv__search-input")
        box.click()
        box.fill(f"late-{tok}")
        page.wait_for_selector(".sr__item", timeout=15000)
        slow(page)
        width_ok = page.evaluate(
            "() => { const el=document.querySelector('.sr__list'); return el ? Math.round(el.getBoundingClientRect().width) : 0 }"
        )
        check("手机视口：结果面板整宽可用", width_ok >= 340, f"width={width_ok}")
        check("手机视口：结果里有最新那条", page.locator(".sr__item", has_text=f"late-{tok}").count() == 1)
        page.screenshot(path=os.path.join(SHOTS, "79-search-mobile.png"))

        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{'全部通过' if not failed else '有失败'}：{len(results) - len(failed)}/{len(results)}")
    if failed:
        print("失败项：" + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
