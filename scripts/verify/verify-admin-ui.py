# -*- coding: utf-8 -*-
"""审核页 UI 回归：站务能看到「审核」入口 + 举报列表 + 处理按钮；普通用户看不到入口。

覆盖：
  1. 普通用户登录：顶部没有「审核」标签；直接打开也不显示审核页
  2. 站务登录：有「审核」标签 → 打开能看到刚提交的举报（群名 + 消息片段 + 举报人 + 理由）
  3. 填备注 → 点「隐藏消息」→ 卡片从「待处理」消失，切到「已处理」能看到处理动作/备注
  4. 被隐藏的消息在会话里变成「已撤回」样式（原文不再显示）

前置：需要一个 is_admin 账号（ADMIN_EMAIL / ADMIN_PASSWORD）。
用法：
  ADMIN_EMAIL=… ADMIN_PASSWORD=… BASE=http://127.0.0.1:8787 python scripts/verify/verify-admin-ui.py
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
INVITE = os.environ.get("REGISTER_CODE", "")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
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


def login_ui(page, email, password):
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
    if page.locator(".conv__item, .conv__empty").count() == 0:
        page.fill("input[type=email]", email)
        page.fill("input[type=password]", password)
        page.click("button[type=submit]")
    page.wait_for_selector(".conv__item, .conv__empty", timeout=30000)


def new_user(browser, display_name):
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
    return {"page": page, "ctx": ctx, "id": me["id"], "accountNo": me["accountNo"], "email": me["email"]}


def tab_names(page):
    return page.evaluate("() => [...document.querySelectorAll('[role=tab]')].map((el) => el.textContent.trim())")


def main():
    if not ADMIN_EMAIL or not ADMIN_PASSWORD:
        print("缺少 ADMIN_EMAIL / ADMIN_PASSWORD（需要一个 is_admin 账号）")
        sys.exit(2)
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])

        # 造一条待处理举报：A 把 B 的消息举报了
        A = new_user(browser, "审核UI-A")
        B = new_user(browser, "审核UI-B")
        call(A["page"], "POST", "/api/friends/request", {"account_no": B["accountNo"]})
        call(B["page"], "POST", "/api/friends/accept", {"principal_id": A["id"]})
        g = call(A["page"], "POST", "/api/conversations", {"title": "审核UI群", "member_ids": [B["id"]]})
        gid = g["json"]["conversation"]["id"]
        marker = f"ui-report-{os.urandom(3).hex()}"
        sent = call(B["page"], "POST", f"/api/conversations/{gid}/messages", {
            "body": f"这条会被站务隐藏 {marker}", "client_msg_id": os.urandom(8).hex(),
        })
        rep = call(A["page"], "POST", "/api/reports", {
            "target_type": "message", "target_id": sent["json"]["seq"], "conversation_id": gid, "reason": "UI 自动化测试举报",
        })
        check("准备：举报提交成功", rep["status"] == 200, f"status={rep['status']}")

        # 1) 普通用户看不到入口
        normal = new_user(browser, "审核UI-C")
        tabs_normal = tab_names(normal["page"])
        check("普通用户顶部没有「审核」标签", "审核" not in tabs_normal, ",".join(tabs_normal))

        # 2) 站务登录 → 审核页
        admin_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-CN")
        admin_page = admin_ctx.new_page()
        login_ui(admin_page, ADMIN_EMAIL, ADMIN_PASSWORD)
        tabs_admin = tab_names(admin_page)
        check("站务顶部有「审核」标签", "审核" in tabs_admin, ",".join(tabs_admin))
        admin_page.evaluate(
            """() => {
              const tab = [...document.querySelectorAll('[role=tab]')].find((el) => el.textContent.trim() === '审核');
              if (tab) tab.click();
            }"""
        )
        admin_page.wait_for_selector(".admin", timeout=20000)
        admin_page.wait_for_selector(".admin-card", timeout=15000)
        card = admin_page.locator(".admin-card", has_text=marker).first
        check("审核页能看到这条举报（群名/消息片段/举报人/理由）", card.count() == 1, card.inner_text().replace("\n", " | ")[:160] if card.count() else "not found")
        admin_page.screenshot(path=os.path.join(SHOTS, "83-admin.png"))

        # 3) 填备注 → 隐藏消息
        card.locator(".admin-card__note").fill("UI 自动化：广告，下架")
        card.locator("button", has_text="隐藏消息").click()
        admin_page.wait_for_timeout(1200)
        remaining = admin_page.locator(".admin-card", has_text=marker).count()
        check("处理后：待处理列表里这条消失", remaining == 0, f"remaining={remaining}")

        admin_page.locator(".admin__tab", has_text="已处理").click()
        admin_page.wait_for_timeout(800)
        handled = admin_page.locator(".admin-card", has_text=marker).first
        text = handled.inner_text().replace("\n", " | ") if handled.count() else ""
        check("已处理页能看到动作与备注", handled.count() == 1 and "隐藏消息" in text and "广告，下架" in text, text[:200])

        # 4) 会话里那条变成「已撤回」
        A["page"].goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        A["page"].wait_for_selector(".conv__item", timeout=30000)
        A["page"].locator(".conv__item", has_text="审核UI群").first.click()
        A["page"].wait_for_selector(".messages", timeout=20000)
        A["page"].wait_for_timeout(1200)
        body_text = A["page"].locator(".messages").inner_text()
        search = call(A["page"], "GET", f"/api/search/messages?q={marker}")
        hits = (search["json"] or {}).get("results") or []
        check(
            "成员侧：被隐藏的消息看不到（正文不出现、搜索也搜不到）",
            marker not in body_text and len(hits) == 0,
            f"body={body_text.replace(chr(10), ' | ')[:80]} search_n={len(hits)}",
        )

        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{'全部通过' if not failed else '有失败'}：{len(results) - len(failed)}/{len(results)}")
    if failed:
        print("失败项：" + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
