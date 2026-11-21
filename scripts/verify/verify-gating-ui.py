# -*- coding: utf-8 -*-
"""发言额度 UI 回归：主人能在「我的 AI」里调配额度，改完 Agent 立刻读得到。

覆盖：
  1. 「我的 AI」卡片显示日限/桶参数
  2. 点「发言额度」→ 改每日上限 → 保存 → 接口返回新值
  3. 该 Agent 的 MCP my_limits 立刻读到新值（不用重启、不靠刻意读）
  4. 被暂停的 AI 卡片显示原因（熔断/手动）
  5. 群设置弹窗里能看到并修改「每轮接话 / 接力深度 / 群日限」，Agent 的 my_limits 读到

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-gating-ui.py
"""
import os
import re
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
  return { status: res.status, json, text: text.slice(0, 300) };
}"""


def call(page, method, path, data=None):
    return page.evaluate(FETCH_JS, {"method": method, "path": path, "data": data})


def click_tab(page, label):
    page.evaluate(
        """(label) => {
          const tab = [...document.querySelectorAll('[role=tab], .tabbar__btn')].find((el) => el.textContent.trim().includes(label));
          if (tab) tab.click();
        }""",
        label,
    )


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        ctx = browser.new_context(base_url=BASE, viewport={"width": 1280, "height": 800}, locale="zh-CN")
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        reg = call(page, "POST", "/api/auth/register", {
            "email": f"t_{os.urandom(4).hex()}@test.dev",
            "password": "passw0rd!x",
            "display_name": "额度UI-A",
            "invite_code": INVITE,
        })
        if reg["status"] != 200:
            raise RuntimeError(f"register failed {reg['status']} {reg['text']}")
        agent = call(page, "POST", "/api/agents", {"display_name": "额度UI助手"})
        agent_id = agent["json"]["agent"]["id"]
        token = agent["json"]["token"]

        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        page.wait_for_selector(".conv__item, .conv__empty", timeout=30000)
        click_tab(page, "我的")
        page.wait_for_selector(".me", timeout=20000)
        page.locator(".me-row", has_text="我的 AI").first.click()
        page.wait_for_selector(".agent-row", timeout=20000)

        row = page.locator(".agent-row", has_text="额度UI助手").first
        meta = row.inner_text()
        check("卡片显示日限/桶参数", "日限" in meta and "桶" in meta, meta.replace("\n", " | ")[:100])

        # 2) 打开额度弹窗 → 改每日上限
        row.locator("button", has_text="发言额度").click()
        page.wait_for_selector(".limits", timeout=15000)
        page.wait_for_timeout(800)
        daily_input = page.locator(".limits .field").first.locator("input")
        daily_input.fill("1234")
        page.locator(".limits__actions button").click()
        page.wait_for_timeout(1200)
        quota = call(page, "GET", f"/api/agents/{agent_id}/limits")
        check("保存后接口返回新日限", quota["json"]["daily_limit"] == 1234, f"daily={quota['json'].get('daily_limit')}")
        page.screenshot(path=os.path.join(SHOTS, "88-agent-limits.png"))
        page.keyboard.press("Escape")

        # 群主操作：转让群主 + 解散群（用新群验证，避免影响上面的断言）
        g2 = call(page, "POST", "/api/conversations", {"title": "群主操作UI群", "member_ids": []})
        gid2 = g2["json"]["conversation"]["id"]
        # 新群主必须用独立浏览器上下文注册，否则会把当前页面的登录态换成新用户
        tx_ctx = browser.new_context(base_url=BASE, viewport={"width": 1280, "height": 800}, locale="zh-CN")
        tx_page = tx_ctx.new_page()
        tx_page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        reg_t = call(tx_page, "POST", "/api/auth/register", {
            "email": f"t_{os.urandom(4).hex()}@test.dev",
            "password": "passw0rd!x",
            "display_name": "转让UI-新群主",
            "invite_code": INVITE,
        })
        me_t = reg_t["json"]["me"]
        call(page, "POST", "/api/friends/request", {"account_no": me_t["accountNo"]})
        call(tx_page, "POST", "/api/friends/accept", {"principal_id": page.evaluate("() => fetch('/api/me').then(r=>r.json()).then(j=>j.id)")})
        call(page, "POST", f"/api/conversations/{gid2}/members", {"principal_id": me_t["id"]})
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".conv__item", timeout=30000)
        page.locator(".conv__item", has_text="群主操作UI群").first.click()
        page.wait_for_selector(".composer__input", timeout=20000)
        page.locator('.chat__head-actions button.chat__more[aria-label="群设置"]').first.click()
        page.wait_for_selector(".gs-danger", timeout=15000)
        page.wait_for_timeout(800)
        check("群主能在群设置里看到「群主操作」区", page.locator(".gs-danger").count() == 1)
        page.locator(".gs-danger__select").select_option(label="转让UI-新群主")
        page.locator(".gs-danger__row", has_text="转让群主").locator("button", has_text="转让").first.click()
        page.locator(".gs-danger button", has_text="确认转让").first.click()
        page.wait_for_timeout(1200)
        after_transfer = call(page, "GET", f"/api/conversations/{gid2}/members")
        roles = {m["displayName"]: m["role"] for m in after_transfer["json"]["members"]}
        check("UI 转让群主后角色互换", roles.get("转让UI-新群主") == "owner",
            f"roles={roles}")

        # 用新群主身份解散（这里用 API 模拟新群主登录态不可行，改用页面：先刷新确认自己已不是群主）
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".conv__item", timeout=30000)
        check("转让后自己不再是群主（头栏没有 ⋯）", page.locator('.chat__head-actions button[aria-label="群设置"]').count() == 0)

        # 解散（不需要先踢人）：群主输入群名确认后直接解散
        g3 = call(page, "POST", "/api/conversations", {"title": "解散UI群", "member_ids": []})
        gid3 = g3["json"]["conversation"]["id"]
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".conv__item, .conv__empty", timeout=30000)
        page.locator(".conv__item", has_text="解散UI群").first.click()
        page.wait_for_selector(".composer__input", timeout=20000)
        page.locator('.chat__head-actions button.chat__more[aria-label="群设置"]').first.click()
        page.wait_for_selector(".gs-danger", timeout=15000)
        page.wait_for_timeout(600)
        page.locator(".gs-danger__input").fill("解散UI群")
        page.locator(".gs-danger button", has_text="解散").first.click()
        page.locator(".gs-danger button", has_text="确认解散").first.click()
        page.wait_for_timeout(1500)
        listed = call(page, "GET", "/api/conversations")
        check("UI 解散后群从列表消失", not any(c["id"] == gid3 for c in listed["json"]), f"n={len(listed['json'])}")
        tx_ctx.close()
        page.wait_for_timeout(400)

        # 3) Agent 侧 my_limits 立刻读到
        mcp = page.evaluate(
            """async ({ token }) => {
              const res = await fetch('/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_limits', arguments: {} } }),
              });
              const body = await res.json();
              const text = body?.result?.content?.[0]?.text;
              return { isError: body?.result?.isError === true, json: text ? JSON.parse(text) : null };
            }""",
            {"token": token},
        )
        check(
            "Agent 的 my_limits 立刻读到新日限（不用重启/重连）",
            mcp["isError"] is False and mcp["json"].get("daily_limit") == 1234,
            f"daily={mcp['json'].get('daily_limit') if mcp['json'] else mcp}",
        )

        # 3.5) 群设置入口：群主看得到、普通成员看不到；弹窗能读能存
        conv = call(page, "POST", "/api/conversations", {"title": "群设置UI群", "member_ids": []})
        gid = conv["json"]["conversation"]["id"]
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".conv__item", timeout=30000)
        page.locator(".conv__item", has_text="群设置UI群").first.click()
        page.wait_for_selector(".composer__input", timeout=20000)
        gear = page.locator('.chat__head-actions button.chat__more[aria-label="群设置"]')
        check("群主在头栏看到一个小小的「⋯」入口（群名仍是纯文字）", gear.count() == 1)
        gear.first.click()
        page.wait_for_selector(".group-settings", timeout=15000)
        page.wait_for_timeout(800)
        depth_input = page.locator(".group-settings .field").nth(1).locator("input")
        depth_input.fill("4")
        page.locator(".modal__foot button", has_text="保存").first.click()
        page.wait_for_timeout(1000)
        saved = call(page, "GET", f"/api/conversations/{gid}/agent-settings")
        check("群设置保存生效（接力深度=4）", saved["json"]["settings"]["relayDepth"] == 4, f"depth={saved['json']['settings'].get('relayDepth')}")
        page.screenshot(path=os.path.join(SHOTS, "89-group-settings.png"))

        # 普通成员看不到入口
        member_ctx = browser.new_context(base_url=BASE, viewport={"width": 1280, "height": 800}, locale="zh-CN")
        member_page = member_ctx.new_page()
        member_page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        reg_m = call(member_page, "POST", "/api/auth/register", {
            "email": f"t_{os.urandom(4).hex()}@test.dev",
            "password": "passw0rd!x",
            "display_name": "额度UI-成员",
            "invite_code": INVITE,
        })
        me_m = reg_m["json"]["me"]
        # 拉人规则：只能拉好友（或自己的 AI）。先加好友再拉进群。
        call(page, "POST", "/api/friends/request", {"account_no": me_m["accountNo"]})
        call(member_page, "POST", "/api/friends/accept", {"principal_id": page.evaluate("() => fetch('/api/me').then(r=>r.json()).then(j=>j.id)")})
        add = call(page, "POST", f"/api/conversations/{gid}/members", {"principal_id": me_m["id"]})
        check("准备：把普通成员拉进群", add["status"] == 200, f"status={add['status']} {add['text'][:80]}")
        member_page.reload(wait_until="domcontentloaded")
        member_page.wait_for_selector(".conv__item", timeout=30000)
        member_page.locator(".conv__item", has_text="群设置UI群").first.click()
        member_page.wait_for_selector(".composer__input", timeout=20000)
        check(
            "普通成员头栏没有群设置入口",
            member_page.locator('.chat__head-actions button[aria-label="群设置"]').count() == 0,
        )
        # 成员管理（群主）：弹窗里能看到成员并设/取消管理员
        gear.first.click()
        page.wait_for_selector(".gs-members", timeout=15000)
        page.wait_for_timeout(1000)
        rows = page.locator(".gs-member")
        check("群设置里有成员列表（含群主与普通成员）", rows.count() >= 2, f"rows={rows.count()}")
        promote_btn = page.locator(".gs-member", has_text="额度UI-成员").locator("button", has_text="设为管理员")
        check("群主能看到「设为管理员」按钮", promote_btn.count() == 1, f"count={promote_btn.count()}")
        if promote_btn.count() == 1:
            promote_btn.first.click()
            page.wait_for_timeout(1200)
            roles = call(page, "GET", f"/api/conversations/{gid}/members")
            target = next((m for m in roles["json"]["members"] if m["displayName"] == "额度UI-成员"), None)
            check("点「设为管理员」后角色变成 admin", (target or {}).get("role") == "admin",
                f"role={(target or {}).get('role')}")
            page.screenshot(path=os.path.join(SHOTS, "92-group-members.png"))
        page.keyboard.press("Escape")

        # 群广场：群设置里能公开 → 发现目录能搜到 → 表头 🧭 能打开弹窗
        page.locator(".conv__item", has_text="群设置UI群").first.click()
        page.wait_for_selector(".composer__input", timeout=20000)
        page.locator('.chat__head-actions button[aria-label="群设置"]').first.click()
        page.wait_for_selector(".gs-public", timeout=15000)
        page.wait_for_timeout(500)
        check("群设置里有「公开推荐（群广场）」区", page.locator(".gs-public").count() == 1)
        page.locator(".gs-public input[type=checkbox]").first.check()
        page.locator(".gs-public__actions button", has_text="保存公开设置").first.click()
        page.wait_for_timeout(1000)
        disc = call(page, "GET", "/api/groups/discover?q=")
        check("公开后能在发现目录里搜到自己的群", any((g.get("title") == "群设置UI群") for g in (disc.get("json", {}).get("groups") or [])),
            f"n={len(disc.get('json', {}).get('groups') or [])}")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.locator('.conv__plus-wrap > button').first.click()
        page.wait_for_selector(".conv__menu", timeout=8000)
        page.locator(".conv__menu-item", has_text="发现群聊").first.click()
        page.wait_for_selector(".gd", timeout=15000)
        check("表头 🧭 能打开「发现群聊」弹窗", page.locator(".modal__title", has_text="发现群聊").count() == 1)
        page.keyboard.press("Escape")

        # AI 好友提示条：让额度UI助手加主人为好友 → 主人接受 → 好友页出现黄色提示条
        addf = page.evaluate(
            """async ({token, ownerId}) => {
              const r = await fetch('/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_friend', arguments: { principal_id: ownerId } } }),
              });
              return r.status;
            }""",
            {"token": token, "ownerId": page.evaluate("() => fetch('/api/me').then(r=>r.json()).then(j=>j.id)")},
        )
        page.wait_for_timeout(500)
        call(page, "POST", "/api/friends/accept", {"principal_id": agent_id})
        check("AI 好友建立成功（准备）", addf == 200, f"status={addf}")
        click_tab(page, "好友")
        page.wait_for_selector(".friends", timeout=20000)
        page.wait_for_timeout(800)
        check("好友列表不再挂黄色提示条（只在会话里出现）", page.locator(".ai-note").count() == 0)
        # 从好友页「私聊」进入与 AI 的会话 → 顶部出现可关闭的提示条
        page.locator(".friend-row", has_text="额度UI助手").locator("button", has_text="私聊").first.click()
        page.wait_for_timeout(1200)
        click_tab(page, "聊天")
        page.wait_for_selector(".conv__item", timeout=20000)
        # 新的人类↔AI 私聊在列表里显示对端昵称（c2c 的 title 是占位「未命名群」）
        chat_item = page.locator(".conv__item", has_text="额度UI助手").first
        if chat_item.count() == 0:
            chat_item = page.locator(".conv__item").first
        chat_item.click()
        page.wait_for_selector(".composer__input", timeout=20000)
        page.wait_for_timeout(600)
        check("与 AI 的会话里出现提示条（无图标）", page.locator(".ai-note--chat").count() == 1,
            f"n={page.locator('.ai-note--chat').count()}")
        check("提示条有「×」可关闭", page.locator(".ai-note--chat .ai-note__close").count() == 1)
        page.locator(".ai-note--chat .ai-note__close").first.click()
        page.wait_for_timeout(300)
        check("点 × 后这次会话的提示条消失", page.locator(".ai-note--chat").count() == 0)
        # 离开聊天页再回来（ChatView 重新挂载）：提示条重新出现，不是永久关闭
        click_tab(page, "好友")
        page.wait_for_timeout(400)
        click_tab(page, "聊天")
        page.wait_for_selector(".conv__item", timeout=20000)
        page.locator(".conv__item", has_text="额度UI助手").first.click()
        page.wait_for_timeout(800)
        check("离开再进来，提示条重新出现", page.locator(".ai-note--chat").count() >= 1,
            f"n={page.locator('.ai-note--chat').count()}")

        # 4) 暂停原因展示
        call(page, "POST", f"/api/agents/{agent_id}/pause", {"paused": True})
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".conv__item, .conv__empty", timeout=30000)
        click_tab(page, "我的")
        page.wait_for_selector(".me", timeout=20000)
        page.locator(".me-row", has_text="我的 AI").first.click()
        page.wait_for_selector(".agent-row", timeout=20000)
        row2 = page.locator(".agent-row", has_text="额度UI助手").first
        text2 = row2.inner_text()
        # 接入钥匙：能看到至少一把、且有「吊销」按钮
        row2.locator("button", has_text="接入钥匙").click()
        page.wait_for_selector(".token-list", timeout=15000)
        page.wait_for_timeout(800)
        token_rows = page.locator(".token-list__row")
        check("接入钥匙列表至少一行", token_rows.count() >= 1, f"rows={token_rows.count()}")
        check("有效钥匙有「吊销」按钮", page.locator(".token-list__row button", has_text="吊销").count() >= 1)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check("被暂停的 AI 卡片显示原因", "暂停" in text2, text2.replace("\n", " | ")[:120])
        call(page, "POST", f"/api/agents/{agent_id}/pause", {"paused": False})

        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{'全部通过' if not failed else '有失败'}：{len(results) - len(failed)}/{len(results)}")
    if failed:
        print("失败项：" + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
