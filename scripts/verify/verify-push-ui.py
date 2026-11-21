# -*- coding: utf-8 -*-
"""系统通知 UI 回归：「我的」页开关 → 订阅入库 → 关闭退订（浏览器推送层用 mock）。

为什么 mock：
  真机验证需要「Chrome 连得上 FCM + 系统通知栏」，自动化环境里 Push API 直接
  `Registration failed - permission denied`（headless/临时 profile 都不给）。
  所以这里把 **navigator.serviceWorker 这一层**换成假的，验证的是**我们的代码**：
  点开关 → 拿公钥 → subscribe → POST 入库 → 再点 → 退订 → 后端删记录。
  真正的投递链路由 `verify-push.mjs` 用合法假 endpoint 覆盖（加密/发送/冷却/在线过滤）。

覆盖：
  1. 开关在「我的」页，服务端开启时文案是「不在页面时也能收到…」
  2. 点开：aria-checked=true，后端 /api/push/status 有 1 台设备（主机名 push.example.test）
  3. 点关：aria-checked=false，后端订阅清空
  4. 浏览器不支持 Push（删掉 window.PushManager）：开关禁用 + 文案「这个浏览器不支持」

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-push-ui.py
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

# 假的推送层：只实现我们用到的那几个方法；密钥随便填（后端只做长度/形状校验）
MOCK_PUSH_JS = """
(() => {
  let current = null;
  const sub = {
    endpoint: 'https://push.example.test/device-1',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }; },
    unsubscribe: async () => { current = null; return true; },
  };
  const reg = {
    scope: location.origin + '/',
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => { current = sub; return sub; },
    },
  };
  const sw = {
    getRegistration: async () => reg,
    register: async () => reg,
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: () => sw });
  // headless shell 跑在 incognito 语义里，Notification.permission 恒为 denied：
  // 这里连权限也一起假掉，验证的是我们自己的分支逻辑（真实权限行为由真机验收）
  class FakeNotification {}
  Object.defineProperty(FakeNotification, 'permission', { configurable: true, get: () => 'granted' });
  FakeNotification.requestPermission = async () => 'granted';
  Object.defineProperty(window, 'Notification', { configurable: true, get: () => FakeNotification });
})();
"""

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


def new_user(browser, display_name, extra_init=None):
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-CN")
    if extra_init:
        ctx.add_init_script(extra_init)
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


def open_me(page):
    # 用 JS 点：顶部 Tab 与手机底部 Tab 同名，Playwright 的可点性检查在布局切换瞬间会误判不可见
    page.evaluate(
        """() => {
          const tab = [...document.querySelectorAll('[role=tab]')].find((el) => el.textContent.trim() === '我的');
          if (tab) tab.click();
        }"""
    )
    page.wait_for_selector(".me", timeout=20000)


def push_row(page):
    return page.locator(".me-row", has_text="系统通知")


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])

        # ---------------------------------------------------------------- 1) 正常路径（mock 推送层）
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-CN", permissions=["notifications"])
        ctx.add_init_script(MOCK_PUSH_JS)
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        reg = call(page, "POST", "/api/auth/register", {
            "email": f"t_{os.urandom(4).hex()}@test.dev",
            "password": "passw0rd!x",
            "display_name": "推送UI-A",
            "invite_code": INVITE,
        })
        if reg["status"] != 200:
            raise RuntimeError(f"register failed {reg['status']} {reg['text']}")
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        page.wait_for_selector(".conv__item, .conv__empty", timeout=30000)

        open_me(page)
        row = push_row(page)
        check("「我的」页有「系统通知」一行", row.count() == 1)
        # 开关要等 /api/push/key 回来才会从 disabled 变成可点（别用固定 sleep 赌网络）
        try:
            page.wait_for_function(
                """() => {
                  const r = [...document.querySelectorAll('.me-row')].find((e) => e.textContent.includes('系统通知'));
                  const b = r && r.querySelector('button[role=switch]');
                  return Boolean(b) && !b.disabled;
                }""",
                timeout=8000,
            )
        except Exception:
            pass
        hint = row.inner_text()
        check("服务端已开启时文案正确", "不在页面时也能收到" in hint, hint.replace("\n", " | "))

        toggle = row.locator("button[role=switch]")
        check("开关初始是关的", toggle.get_attribute("aria-checked") == "false")
        before = call(page, "GET", "/api/push/status")["json"]
        check("开启前没有订阅", len(before["subscriptions"]) == 0, f"n={len(before['subscriptions'])}")

        toggle.click()
        page.wait_for_timeout(1200)
        after = call(page, "GET", "/api/push/status")["json"]
        check(
            "点开：订阅入库（1 台设备，主机名 push.example.test）",
            toggle.get_attribute("aria-checked") == "true" and len(after["subscriptions"]) == 1 and after["subscriptions"][0]["host"] == "push.example.test",
            f"n={len(after['subscriptions'])} host={after['subscriptions'][0]['host'] if after['subscriptions'] else '-'}",
        )
        toast_on = page.locator(".toast, .toast__item").inner_text() if page.locator(".toast, .toast__item").count() else ""
        check("开启后有成功提示", "已开启系统通知" in toast_on, toast_on[:60])
        page.screenshot(path=os.path.join(SHOTS, "80-push-on.png"))

        toggle.click()
        page.wait_for_timeout(1200)
        after_off = call(page, "GET", "/api/push/status")["json"]
        check(
            "点关：退订并删记录",
            toggle.get_attribute("aria-checked") == "false" and len(after_off["subscriptions"]) == 0,
            f"n={len(after_off['subscriptions'])}",
        )

        # ---------------------------------------------------------------- 2) 浏览器不支持
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN")
        ctx2.add_init_script("delete window.PushManager;")
        page2 = ctx2.new_page()
        page2.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        r2 = call(page2, "POST", "/api/auth/register", {
            "email": f"t_{os.urandom(4).hex()}@test.dev",
            "password": "passw0rd!x",
            "display_name": "推送UI-B",
            "invite_code": INVITE,
        })
        if r2["status"] != 200:
            raise RuntimeError(f"register failed {r2['status']} {r2['text']}")
        page2.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        page2.wait_for_selector(".conv__item, .conv__empty", timeout=30000)
        open_me(page2)
        row2 = push_row(page2)
        hint2 = row2.inner_text()
        disabled = row2.locator("button[role=switch]").is_disabled()
        check("不支持 Push 的浏览器：开关禁用 + 文案说明", disabled and "这个浏览器不支持" in hint2, hint2.replace("\n", " | "))
        page2.screenshot(path=os.path.join(SHOTS, "81-push-unsupported.png"))

        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{'全部通过' if not failed else '有失败'}：{len(results) - len(failed)}/{len(results)}")
    if failed:
        print("失败项：" + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
