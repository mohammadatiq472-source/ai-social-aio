# -*- coding: utf-8 -*-
"""验收「站务 → 邀请」管理 UI（真后端）。

覆盖：
1. 站务登录 → 审核页出现「邀请」tab；创建 1 个「1 人可用 / 7 天」站务码；
2. 创建后出现一次性明文码（断言格式 AIO-XXXX-XXXX-XXXX 与数量，不打印内容）+「复制全部」+「只显示这一次」提示；
3. 刷新页面后明文消失，列表只剩掩码 AIO-XXXX-****-****，且状态为「有效」；
4. 吊销走 ConfirmDialog 二次确认；确认后该项状态变成「已吊销」；
5. 非站务账号：顶部没有「审核」入口，直接调 /api/admin/invites 得到 403；
6. 站务页无 JS 异常；手机端「邀请」页无横向溢出。

前置：需要一个 is_admin 账号。本地可用：
    UPDATE principals p SET is_admin = true
      FROM user_accounts ua
     WHERE ua.principal_id = p.id AND ua.email = 'admin-invite-verify@qqmini.dev';
    （脚本不会自己改库；ADMIN_EMAIL / ADMIN_PASSWORD 可用环境变量覆盖。）

用法：
    BASE=http://127.0.0.1:8787 SHOTS_DIR=tmp/shots-ci \\
      ADMIN_EMAIL=admin-invite-verify@qqmini.dev ADMIN_PASSWORD=… \\
      python scripts/verify/verify-admin-invites-ui.py

脚本不打印明文邀请码，也不在明文态截图（明文只在「断言格式」这一步进内存）。
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin-invite-verify@qqmini.dev")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin-invite-verify-2026")
NONADMIN_EMAIL = os.environ.get("NONADMIN_EMAIL", "admin-nonadmin@qqmini.dev")
NONADMIN_PASSWORD = os.environ.get("NONADMIN_PASSWORD", "admin-nonadmin-2026")
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

CODE_RE = re.compile(r"AIO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}")
MASK_RE = re.compile(r"AIO-[A-Z0-9]{4}-\*{4}-\*{4}")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  — {detail}" if detail else ""))
    return ok


def api(page, method, path, data=None):
    arg = {"method": method, "path": path}
    if data is not None:
        arg["data"] = data
    return page.evaluate(
        """async ({ method, path, data }) => {
            const init = { method, credentials: 'same-origin' };
            if (data !== undefined) {
                init.headers = { 'content-type': 'application/json' };
                init.body = JSON.stringify(data);
            }
            const res = await fetch(path, init);
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (_) {}
            return { status: res.status, json };
        }""",
        arg,
    )


def login_ui(page, email, password):
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
    if page.locator("input[type=email]").count():
        page.fill("input[type=email]", email)
        page.fill("input[type=password]", password)
        page.click("button[type=submit]")
    page.wait_for_selector(".conv__item, .conv__empty", timeout=40000)


def open_admin(page, mobile=False):
    """打开审核页（桌面点顶部 tab；手机点底部 tabbar）"""
    if mobile:
        page.locator(".tabbar button", has_text="审核").first.click()
    else:
        page.locator(".topnav__tabs button", has_text="审核").first.click()
    page.wait_for_selector(".admin", timeout=20000)
    page.wait_for_selector(".admin__tab", timeout=20000)


def open_invites(page):
    page.locator(".admin__tab", has_text="邀请").first.click()
    page.wait_for_selector(".admin-invites", timeout=20000)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()

        # ---------------- 站务桌面 ----------------
        ctx = browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        login_ui(page, ADMIN_EMAIL, ADMIN_PASSWORD)
        me = api(page, "GET", "/api/me")["json"]
        if not check("登录账号是站务（is_admin）", isinstance(me, dict) and me.get("isAdmin") is True):
            print("提示：本地可 UPDATE principals SET is_admin=true 后重跑")
            return 1

        open_admin(page)
        tabs = page.evaluate("() => [...document.querySelectorAll('.admin__tab')].map((el) => el.textContent.trim())")
        check("审核页出现「邀请」tab", "邀请" in tabs, ",".join(tabs))
        open_invites(page)
        page.screenshot(path=os.path.join(SHOTS, "admin-invites-form.png"))

        # ---------------- 1) 创建 1 个 1 人 / 7 天站务码 ----------------
        page.fill('[data-testid="admin-invite-count"]', "1")
        page.fill('[data-testid="admin-invite-maxuses"]', "1")
        page.fill('[data-testid="admin-invite-ttl"]', "7")
        page.fill('[data-testid="admin-invite-note"]', "自动化验证")
        page.click('[data-testid="admin-invite-create"]')
        page.wait_for_selector('[data-testid="admin-invite-codes"]', timeout=20000)
        page.wait_for_timeout(500)
        codes = [
            page.locator(".admin-invites__code").nth(i).inner_text().strip()
            for i in range(page.locator(".admin-invites__code").count())
        ]
        check("创建后出现一次性明文码（数量 1）", len(codes) == 1, f"count={len(codes)}")
        check(
            "明文码格式合法 AIO-XXXX-XXXX-XXXX",
            len(codes) == 1 and bool(CODE_RE.fullmatch(codes[0])),
            f"len={len(codes[0]) if codes else 0}",
        )
        check("明文旁提示「只显示这一次」", "只显示这一次" in page.locator(".admin-invites__plain").inner_text())
        check("明文提供「复制全部」", page.locator('[data-testid="admin-invite-copy-all"]').count() == 1)
        prefix = codes[0].split("-")[1] if codes else ""

        # ---------------- 2) 刷新后只剩掩码 ----------------
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".conv__item, .conv__empty", timeout=40000)
        open_admin(page)
        open_invites(page)
        page.wait_for_timeout(600)
        check("刷新后明文不再出现", page.locator(".admin-invites__code").count() == 0)
        first = page.locator(".admin-invites__item").first
        masked = first.locator('[data-testid="admin-invite-prefix"]').inner_text().strip()
        check("列表只显示掩码 AIO-XXXX-****-****", bool(MASK_RE.fullmatch(masked)), masked)
        check(
            "刷新后列表第一条就是刚创建的码（前缀一致）",
            masked == f"AIO-{prefix}-****-****",
            f"masked={masked}",
        )
        check("刚创建的码状态为「有效」", first.locator('[data-testid="admin-invite-status"]').inner_text().strip() == "有效")
        meta = first.inner_text()
        check("列表显示站务/用户类型与用量、被邀请人数", "站务码" in meta and "已用 0 / 1" in meta and "被邀请 0 人" in meta)
        page.screenshot(path=os.path.join(SHOTS, "admin-invites-list.png"))

        # ---------------- 3) 吊销（ConfirmDialog） ----------------
        first.locator('[data-testid="admin-invite-revoke"]').click()
        page.wait_for_selector(".modal", timeout=8000)
        check("吊销走 ConfirmDialog 二次确认", page.locator(".modal .btn--danger").count() >= 1)
        page.click(".modal button:has-text('吊销')")
        page.wait_for_selector(".modal", state="detached", timeout=20000)
        page.wait_for_timeout(900)
        status = page.locator(".admin-invites__item").first.locator('[data-testid="admin-invite-status"]').inner_text().strip()
        check("吊销后列表状态变成「已吊销」", status == "已吊销", status)
        page.screenshot(path=os.path.join(SHOTS, "admin-invites-after-revoke.png"))

        # ---------------- 4) 非站务：无入口 + 接口 403 ----------------
        ctx2 = browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 900}, locale="zh-CN")
        page2 = ctx2.new_page()
        errs2 = []
        page2.on("pageerror", lambda e: errs2.append(str(e)))
        page2.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        login = api(page2, "POST", "/api/auth/login", {"email": NONADMIN_EMAIL, "password": NONADMIN_PASSWORD})
        if login["status"] != 200:
            reg = api(
                page2,
                "POST",
                "/api/auth/register",
                {"email": NONADMIN_EMAIL, "password": NONADMIN_PASSWORD, "display_name": "非站务验证"},
            )
            check("非站务账号注册成功", reg["status"] == 200)
        page2.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        page2.wait_for_selector(".conv__item, .conv__empty", timeout=40000)
        top_tabs = page2.evaluate(
            "() => [...document.querySelectorAll('.topnav__tabs [role=tab], .tabbar [role=tab]')]"
            ".map((el) => el.textContent.trim())"
        )
        check("非站务看不到「审核」入口", "审核" not in top_tabs, ",".join(top_tabs))
        denied = api(page2, "GET", "/api/admin/invites")
        check("非站务直接调 /api/admin/invites 得到 403", denied["status"] == 403, str(denied["status"]))

        # ---------------- 5) 手机端：邀请页不横向溢出 ----------------
        ctx3 = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 430, "height": 932},
            device_scale_factor=2,
            locale="zh-CN",
        )
        page3 = ctx3.new_page()
        errs3 = []
        page3.on("pageerror", lambda e: errs3.append(str(e)))
        page3.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        api(page3, "POST", "/api/auth/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        page3.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        page3.wait_for_selector(".conv__item, .conv__empty", timeout=40000)
        open_admin(page3, mobile=True)
        open_invites(page3)
        page3.wait_for_timeout(600)
        overflow = page3.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("手机端站务邀请页无横向溢出", overflow <= 1, f"overflow={overflow}px")
        check("手机端能看到创建表单与列表", page3.locator('[data-testid="admin-invite-create"]').count() == 1)
        page3.screenshot(path=os.path.join(SHOTS, "admin-invites-mobile.png"))

        check("站务桌面页无 JS 异常", not errs, " | ".join(errs[:2]))
        check("非站务页无 JS 异常", not errs2, " | ".join(errs2[:2]))
        check("站务手机页无 JS 异常", not errs3, " | ".join(errs3[:2]))

        ctx.close()
        ctx2.close()
        ctx3.close()
        browser.close()

    failed = [name for name, ok in results if not ok]
    if failed:
        print("\nADMIN INVITES UI CHECK FAILED")
        for name in failed:
            print(" -", name)
        return 1
    print("\nADMIN INVITES UI CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
