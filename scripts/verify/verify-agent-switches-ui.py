# -*- coding: utf-8 -*-
"""验收：网页「我的 AI」两个主人开关（主动私聊 / 自己退群）能点两下就用。

为什么要有这条：这两个权限原来只有 PATCH API，客服同学不会用 curl，
只能靠「点两下」——所以必须在真浏览器里点，不能只测 API。

覆盖（7 条）：
  1. AI 管理页出现两个 role=switch 开关，默认都是关
  2. 点「自己退群」→ 开；后端 /api/agents 真值也变（不是纯前端状态）
  3. 刷新页面后仍然是开（持久化）
  4. 再点一下 → 关；后端也是关
  5. 点「主动私聊」→ 开；说明文字变成「已允许…」（不靠颜色单独表达状态）
  6. 开关尺寸与「我的」页一致（复用 .switch 48×28，没有同名类互相覆盖）
  7. 「我的」页「允许通过号码找到我」开关仍能正常切换（回归 24-me.css 的 .switch）

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-agent-switches-ui.py
"""
import json
import os
import sys
import uuid
import urllib.request
import urllib.parse
from http.cookiejar import CookieJar

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        # 本机 Playwright 自带浏览器版本常与系统那份不一致；退到系统 Chrome 最稳
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

problems = []
results = []


def check(name, ok, detail=""):
    results.append(name)
    if not ok:
        problems.append(name + (("  — " + str(detail)) if detail else ""))
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + str(detail)) if detail else ""))


def json_api(path, payload, cookie=None, method="POST"):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    # Cloudflare 会拦默认的 Python-urllib UA（线上返回空正文），必须带一个正常 UA
    req.add_header("user-agent", "aio-verify/1.0")
    if cookie:
        req.add_header("cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            body = res.read().decode("utf-8")
            cookies = res.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        cookies = e.headers.get_all("Set-Cookie") or []
    sid = next((c.split(";")[0] for c in cookies if c.startswith("sid=")), cookie)
    try:
        return json.loads(body) if body else {}, sid
    except json.JSONDecodeError:
        raise RuntimeError(f"{path} 返回非 JSON（status={status}）：{body[:160]!r}")


def main():
    email = f"t_{uuid.uuid4().hex[:8]}@test.dev"
    password = "passw0rd!x"
    # 1) 走 API 建账号 + 一只 AI（浏览器只负责「点」）
    me, cookie = json_api("/api/auth/register", {
        "email": email, "password": password, "display_name": "开关客服测试",
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    if not cookie:
        print("注册没拿到会话 cookie，无法继续")
        return 1
    agent, _ = json_api("/api/agents", {"display_name": "开关AI"}, cookie=cookie)
    agent_id = (agent.get("agent") or {}).get("id")
    if not agent_id:
        print("建 AI 失败：" + json.dumps(agent, ensure_ascii=False)[:200])
        return 1

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900}, locale="zh-CN")
        host = urllib.parse.urlparse(BASE).hostname
        ctx.add_cookies([{"name": "sid", "value": cookie.split("=", 1)[1], "domain": host, "path": "/"}])
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".topnav, .tabbar", timeout=30000)

        # 进「我的 → 我的 AI」
        page.get_by_role("tab", name="我的").first.click()
        page.wait_for_selector(".me-row--link", timeout=20000)
        page.get_by_role("button", name="我的 AI").click()
        page.wait_for_selector(".agent-row__switch", timeout=20000)

        switches = page.locator(".agent-row__switch button[role=switch]")
        check("AI 管理页出现两个开关（主动私聊 / 自己退群）", switches.count() == 2, f"count={switches.count()}")
        leave = page.locator("button[aria-label='允许自己退群']")
        dm = page.locator("button[aria-label='允许主动私聊']")
        check("两个开关默认都是关", leave.get_attribute("aria-checked") == "false" and dm.get_attribute("aria-checked") == "false",
              f"leave={leave.get_attribute('aria-checked')} dm={dm.get_attribute('aria-checked')}")

        # 2) 点「自己退群」
        leave.click()
        page.wait_for_timeout(700)
        agents, _ = json_api("/api/agents", None, cookie=cookie, method="GET")
        row = next((x for x in agents if int(x.get("id", 0)) == int(agent_id)), {})
        check("点「自己退群」→ 开关变开", leave.get_attribute("aria-checked") == "true")
        check("后端真值也变成允许（不是纯前端）", row.get("canLeaveGroup") is True, f"canLeaveGroup={row.get('canLeaveGroup')}")

        # 3) 刷新后仍开（视图状态在内存里，刷新会回到聊天页，要重新点进去）
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".topnav, .tabbar", timeout=30000)
        page.get_by_role("tab", name="我的").first.click()
        page.wait_for_selector(".me-row--link", timeout=20000)
        page.get_by_role("button", name="我的 AI").click()
        page.wait_for_selector("button[aria-label='允许自己退群']", timeout=20000)
        page.wait_for_timeout(500)
        leave = page.locator("button[aria-label='允许自己退群']")
        check("刷新页面后开关仍是开（持久化）", leave.get_attribute("aria-checked") == "true",
              f"checked={leave.get_attribute('aria-checked')}")

        # 4) 再点一下 → 关
        leave.click()
        page.wait_for_timeout(700)
        agents, _ = json_api("/api/agents", None, cookie=cookie, method="GET")
        row = next((x for x in agents if int(x.get("id", 0)) == int(agent_id)), {})
        check("再点一下 → 关，后端也关", leave.get_attribute("aria-checked") == "false" and row.get("canLeaveGroup") is False,
              f"checked={leave.get_attribute('aria-checked')} api={row.get('canLeaveGroup')}")

        # 5) 主动私聊 + 文案
        dm = page.locator("button[aria-label='允许主动私聊']")
        dm.click()
        page.wait_for_timeout(700)
        agents, _ = json_api("/api/agents", None, cookie=cookie, method="GET")
        row = next((x for x in agents if int(x.get("id", 0)) == int(agent_id)), {})
        text = page.locator(".agent-row__switch-text").first.inner_text()
        check("点「主动私聊」→ 开，后端允许", dm.get_attribute("aria-checked") == "true" and row.get("canInitiateDm") is True,
              f"checked={dm.get_attribute('aria-checked')} api={row.get('canInitiateDm')}")
        check("状态有文字说明（已允许…），不只靠颜色", "已允许" in text, text.replace("\n", " ")[:60])

        # 6) 尺寸复用 .switch（48×28），没有被 12-agents.css 的同名类改样
        box = page.locator(".agent-row__switch button[role=switch]").first.bounding_box() or {}
        check("开关尺寸仍是 48×28（复用 .switch，无同名类覆盖）",
              round(box.get("width", 0)) == 48 and round(box.get("height", 0)) == 28, f"{box.get('width')}×{box.get('height')}")

        page.screenshot(path=os.path.join(SHOTS, "90-agent-switches.png"))

        # 6.5) 大组件拆分回归：5 个从 AgentsView 拆出去的弹窗都要能开、内容对
        def close_dialog():
            page.keyboard.press("Escape")
            page.wait_for_timeout(250)

        page.get_by_role("button", name="发言额度").first.click()
        page.wait_for_selector(".limits", timeout=15000)
        check("弹窗：发言额度能打开（3 个输入 + 提示）",
              page.locator(".limits input[type=number]").count() == 3 and "平台只兜底防失控" in page.locator(".limits").inner_text())
        close_dialog()

        page.get_by_role("button", name="接入钥匙").first.click()
        page.wait_for_selector(".token-list", timeout=15000)
        check("弹窗：接入钥匙能打开（一把钥匙说明可见）",
              "一个窗口一把钥匙" in page.locator(".token-list").inner_text())
        close_dialog()

        page.get_by_role("button", name="群设置").first.click()
        page.wait_for_selector(".modal", timeout=15000)
        check("弹窗：「它加入了哪些群」能打开", "的群" in page.locator(".modal__title").inner_text(),
              page.locator(".modal__title").inner_text())
        close_dialog()

        page.get_by_role("button", name="配置 / 接入").first.click()
        page.wait_for_selector(".mcp-endpoint, .snippet", timeout=20000)
        check("弹窗：配置/接入能打开（显示 MCP 地址 + 片段）",
              "/mcp" in page.locator(".mcp-endpoint code").inner_text() or page.locator(".snippet").count() > 0)
        close_dialog()

        page.get_by_role("button", name="头像").first.click()
        page.wait_for_selector(".agent-avatar", timeout=15000)
        check("弹窗：头像能打开（地址输入 + 保存/清除）",
              page.locator(".agent-avatar").count() == 1
              and page.get_by_role("button", name="保存").count() == 1
              and page.get_by_role("button", name="清除").count() == 1)
        close_dialog()

        # 7) 回归：「我的」页的可被发现开关仍能切（同一个 .switch）
        page.get_by_role("tab", name="聊天").first.click()
        page.wait_for_timeout(300)
        page.get_by_role("tab", name="我的").first.click()
        page.wait_for_selector("button[aria-label='允许通过号码找到我']", timeout=20000)
        disc = page.locator("button[aria-label='允许通过号码找到我']")
        before = disc.get_attribute("aria-checked")
        disc.click()
        page.wait_for_timeout(700)
        after = page.locator("button[aria-label='允许通过号码找到我']").get_attribute("aria-checked")
        check("「我的」页可被发现开关仍可切换（共用 .switch 没被改坏）", before != after, f"{before} → {after}")
        page.locator("button[aria-label='允许通过号码找到我']").click()  # 还原
        page.wait_for_timeout(400)

        ctx.close()
        b.close()

    print()
    if problems:
        print(f"有失败：{len(problems)} 条")
        for x in problems:
            print(" - " + x)
        return 1
    print(f"全部通过：AI 开关 + 拆分弹窗 UI {len(results)} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
