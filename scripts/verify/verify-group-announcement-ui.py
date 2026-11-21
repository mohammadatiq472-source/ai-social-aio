# -*- coding: utf-8 -*-
"""验收「群公告（群规）」前端 + 真后端。

覆盖：
1. 群主在群设置里保存公告 → 关闭设置后聊天页出现公告条；
2. 2000 字上限：计数 2000/2000，再多输入一个字被 maxLength 拦下；
3. 公告条默认折叠 3 行、可展开/收起；正文按纯文本渲染（`<b>` 原样显示，不生成元素）；
4. 刷新页面后公告仍在（GET /api/conversations 带 announcement）；
5. 第二个账号（普通成员）能看到公告条，但没有群设置入口、公告条里也没有编辑按钮；
6. 清空公告 → 公告条消失；
7. 无 JS 异常、手机端无横向溢出。

为什么用两个账号：公告条是「所有成员只读」，只验群主会漏掉「普通成员看不到编辑入口」。
为什么公告条不截图正文全文：2000 字截图没有信息量，只截折叠/展开两种状态。

用法：
    BASE=http://127.0.0.1:8787 SHOTS_DIR=tmp/shots-ci python scripts/verify/verify-group-announcement-ui.py
    （无图形环境时可用 CHROME_PATH 指定本机 Chrome）

会创建一个名为「公告验证群」的群（若不存在）并复用；第二个账号 announce-readonly@qqmini.dev
不存在时自动注册（dev 环境开放注册）。测试结束会把该成员移出群、清空公告，群本身保留复用。
不打印密码/token。
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = "demo@qqmini.dev"
PASSWORD = "demo-qqmini-2026"
GROUP_TITLE = "公告验证群"
MEMBER_EMAIL = "announce-readonly@qqmini.dev"
MEMBER_PASSWORD = "announce-readonly-2026"
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

# 2000 字：开头放换行 + 一个「像 HTML」的片段，证明公告条是纯文本而不是富文本渲染
HEAD = "公告验证\n1. 只聊 AI 与产品，<b>这不是粗体</b>\n2. 发链接前先说明用途\n"
ANNOUNCEMENT = (HEAD + "规约" * 1200)[:2000]

problems = []


def expect(cond, message):
    print(("ok   " if cond else "FAIL ") + message)
    if not cond:
        problems.append(message)


def api(page, method, path, body=None):
    """在页面上下文里发同源请求（带 cookie），返回 {status, data}。"""
    arg = {"method": method, "path": path}
    if body is not None:
        arg["body"] = body
    return page.evaluate(
        """async ({ method, path, body }) => {
            const init = { method, credentials: 'same-origin' };
            if (body !== undefined) {
                init.headers = { 'Content-Type': 'application/json' };
                init.body = JSON.stringify(body);
            }
            const res = await fetch(path, init);
            let data = null;
            try { data = await res.json(); } catch (_) {}
            return { status: res.status, data };
        }""",
        arg,
    )


def login_api(page, email, password):
    return api(page, "POST", "/api/auth/login", {"email": email, "password": password})


def get_me(page):
    """GET /api/me 直接返回 Me（不是 {me}）；兼容两种形状，免得后端换包装就红。"""
    data = api(page, "GET", "/api/me")["data"]
    if isinstance(data, dict) and isinstance(data.get("me"), dict):
        return data["me"]
    return data


def open_group(page):
    page.wait_for_selector(".conv__item", timeout=30000)
    item = page.locator(".conv__item", has_text=GROUP_TITLE).first
    item.wait_for(state="visible", timeout=20000)
    item.click()
    page.wait_for_selector(".chat__head", timeout=20000)
    page.wait_for_timeout(700)


def open_settings(page):
    page.click('button[aria-label="群设置"]')
    page.wait_for_selector(".modal", timeout=15000)
    page.wait_for_selector('[data-testid="group-announcement-input"]', timeout=20000)


def read_announcement_text(page):
    return page.locator('[data-testid="chat-announcement-text"]').inner_text()


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

        # ---------- 准备：登录 demo，找到/创建「公告验证群」 ----------
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("input[type=email]", timeout=30000)
        login = login_api(page, EMAIL, PASSWORD)
        expect(login["status"] == 200, "demo 账号登录成功")
        me = get_me(page)
        demo_id = me["id"]

        group_id = None
        convs = api(page, "GET", "/api/conversations?offset=0&limit=200")["data"]
        mine = [c for c in convs if c.get("type") == "group" and c.get("title") == GROUP_TITLE]
        if mine:
            group_id = mine[0]["id"]
        else:
            created = api(page, "POST", "/api/conversations", {"title": GROUP_TITLE, "member_ids": []})
            group_id = (created["data"] or {}).get("conversation", {}).get("id")
            expect(created["status"] == 200 and group_id, "创建验证群「%s」" % GROUP_TITLE)
        print("group_id =", group_id)

        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        open_group(page)
        expect(page.locator('button[aria-label="群设置"]').count() == 1, "群主能看到群设置入口")

        # ---------- 1) 群主保存 2000 字公告 ----------
        open_settings(page)
        textarea = page.locator('[data-testid="group-announcement-input"]')
        textarea.fill(ANNOUNCEMENT)
        page.wait_for_timeout(300)
        count_text = page.locator('[data-testid="group-announcement-count"]').inner_text()
        expect("2000 / 2000" in count_text, "2000 字时计数显示 2000 / 2000（实际：%s）" % count_text)
        # 再敲一个字符：maxLength 应该把它挡在输入法层，不能超 2000
        textarea.press("End")
        textarea.type("X")
        value_len = textarea.evaluate("el => el.value.length")
        expect(value_len == 2000, "超过 2000 字的输入被 maxLength 拦下（实际长度 %d）" % value_len)
        page.screenshot(path=os.path.join(SHOTS, "group-announcement-settings.png"))

        page.click('[data-testid="group-announcement-save"]')
        page.wait_for_selector(".modal", state="detached", timeout=25000)
        page.wait_for_selector(".chat-announcement", timeout=20000)
        page.wait_for_timeout(500)
        expect(True, "保存后设置弹窗关闭，聊天页出现公告条")
        shown = read_announcement_text(page).strip()
        expect(shown == ANNOUNCEMENT, "公告条正文与保存内容一致（%d 字）" % len(shown))
        expect(page.locator(".chat-announcement b").count() == 0, "公告按纯文本渲染，不生成 HTML 元素")
        expect("<b>这不是粗体</b>" in shown, "HTML 片段原样显示（不当富文本）")
        expect(page.locator(".chat-announcement__meta").count() == 1, "公告条显示更新时间")

        text_cls = page.locator('[data-testid="chat-announcement-text"]').get_attribute("class") or ""
        expect("chat-announcement__text--clamp" in text_cls, "长公告默认折叠到 3 行")
        toggle = page.locator(".chat-announcement__toggle")
        expect(toggle.count() == 1, "被折叠的公告提供「展开」")
        page.screenshot(path=os.path.join(SHOTS, "group-announcement-collapsed.png"))
        toggle.click()
        page.wait_for_timeout(300)
        expect(toggle.inner_text().strip() == "收起", "展开后按钮变成「收起」")
        text_cls = page.locator('[data-testid="chat-announcement-text"]').get_attribute("class") or ""
        expect("chat-announcement__text--clamp" not in text_cls, "展开后不再截断")
        # 2000 字全放出来会把消息区/输入栏挤没：公告自身限高滚动，输入栏必须还在
        expect(page.locator(".composer__input").is_visible(), "展开 2000 字公告后输入栏仍可见")
        box = page.locator('[data-testid="chat-announcement-text"]').bounding_box()
        viewport_h = page.evaluate("window.innerHeight")
        expect(box is not None and box["height"] <= viewport_h * 0.45, "展开后的公告高度受限（不占满整屏）")
        page.screenshot(path=os.path.join(SHOTS, "group-announcement-expanded.png"))

        # ---------- 2) 刷新后仍在 ----------
        page.reload(wait_until="domcontentloaded")
        open_group(page)
        page.wait_for_selector(".chat-announcement", timeout=20000)
        expect(read_announcement_text(page).strip() == ANNOUNCEMENT, "刷新后公告仍在（存在服务端）")

        # ---------- 3) 普通成员：只读 ----------
        ctx2 = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 430, "height": 932},
            device_scale_factor=2,
            locale="zh-CN",
        )
        page2 = ctx2.new_page()
        errs2 = []
        page2.on("pageerror", lambda e: errs2.append(str(e)))
        page2.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)

        member_login = login_api(page2, MEMBER_EMAIL, MEMBER_PASSWORD)
        if member_login["status"] != 200:
            reg = api(
                page2,
                "POST",
                "/api/auth/register",
                {"email": MEMBER_EMAIL, "password": MEMBER_PASSWORD, "display_name": "公告只读成员"},
            )
            if reg["status"] != 200:
                # 账号存在但密码不同：换一个一次性邮箱，保证脚本可重复跑
                one_off = "announce-readonly-%d@qqmini.dev" % int(time.time())
                reg = api(
                    page2,
                    "POST",
                    "/api/auth/register",
                    {"email": one_off, "password": MEMBER_PASSWORD, "display_name": "公告只读成员"},
                )
            expect(reg["status"] == 200, "第二个账号注册/登录成功")
        member = get_me(page2)
        member_id = member["id"]

        # 加好友 + 拉进群（陌生人不能被直接拖进群；已加入则跳过）
        members_now = api(page, "GET", "/api/conversations/%d/members" % group_id)["data"]["members"]
        if member_id not in [m["id"] for m in members_now]:
            api(page, "POST", "/api/friends/request", {"account_no": member["accountNo"]})
            api(page2, "POST", "/api/friends/accept", {"principal_id": demo_id})
            added = api(page, "POST", "/api/conversations/%d/members" % group_id, {"principal_id": member_id})
            expect(added["status"] == 200, "群主把第二个账号拉进群")

        page2.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        open_group(page2)
        page2.wait_for_selector(".chat-announcement", timeout=20000)
        expect(read_announcement_text(page2).strip() == ANNOUNCEMENT, "普通成员也能看到公告条")
        expect(page2.locator('button[aria-label="群设置"]').count() == 0, "普通成员看不到群设置入口")
        edit_texts = ["编辑", "保存", "修改"]
        banner_buttons = page2.locator(".chat-announcement button")
        labels = [banner_buttons.nth(i).inner_text().strip() for i in range(banner_buttons.count())]
        expect(all(label not in edit_texts for label in labels), "公告条里没有编辑/保存入口（按钮：%s）" % labels)
        expect(page2.locator(".chat-announcement textarea").count() == 0, "公告条里没有输入框")
        page2.screenshot(path=os.path.join(SHOTS, "group-announcement-member.png"))

        # 清理：把只读成员移出群（群与账号保留，方便下次复用）
        removed = api(page, "DELETE", "/api/conversations/%d/members/%d" % (group_id, member_id))
        expect(removed["status"] == 200, "清理：把只读成员移出群")

        # ---------- 4) 清空公告 → 公告条消失 ----------
        open_settings(page)
        page.locator('[data-testid="group-announcement-input"]').fill("")
        page.click('[data-testid="group-announcement-save"]')
        page.wait_for_selector(".modal", state="detached", timeout=25000)
        page.wait_for_timeout(800)
        expect(page.locator(".chat-announcement").count() == 0, "清空公告后公告条不再显示")
        conv = [c for c in api(page, "GET", "/api/conversations?offset=0&limit=200")["data"] if c["id"] == group_id]
        expect(bool(conv) and (conv[0].get("announcement") or "") == "", "服务端公告已清空")

        # ---------- 5) 无 JS 异常 / 无横向溢出 ----------
        expect(not errs, "群主页面无 JS 异常（%s）" % (errs[:2] or "none"))
        expect(not errs2, "成员页面无 JS 异常（%s）" % (errs2[:2] or "none"))
        expect(page.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 1, "群主页面无横向溢出")
        expect(page2.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 1, "成员页面无横向溢出")

        ctx.close()
        ctx2.close()
        browser.close()

    if problems:
        print("\nGROUP ANNOUNCEMENT UI CHECK FAILED")
        for item in problems:
            print(" -", item)
        return 1
    print("\nGROUP ANNOUNCEMENT UI CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
