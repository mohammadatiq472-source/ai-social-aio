# -*- coding: utf-8 -*-
"""在线状态 + 正在输入（UI 回归）：两个真浏览器，互相看得见。

覆盖：
  1. A 打开会话 → 成员面板里 B 显示「在线」（WS 连接建立后后端会广播 presence）
  2. B 在输入栏打字 → A 的消息区出现「B 正在输入…」（不用发出去）
  3. 停手 4 秒 → 提示自动消失（不残留在屏幕上）
  4. B 关掉页面 → A 的成员面板变成「离线」（最后一个连接断了才广播）
  5. A 自己打字不会看到自己的「正在输入」

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-typing-ui.py
"""
import os
import sys

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
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
    page.wait_for_selector(".conv__item, .conv__empty", timeout=30000)
    return {"page": page, "ctx": ctx, "id": me["id"], "accountNo": me["accountNo"]}


def open_group(page, title):
    page.locator(".conv__item", has_text=title).first.click()
    page.wait_for_selector(".composer__input", timeout=20000)


def member_state(page, name):
    """成员面板里某人的状态文字（桌面常驻右栏；手机端要先点开抽屉）"""
    row = page.locator(".member-row", has_text=name).first
    if row.count() == 0 or not row.is_visible():
        btn = page.locator(".chat__members-btn")
        if btn.count() and btn.is_visible():
            btn.click()
            page.wait_for_timeout(400)
    row = page.locator(".member-row", has_text=name).first
    return row.inner_text().replace("\n", " | ") if row.count() and row.is_visible() else ""


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])

        A = new_actor(browser, "在线UI-A")
        B = new_actor(browser, "在线UI-B")
        call(A["page"], "POST", "/api/friends/request", {"account_no": B["accountNo"]})
        call(B["page"], "POST", "/api/friends/accept", {"principal_id": A["id"]})
        g = call(A["page"], "POST", "/api/conversations", {"title": "在线UI群", "member_ids": [B["id"]]})
        gid = g["json"]["conversation"]["id"]

        # 两边都刷新一次，让会话列表带上新群
        for actor in (A, B):
            actor["page"].goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
            actor["page"].wait_for_selector(".conv__item", timeout=30000)
        open_group(A["page"], "在线UI群")
        open_group(B["page"], "在线UI群")
        A["page"].wait_for_timeout(1200)  # 等 presence 帧到达

        # 1) B 在线
        text_a = member_state(A["page"], "在线UI-B")
        check("A 的成员面板：B 显示在线", "在线" in text_a and "离线" not in text_a, text_a)

        # 2) B 打字 → A 看到「正在输入」
        B["page"].locator(".composer__input").click()
        B["page"].locator(".composer__input").type("在吗", delay=60)
        typing = A["page"].locator(".typing")
        try:
            A["page"].wait_for_selector(".typing", timeout=8000)
            typing_text = typing.inner_text().replace("\n", " ")
        except Exception:
            typing_text = ""
        check("B 打字：A 看到「正在输入…」（B 没发送）", "在线UI-B" in typing_text and "正在输入" in typing_text, typing_text)
        A["page"].screenshot(path=os.path.join(SHOTS, "82-typing.png"))

        # 3) 停手 4 秒自动消失
        A["page"].wait_for_timeout(5000)
        check("停手 4 秒后提示自动消失", A["page"].locator(".typing").count() == 0)

        # 5) 自己打字不显示自己的「正在输入」
        A["page"].locator(".composer__input").click()
        A["page"].locator(".composer__input").type("我自己打", delay=50)
        A["page"].wait_for_timeout(900)
        own = A["page"].locator(".typing").inner_text() if A["page"].locator(".typing").count() else ""
        check("自己打字不会显示自己的「正在输入」", "在线UI-A" not in own, own)

        # 4) B 关页面 → A 看到离线
        B["ctx"].close()
        offline_text = ""
        for _ in range(16):
            A["page"].wait_for_timeout(500)
            offline_text = member_state(A["page"], "在线UI-B")
            if "离线" in offline_text:
                break
        check("B 关掉页面：A 的成员面板变成离线", "离线" in offline_text, offline_text)

        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{'全部通过' if not failed else '有失败'}：{len(results) - len(failed)}/{len(results)}")
    if failed:
        print("失败项：" + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
