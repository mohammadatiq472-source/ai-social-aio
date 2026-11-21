# -*- coding: utf-8 -*-
"""聊天韧性/可访问性 UI 回归（2026-11-14 前端审查的 P1 修复）。

覆盖（9 条）：
  1. /api/conversations 失败 → 显示错误块 + 「重试」，绝不伪装成「还没有会话」
  2. 恢复后点「重试」→ 会话列表回来
  3. 移动端长按消息 → 面板弹出后**松手不会被立刻关掉**（审查 P1-1 的回归）
  4. 点遮罩仍能正常关闭面板（修复不能把关闭也一起挡掉）
  5. 空群显示 `.messages__empty`（role=status），不再复用 loading 的 class
  6. 加载态有 role=status（读屏能听到「正在加载消息」）
  7. 桌面「回复」按钮 focus-visible 时可见（opacity 1）
  8. 说说操作菜单 Esc 可关（自建 dialog 的行为对齐 Modal）
  9. token 对比度：--text-3 在页面里的实际比值 ≥ 4.5（浅色 + 深色）

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-chat-resilience-ui.py

注：启动超时用例故意让一个请求永久挂起，关浏览器时 Playwright 可能在 stderr 打一段
CancelledError/TargetClosedError 的收尾噪声——断言已全部跑完，退出码仍为 0，属预期。
"""
import json
import os
import re
import sys
import uuid
import urllib.request
import urllib.parse

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
executed = []


def check(name, ok, detail=""):
    executed.append(name)
    if not ok:
        problems.append(name + (("  — " + str(detail)) if detail else ""))
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + str(detail)) if detail else ""))


def api(path, payload, cookie=None, method="POST"):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("content-type", "application/json")
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
    return (json.loads(body) if body else {}), sid


CONTRAST_JS = """
(sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const lum = (hex) => {
    const c = hex.replace('#','').match(/../g).map(x => parseInt(x,16)/255)
      .map(v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4))
    return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]
  }
  const fg = getComputedStyle(el).color
  let node = el, bg = 'rgba(0, 0, 0, 0)'
  while (node) {
    const c = getComputedStyle(node).backgroundColor
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bg = c; break }
    node = node.parentElement
  }
  const toHex = (rgb) => '#' + rgb.match(/\\d+/g).slice(0,3).map(n => Number(n).toString(16).padStart(2,'0')).join('')
  const [x, y] = [lum(toHex(fg)), lum(toHex(bg))].sort((a,b) => b-a)
  return { fg, bg, ratio: (x + 0.05) / (y + 0.05) }
}
"""


def main():
    email = f"t_{uuid.uuid4().hex[:8]}@test.dev"
    password = "passw0rd!x"
    me, cookie = api("/api/auth/register", {
        "email": email, "password": password, "display_name": "韧性审查",
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    if not cookie:
        print("注册失败，无法继续")
        return 1
    agent, _ = api("/api/agents", {"display_name": "韧性AI"}, cookie)
    agent_id = (agent.get("agent") or {}).get("id")
    group, _ = api("/api/conversations", {"title": "韧性验证群", "member_ids": [agent_id]}, cookie)
    gid = (group.get("conversation") or {}).get("id")
    empty, _ = api("/api/conversations", {"title": "韧性空群", "member_ids": []}, cookie)
    empty_id = (empty.get("conversation") or {}).get("id")
    long_text = "这是一段很长的消息，用来验证折叠。" * 60  # ≈ 1080 字，超过 600 阈值
    api(f"/api/conversations/{gid}/messages", {"body": long_text, "client_msg_id": uuid.uuid4().hex[:12]}, cookie)
    for text in ("第一条消息，用来长按", "第二条消息"):
        api(f"/api/conversations/{gid}/messages", {"body": text, "client_msg_id": uuid.uuid4().hex[:12]}, cookie)
    # 说说（送给「说说操作菜单 Esc」用例）
    api("/api/feeds", {"body": "韧性验证说说", "visibility": "friends", "client_msg_id": uuid.uuid4().hex[:12]}, cookie)

    host = urllib.parse.urlparse(BASE).hostname
    sid_value = cookie.split("=", 1)[1]

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()

        # ---------------------------------------------------------------- 桌面：错误态 / 空态 / 焦点 / 菜单 / 对比度
        ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        ctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        page = ctx.new_page()

        # 1) 注入 /api/conversations 失败
        page.route(re.compile(r"/api/conversations(\?[^/]*)?$"), lambda route: route.abort())
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".conv__error, .conv__list", timeout=30000)
        page.wait_for_timeout(600)
        err_block = page.locator(".conv__error")
        body_text = page.locator(".conv__list").inner_text() if page.locator(".conv__list").count() else ""
        check("加载失败 → 出现错误块（不是空态）", err_block.count() == 1, f"count={err_block.count()}")
        check("错误块含「加载失败」+「重试」", "加载失败" in body_text and page.get_by_role("button", name="重试").count() >= 1,
              body_text.replace("\n", " / ")[:80])
        check("失败时不再显示「还没有会话」", "还没有会话" not in body_text)
        page.screenshot(path=os.path.join(SHOTS, "fix-error-state.png"))

        # 2) 解除拦截 → 点重试 → 列表回来
        page.unroute(re.compile(r"/api/conversations(\?[^/]*)?$"))
        page.get_by_role("button", name="重试").first.click()
        page.wait_for_selector(".conv__item", timeout=20000)
        page.wait_for_timeout(400)
        check("恢复后点「重试」→ 会话列表回来", page.locator(".conv__item").count() > 0,
              f"items={page.locator('.conv__item').count()}")

        # 3) 进入有消息的群
        page.get_by_text("韧性验证群", exact=False).first.click()
        page.wait_for_selector(".msg", timeout=20000)
        page.wait_for_timeout(500)

        # 6.5) 超长消息折叠
        clamped = page.locator(".bubble__body--clamped")
        check("超长消息默认折叠（8 行 line-clamp）", clamped.count() >= 1, f"count={clamped.count()}")
        if clamped.count():
            h1 = clamped.first.evaluate("(el) => el.getBoundingClientRect().height")
            page.locator(".bubble__more").first.click()
            page.wait_for_timeout(300)
            h2 = page.evaluate("() => { const el = document.querySelector('.bubble__more')?.previousElementSibling; return el ? el.getBoundingClientRect().height : 0 }")
            check("折叠后高度 < 400px（4000 字不再占 8 屏）", h1 < 400, f"h={round(h1)}")
            check("点「展开全文」后展开（高度变大、无 clamp 类）",
                  h2 > h1 and page.locator(".bubble__body--clamped").count() == 0, f"{round(h1)} → {round(h2)}")
            page.locator(".bubble__more").first.click()
            page.wait_for_timeout(300)
            check("再点「收起」回到折叠态", page.locator(".bubble__body--clamped").count() >= 1)

        # 7) 回复按钮 focus-visible 可见（必须用键盘 Tab 到达，程序 focus() 不触发 :focus-visible）
        page.get_by_role("button", name="群设置").first.focus()
        hit = False
        for _ in range(6):
            page.keyboard.press("Tab")
            hit = page.evaluate("() => document.activeElement?.classList?.contains('msg__reply') === true")
            if hit:
                break
        page.wait_for_timeout(300)  # opacity 有 0.15s 过渡，别在动画中间读
        opacity = page.evaluate("() => getComputedStyle(document.activeElement).opacity") if hit else "0"
        check("键盘 Tab 到「回复」时可见（opacity=1）", hit and float(opacity) >= 0.99,
              f"focused_reply={hit} opacity={opacity}")

        # 9a) 浅色对比度：--text-3 实际比值
        light = page.evaluate(CONTRAST_JS, ".msg__stamp")
        check("浅色时间戳对比度 ≥4.5", bool(light) and light["ratio"] >= 4.5,
              json.dumps(light, ensure_ascii=False))

        # 5/6) 空群 + 加载态语义：用「没打开过的空群 + 网络延迟」观察真实的 loading 窗口
        #     （page.route 里不能 wait_for_timeout，会卡住事件循环；用 CDP 加延迟最干净）
        cdp = ctx.new_cdp_session(page)
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", {
            "offline": False, "latency": 1500, "downloadThroughput": -1, "uploadThroughput": -1,
        })
        page.get_by_role("button", name=re.compile("韧性空群")).first.click()
        page.wait_for_selector(".messages__loading", timeout=20000)
        loading_role = page.locator(".messages__loading").get_attribute("role")
        check("加载态有 role=status", loading_role == "status", f"role={loading_role}")
        page.wait_for_selector(".messages__empty", timeout=30000)
        empty_role = page.locator(".messages__empty").get_attribute("role")
        check("空群用 .messages__empty + role=status", empty_role == "status", f"role={empty_role}")
        cdp.send("Network.emulateNetworkConditions", {
            "offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1,
        })
        page.wait_for_timeout(300)

        # 8) 说说菜单 Esc 可关
        page.get_by_role("tab", name="空间").first.click()
        page.wait_for_selector(".feed, .feed-item, article", timeout=20000)
        page.wait_for_timeout(800)
        more = page.locator("article button[aria-label*='更多'], .feed button[aria-label*='更多']").first
        if more.count():
            more.click()
            page.wait_for_selector(".ms-actions", timeout=10000)
            opened = page.locator(".ms-actions").count() == 1
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            check("说说菜单 Esc 可关", opened and page.locator(".ms-actions").count() == 0,
                  f"opened={opened}")
        else:
            check("说说菜单 Esc 可关", False, "没找到「更多操作」按钮")

        # 9b) 深色对比度
        dark_ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN", color_scheme="dark")
        dark_ctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        dark = dark_ctx.new_page()
        dark.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        dark.wait_for_selector(".conv__item", timeout=30000)
        dark.wait_for_timeout(600)
        dark_val = dark.evaluate(CONTRAST_JS, ".conv__time")
        check("深色会话时间对比度 ≥4.5", bool(dark_val) and dark_val["ratio"] >= 4.5,
              json.dumps(dark_val, ensure_ascii=False))
        dark.screenshot(path=os.path.join(SHOTS, "fix-dark-contrast.png"))
        dark_ctx.close()
        ctx.close()

        # ---------------------------------------------------------------- 移动端：长按面板
        mctx = b.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN",
                             is_mobile=True, has_touch=True, device_scale_factor=2)
        mctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        mp = mctx.new_page()
        mp.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        mp.wait_for_selector(".conv__item", timeout=30000)
        mp.get_by_text("韧性验证群", exact=False).first.click()
        mp.wait_for_selector(".msg--mine", timeout=20000)
        mp.wait_for_timeout(600)

        bubble = mp.locator(".msg--mine .bubble").first
        box = bubble.bounding_box()
        cdp = mctx.new_cdp_session(mp)
        cdp.send("Input.dispatchTouchEvent", {
            "type": "touchStart",
            "touchPoints": [{"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2}],
        })
        mp.wait_for_timeout(750)
        during = mp.locator(".ms-actions").count() == 1
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        mp.wait_for_timeout(600)  # 原来的 bug 在松手后 ~60ms 就关了
        after = mp.locator(".ms-actions").count() == 1
        check("长按弹出面板", during, f"during={during}")
        check("松手后面板仍在（修复 P1-1）", after, f"after-release={after}")
        mp.screenshot(path=os.path.join(SHOTS, "fix-longpress-open.png"))

        # 4) 点遮罩仍能关
        if after:
            mp.touchscreen.tap(30, 200)
            mp.wait_for_timeout(400)
            check("点遮罩仍能关闭面板", mp.locator(".ms-actions").count() == 0)
        else:
            check("点遮罩仍能关闭面板", False, "面板已不在，无法验证")

        mctx.close()

        # ---------------------------------------------------------------- P1-1 顶层错误边界
        # 用「lazy chunk 加载失败」触发真实渲染异常（部署后 chunks 换 hash / 断网就是这个场景）
        eb_ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        eb_ctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        eb = eb_ctx.new_page()
        eb_ctx.route(re.compile(r".*/assets/SpaceView-.*\.js$"), lambda route: route.abort())
        eb.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        eb.wait_for_selector(".conv__item", timeout=30000)
        eb.get_by_role("tab", name="空间").first.click()
        eb.wait_for_selector(".crash", timeout=20000)
        eb.wait_for_timeout(300)
        crash_text = eb.locator(".crash").inner_text()
        check("lazy chunk 失败 → 显示兜底页而不是白屏", "页面出错了" in crash_text, crash_text.replace("\n", " / ")[:80])
        check("兜底页有「重新加载」「回到首页」两个出口",
              eb.get_by_role("button", name="重新加载").count() == 1
              and eb.get_by_role("button", name="回到首页").count() == 1)
        eb.screenshot(path=os.path.join(SHOTS, "fix-error-boundary.png"))
        eb_ctx.close()

        # ---------------------------------------------------------------- P1-2 启动请求超时
        # /api/me 一直不返回：没有超时就会永远停在「正在确认登录状态…」
        bo_ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        bo = bo_ctx.new_page()
        held_me = []  # 挂起的请求要显式 abort，否则关浏览器时 playwright 会抛 TargetClosedError

        def hold_me(route):
            held_me.append(route)

        bo_ctx.route(re.compile(r".*/api/me$"), hold_me)
        bo.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        bo.wait_for_selector(".splash", timeout=15000)
        try:
            bo.wait_for_selector("text=连接失败", timeout=25000)
            timed_out = True
        except Exception:
            timed_out = False
        check("启动请求挂起 → 15 秒超时后出现「连接失败 + 重试」", timed_out,
              bo.locator(".splash").inner_text().replace("\n", " / ")[:80] if bo.locator(".splash").count() else "no splash")
        if timed_out:
            bo.screenshot(path=os.path.join(SHOTS, "fix-boot-timeout.png"))
            bo_ctx.unroute(re.compile(r".*/api/me$"))
            for held in held_me:
                try:
                    held.abort()
                except Exception:
                    pass
            held_me.clear()
            bo.get_by_role("button", name="重试").click()
            bo.wait_for_selector(".conv__item, input[type=email]", timeout=30000)
            check("点「重试」后能恢复到应用（不再卡住）",
                  bo.locator(".conv__item").count() > 0 or bo.locator("input[type=email]").count() > 0)
        else:
            check("点「重试」后能恢复到应用（不再卡住）", False, "超时屏没出现")
        bo_ctx.close()

        # ---------------------------------------------------------------- P1-3 焦点陷阱 + 归还
        ft_ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        ft_ctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        ft = ft_ctx.new_page()
        ft.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        ft.wait_for_selector(".conv__item", timeout=30000)
        ft.get_by_text("韧性验证群", exact=False).first.click()
        ft.wait_for_selector(".msg", timeout=20000)
        trigger = ft.get_by_role("button", name="群设置").first
        trigger.click()
        ft.wait_for_selector(".modal", timeout=15000)
        ft.wait_for_timeout(300)
        escaped = False
        for _ in range(15):
            ft.keyboard.press("Tab")
            inside = ft.evaluate("() => !!document.querySelector('.modal')?.contains(document.activeElement)")
            if not inside:
                escaped = True
                break
        check("弹窗打开后连按 15 次 Tab，焦点不出弹窗（焦点陷阱）", not escaped)
        ft.screenshot(path=os.path.join(SHOTS, "fix-focus-trap.png"))
        ft.keyboard.press("Escape")
        ft.wait_for_timeout(300)
        restored = ft.evaluate("() => document.activeElement?.getAttribute('aria-label') === '群设置'")
        check("Esc 关闭后焦点回到触发按钮（焦点归还）", restored,
              ft.evaluate("() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName"))
        ft_ctx.close()

        try:
            b.close()
        except Exception:
            pass

    print()
    if problems:
        print(f"有失败：{len(problems)} 条")
        for x in problems:
            print(" - " + x)
        return 1
    print(f"全部通过：聊天韧性/可访问性 + 前端 P1 共 {len(executed)} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
