# -*- coding: utf-8 -*-
"""真机安全区回归（iPhone 刘海 / Home 条 / 横屏耳朵）。

为什么要有这条：`docs/交接-2026-11-14.md` §7 长期挂着「真机安全区/软键盘未修」，
而宣传主张是「手机和电脑同群同秒到」——手机上如果输入框被 Home 条压住、标题被刘海压住，
这条主张就不成立。桌面浏览器永远看不出这个问题，只能靠 emulation 量几何。

做法（关键设计）：
- CSS 里安全区先落到变量：`--safe-top/bottom/left/right = env(safe-area-inset-*, 0px)`
  （02-base.css:root）。这样既给老浏览器 0px 兜底，也让本脚本能在**没有刘海的 headless**
  里注入假值（47/34/44）去量「输入框离屏幕底 ≥34px」「标题不被刘海压」。
- 断言分两层：
  1) 静态：CSS 源文件里 env() → var() 的映射还在（防止有人删掉后真机静默失效）；
  2) 运行时：注入假值后量几何（竖屏顶部/底部、横屏左右）。

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-safe-area.py
"""
import json
import os
import sys
import uuid
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ] if c and os.path.exists(c)),
    None,
)
problems = []


def check(name, ok, detail=""):
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


MEASURE_JS = """
(insets) => {
  const root = document.documentElement
  for (const [k, v] of Object.entries(insets)) root.style.setProperty(k, v + 'px')
  // 强制一次布局，确保 var 改动已经生效
  void document.body.offsetHeight
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    composerBox: rect('.composer__box'),
    composerInput: rect('.composer__input'),
    chatHead: rect('.chat__head'),
    chatTitle: rect('.chat__title'),
    shellPadTop: getComputedStyle(document.querySelector('.shell')).paddingTop,
    shellPadLeft: getComputedStyle(document.querySelector('.shell')).paddingLeft,
    shellPadRight: getComputedStyle(document.querySelector('.shell')).paddingRight,
  }
}
"""


def static_checks():
    base_css = os.path.join(ROOT, "web", "src", "styles", "02-base.css")
    mobile_css = os.path.join(ROOT, "web", "src", "styles", "17-mobile.css")
    if not os.path.exists(base_css):
        print("SKIP  静态断言（源码不在：生产机只部署 web/dist）")
        return
    base_src = open(base_css, encoding="utf-8").read()
    mobile_src = open(mobile_css, encoding="utf-8").read()
    check("静态：--safe-top 映射到 env(safe-area-inset-top)（真机的值仍来自系统）",
          "env(safe-area-inset-top" in base_src and "--safe-top:" in base_src)
    check("静态：--safe-bottom 映射到 env(safe-area-inset-bottom)",
          "env(safe-area-inset-bottom" in base_src and "--safe-bottom:" in base_src)
    check("静态：移动端外壳用 var(--safe-left/right)（横屏耳朵）",
          "var(--safe-left)" in mobile_src and "var(--safe-right)" in mobile_src)
    check("静态：输入栏用 var(--safe-bottom)（Home 条）",
          "calc(8px + var(--safe-bottom))" in mobile_src)
    check("静态：viewport-fit=cover 仍在（否则 iOS 的 env() 恒为 0）",
          "viewport-fit=cover" in open(os.path.join(ROOT, "web", "index.html"), encoding="utf-8").read())


def main():
    static_checks()

    email = f"sa_{uuid.uuid4().hex[:8]}@test.dev"
    me, cookie = api("/api/auth/register", {
        "email": email, "password": "passw0rd!x", "display_name": "安全区审查",
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    if not cookie:
        print("注册失败")
        return 1
    agent, _ = api("/api/agents", {"display_name": "安全区AI"}, cookie)
    agent_id = (agent.get("agent") or {}).get("id")
    group, _ = api("/api/conversations", {"title": "安全区验证群", "member_ids": [agent_id]}, cookie)
    gid = (group.get("conversation") or {}).get("id")
    api(f"/api/conversations/{gid}/messages", {"body": "安全区验证消息", "client_msg_id": uuid.uuid4().hex[:12]}, cookie)

    import urllib.parse
    host = urllib.parse.urlparse(BASE).hostname
    sid = cookie.split("=", 1)[1]

    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()

        # ---------- 竖屏：iPhone 390×844，刘海 47 / Home 条 34 ----------
        ctx = b.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN",
                            is_mobile=True, has_touch=True, device_scale_factor=3)
        ctx.add_cookies([{"name": "sid", "value": sid, "domain": host, "path": "/"}])
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".conv__item", timeout=30000)
        page.click(".conv__item", timeout=15000)
        page.wait_for_selector(".composer__input", timeout=30000)
        page.wait_for_timeout(400)

        m = page.evaluate(MEASURE_JS, {"--safe-top": 47, "--safe-bottom": 34, "--safe-left": 0, "--safe-right": 0})
        page.screenshot(path=os.path.join(SHOTS, "safe-area-portrait.png"))

        gap_bottom = m["vh"] - (m["composerBox"]["bottom"] if m["composerBox"] else m["vh"])
        gap_input = m["vh"] - (m["composerInput"]["bottom"] if m["composerInput"] else m["vh"])
        check("竖屏：输入框容器离屏幕底 ≥34px（Home 条）", gap_bottom >= 34, f"实际 {gap_bottom}px（vh={m['vh']}）")
        check("竖屏：可输入区离屏幕底 ≥34px", gap_input >= 34, f"实际 {gap_input}px")
        check("竖屏：标题不被刘海压（top ≥47px）",
              bool(m["chatTitle"]) and m["chatTitle"]["top"] >= 47, f"title.top={m['chatTitle']['top'] if m['chatTitle'] else 'None'}")
        check("竖屏：头部不越过安全区（head.top ≥47px）",
              bool(m["chatHead"]) and m["chatHead"]["top"] >= 47, f"head.top={m['chatHead']['top'] if m['chatHead'] else 'None'}")
        check("竖屏：外壳 padding-top 已吃到 47px", m["shellPadTop"] == "47px", f"实际 {m['shellPadTop']}")
        ctx.close()

        # ---------- 横屏：844×390，左右耳朵各 44 ----------
        ctx = b.new_context(viewport={"width": 844, "height": 390}, locale="zh-CN",
                            is_mobile=True, has_touch=True, device_scale_factor=3)
        ctx.add_cookies([{"name": "sid", "value": sid, "domain": host, "path": "/"}])
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".conv__item", timeout=30000)
        page.click(".conv__item", timeout=15000)
        page.wait_for_selector(".composer__input", timeout=30000)
        page.wait_for_timeout(400)

        m = page.evaluate(MEASURE_JS, {"--safe-top": 0, "--safe-bottom": 21, "--safe-left": 44, "--safe-right": 44})
        page.screenshot(path=os.path.join(SHOTS, "safe-area-landscape.png"))

        left = m["chatHead"]["left"] if m["chatHead"] else -1
        right = m["chatHead"]["right"] if m["chatHead"] else 10 ** 6
        check("横屏：头部左边缘 ≥44px（左耳朵）", left >= 44, f"head.left={left}")
        check("横屏：头部右边缘 ≤ vw-44px（右耳朵）", right <= m["vw"] - 44, f"head.right={right}, vw={m['vw']}")
        check("横屏：外壳 padding-left/right 都吃到 44px",
              m["shellPadLeft"] == "44px" and m["shellPadRight"] == "44px",
              f"{m['shellPadLeft']} / {m['shellPadRight']}")
        gap_bottom = m["vh"] - (m["composerBox"]["bottom"] if m["composerBox"] else m["vh"])
        check("横屏：输入框离屏幕底 ≥21px（Home 条在横屏更矮）", gap_bottom >= 21, f"实际 {gap_bottom}px")
        ctx.close()

        b.close()

    if problems:
        print(f"\n有失败：{len(problems)} 条")
        for item in problems:
            print("  - " + item)
        return 1
    print("\n全部通过：真机安全区（竖屏顶部/底部 + 横屏左右）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
