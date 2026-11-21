# -*- coding: utf-8 -*-
"""前端评审（2026-11-15）P1/P2 修复回归。

每条用例对应评审里的一个编号，改坏了就会红：
  1. P1-1  iOS 输入缩放：会话搜索框计算字号必须 16px。手机（390×844）和桌面宽度（1280×900）
          两处都量——评审抓到的真窟窿是「基础规则 14px」，它只在横屏/宽窗口露出来，
          手机竖屏靠 26-search.css 的 ≤760px 覆盖本来就没问题（所以只量竖屏会漏掉这个 bug）。
  2. P1-2/M4  `.msg__reply` 死代码：触屏上必须不可见也不可点（33-touch-targets 的 display:none
          生效；17-mobile 里那条 `@media (hover:none) { .msg__reply { opacity: .85 } }` 已删，
          否则两处规则互相打架，后来人会照注释把功能改回去）。触屏的「引用」走长按菜单。
  3. M1  横屏：844×390 + 粗指针必须走移动布局（底部 `.tabbar` 可见、`.topnav` 隐藏、
          外壳纵向排列），不能掉回桌面三栏——掉回去键盘一弹就把输入栏盖住。
  4. V2  头像：把 /api/me 的 avatarUrl 改成 `javascript:alert(1)`，页面绝不许把它写进 <img src>；
          同时用合法站内地址做对照，确认合法头像照常显示（不能把头像一起修坏）。
  5. V1  表情包白名单：前端是 TS，脚本里 import 不了，所以做静态断言——
          `parts.ts` 里必须有 `^[A-Za-z0-9_-]{1,64}$`，`stickers.ts` 拼路径前必须用它做前置校验；
          再把**同一份**正则（从源码里读出来的，不是抄一份常量）交给 node 跑单测，
          确认 `../etc`、`a b` 这类被拒、`deepwhale-placeholder` 这类合法值放行。
  6. T1  订阅轮换：静态断言 `public/sw.js` 监听 `pushsubscriptionchange`、按 `/api/push/key`
          取公钥、带 cookie POST `/api/push/subscribe`、失败时降级 postMessage；
          `push-client.ts` 有对应的 message 处理器，且两边消息类型字符串一致。
          （真机密钥轮换没法在自动化里触发，这一步只能静态守；真机验收见交接文档）
  7. P2-11 搜索清除键热区：触屏上 `.conv__search-clear` 有效热区 ≥40×40。用和
          `verify-touch-targets.py` 一样的逐像素 elementFromPoint 探测——那个脚本扫的是
          「搜索框为空」的会话列表，清除键压根不在 DOM 里，所以这里单独补一条。

注意：第 5/6 条（V1 白名单、T1 SW 接线）读的是**源码文件**，和 BASE 指向哪个版本无关；
浏览器类用例（1/2/3/4/7）才受「BASE 上是旧构建还是新构建」影响。

BASE 要指到「源码版」还是「构建产物版」取决于你要验什么：
  - 验构建产物/线上：BASE=http://127.0.0.1:8787（后端静态托管 web/dist）
  - 验未构建的源码：先 `cd web && npx vite --port 5173`（/api 已代理到 8787），
    再 `BASE=http://127.0.0.1:5173 python scripts/verify/verify-frontend-review-fixes.py`
  改了 web/src 但没重新构建时，8787 上跑出来会是旧样式——那不是脚本的错。

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-frontend-review-fixes.py
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import uuid

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB_SRC = os.path.join(ROOT, "web", "src")
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

FONT_JS = """() => {
  const el = document.querySelector('.conv__search-input')
  if (!el) return null
  const cs = getComputedStyle(el)
  return { size: cs.fontSize, coarse: matchMedia('(pointer: coarse)').matches }
}"""

REPLY_JS = """() => {
  const els = Array.from(document.querySelectorAll('.msg__reply'))
  if (!els.length) return { found: false }
  const el = els[0]
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const hit = (r.width > 0 && r.height > 0) ? document.elementFromPoint(cx, cy) : null
  return {
    found: true,
    count: els.length,
    display: cs.display,
    opacity: cs.opacity,
    w: Math.round(r.width),
    h: Math.round(r.height),
    // 盒子为 0 或中心点打不到自己 = 点不到
    clickable: !!hit && (hit === el || el.contains(hit)),
  }
}"""

LAYOUT_JS = """() => {
  const tab = document.querySelector('.tabbar')
  const nav = document.querySelector('.topnav')
  const body = document.querySelector('.shell__body')
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    tabDisplay: tab ? getComputedStyle(tab).display : 'missing',
    navDisplay: nav ? getComputedStyle(nav).display : 'missing',
    bodyDirection: body ? getComputedStyle(body).flexDirection : 'missing',
    width: innerWidth,
    height: innerHeight,
  }
}"""

AVATAR_JS = """() => {
  const imgs = Array.from(document.querySelectorAll('.conv__me .avatar img'))
  return {
    count: imgs.length,
    srcs: imgs.map((i) => i.getAttribute('src')),
    bad: Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src') || '')
      .filter((s) => /^\\s*javascript:/i.test(s)),
  }
}"""

CLEAR_HIT_JS = """() => {
  const el = document.querySelector('.conv__search-clear')
  if (!el) return { found: false }
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const hit = (x, y) => {
    if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) return false
    const n = document.elementFromPoint(x, y)
    return !!n && (n === el || el.contains(n))
  }
  // 沿四个方向逐像素探（透明 ::after 扩出来的也算），和 verify-touch-targets.py 同一套方法
  let left = 0, right = 0, up = 0, down = 0
  const CAP = 32
  while (left < CAP && hit(cx - left - 1, cy)) left += 1
  while (right < CAP && hit(cx + right + 1, cy)) right += 1
  while (up < CAP && hit(cx, cy - up - 1)) up += 1
  while (down < CAP && hit(cx, cy + down + 1)) down += 1
  return {
    found: true,
    box: [Math.round(r.width), Math.round(r.height)],
    effW: left + right + 1,
    effH: up + down + 1,
  }
}"""


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


def read_source(rel):
    """按 utf-8 读源码（中文注释多，别用系统默认编码）"""
    with open(os.path.join(WEB_SRC, rel), "r", encoding="utf-8") as fh:
        return fh.read()


def storefront(path):
    """读 web 下的非 src 文件（public/sw.js 这类）"""
    with open(os.path.join(ROOT, "web", path), "r", encoding="utf-8") as fh:
        return fh.read()


def static_checks():
    """5/6/7 里不需要浏览器的部分：白名单正则、SW 接线。"""
    parts = read_source("parts.ts")
    stickers = read_source("stickers.ts")

    # ---- V1：白名单正则存在，且是「length 1..64 的字母数字下划线连字符」
    m = re.search(r"STICKER_ID_RE\s*=\s*/(.+?)/\s*$", parts, re.M)
    pattern = m.group(1) if m else None
    check("V1 parts.ts 有 STICKER_ID_RE 白名单正则", bool(pattern), pattern or "没找到 STICKER_ID_RE")
    if pattern:
        check("V1 白名单形状对（字符类 + {1,64}）",
              "A-Za-z0-9_-" in pattern and "{1,64}" in pattern, pattern)
        # 归一化层必须用它拦下非法 pack/key，否则非法值仍会进渲染层
        check("V1 parts.ts#normalizeSticker 用白名单拦非法 pack/key",
              "isValidStickerId(pack)" in parts and "isValidStickerId(key)" in parts)
        check("V1 stickers.ts#stickerSrc 拼路径前做同样的前置校验",
              "isValidStickerId(pack)" in stickers and "isValidStickerId(key)" in stickers
              and "return null" in stickers)
        # 用源码里那份正则跑单测（不是另抄一份常量：改源码这里会跟着变）
        js = """
const re = new RegExp(%s)
const cases = [
  ['ok', true], ['deepwhale-placeholder', true], ['a_b-9', true], ['A1', true],
  ['../etc', false], ['a b', false], ['', false], ['a/b', false],
  ['ok?x=1', false], ['a'.repeat(64), true], ['a'.repeat(65), false],
]
const bad = cases.filter(([v, want]) => re.test(v) !== want).map(([v]) => v)
process.stdout.write(JSON.stringify({ bad }))
""" % json.dumps(pattern)
        try:
            out = subprocess.run(["node", "-e", js], capture_output=True, text=True,
                                 timeout=60, cwd=ROOT)
            bad = json.loads(out.stdout or "{}").get("bad", ["node 无输出"])
        except Exception as err:  # node 不在 PATH 上也要算失败，别静默通过
            bad = ["node 跑不起来: %s" % err]
        check("V1 非法 pack/key 被拒、合法值放行（../etc / a b / 空 / 超长）", bad == [], bad)

    # ---- T1：SW 轮换链路 + 前端降级处理器
    sw = storefront("public/sw.js")
    push = read_source("push-client.ts")
    check("T1 sw.js 监听 pushsubscriptionchange", "addEventListener('pushsubscriptionchange'" in sw)
    check("T1 SW 用 /api/push/key 取 VAPID 公钥（status 接口不带公钥）",
          "/api/push/key" in sw and "applicationServerKey" in sw)
    check("T1 SW 上报走 POST /api/push/subscribe 且带 cookie",
          "/api/push/subscribe" in sw and "credentials: 'include'" in sw
          and "method: 'POST'" in sw)
    check("T1 拿不到公钥时降级为页面 postMessage",
          "matchAll" in sw and "postMessage" in sw)
    sw_msg = re.search(r"RESUBSCRIBE_MESSAGE\s*=\s*'([^']+)'", sw)
    fe_msg = re.search(r"RESUBSCRIBE_MESSAGE\s*=\s*'([^']+)'", push)
    check("T1 SW 与页面的消息类型字符串一致",
          bool(sw_msg) and bool(fe_msg) and sw_msg.group(1) == fe_msg.group(1),
          "%s vs %s" % (sw_msg.group(1) if sw_msg else "?", fe_msg.group(1) if fe_msg else "?"))
    check("T1 前端装了 serviceWorker message 处理器",
          "addEventListener('message'" in push and "installPushResubscribeHandler" in push)
    main = read_source("main.tsx")
    check("T1 处理器在启动时被装上（main.tsx）", "installPushResubscribeHandler()" in main)


def main():
    static_checks()

    email = f"t_{uuid.uuid4().hex[:8]}@test.dev"
    password = "passw0rd!x"
    me, cookie = api("/api/auth/register", {
        "email": email, "password": password, "display_name": "评审修复",
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    if not cookie:
        print("注册失败，无法继续（服务器没起？REGISTER_CODE 对不对？）")
        return 1
    agent, _ = api("/api/agents", {"display_name": "评审AI"}, cookie)
    agent_id = (agent.get("agent") or {}).get("id")
    group, _ = api("/api/conversations", {"title": "评审验证群", "member_ids": [agent_id]}, cookie)
    gid = (group.get("conversation") or {}).get("id")
    api(f"/api/conversations/{gid}/messages",
        {"body": "评审回归用消息", "client_msg_id": uuid.uuid4().hex[:12]}, cookie)

    host = urllib.parse.urlparse(BASE).hostname
    sid_value = cookie.split("=", 1)[1]

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()

        # ---------------------------------------------------------------- 1) iOS 输入缩放（手机竖屏）
        mctx = b.new_context(viewport={"width": 390, "height": 844}, locale="zh-CN",
                             is_mobile=True, has_touch=True, device_scale_factor=2)
        mctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        mp = mctx.new_page()
        mp.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        mp.wait_for_selector(".conv__item", timeout=30000)
        mp.wait_for_timeout(400)
        font = mp.evaluate(FONT_JS)
        check("P1-1 390×844 搜索框计算字号 = 16px（iOS 聚焦不缩放）",
              bool(font) and font["size"] == "16px", json.dumps(font))
        mp.screenshot(path=os.path.join(SHOTS, "fix-ios-search-font.png"))

        # ---------------------------------------------------------------- 7) 清除键热区（要先输入才有这个键）
        mp.fill(".conv__search-input", "评审")
        mp.wait_for_timeout(400)
        clear_hit = mp.evaluate(CLEAR_HIT_JS)
        check("P2-11 触屏搜索清除键有效热区 ≥40×40",
              bool(clear_hit) and clear_hit.get("found") is True
              and clear_hit["effW"] >= 40 and clear_hit["effH"] >= 40,
              json.dumps(clear_hit))
        mp.fill(".conv__search-input", "")
        mp.wait_for_timeout(300)

        # ---------------------------------------------------------------- 2) .msg__reply 在触屏不可见/不可点
        mp.get_by_text("评审验证群", exact=False).first.click()
        mp.wait_for_selector(".msg", timeout=20000)
        mp.wait_for_timeout(500)
        reply = mp.evaluate(REPLY_JS)
        hidden = bool(reply) and reply.get("found") is True and (
            reply["display"] == "none" or (float(reply["opacity"]) == 0.0 and not reply["clickable"]))
        check("P1-2 触屏上 .msg__reply 不可见且不可点（display:none 生效）",
              hidden, json.dumps(reply, ensure_ascii=False))
        check("P1-2 触屏上 .msg__reply 也点不到（盒子为 0 或中心点打不到自己）",
              bool(reply) and reply.get("found") is True and reply["clickable"] is False,
              json.dumps(reply, ensure_ascii=False))
        # 触屏的「引用」入口还在：长按菜单
        mctx.close()

        # ---------------------------------------------------------------- 3) 横屏 844×390 走移动布局
        lctx = b.new_context(viewport={"width": 844, "height": 390}, locale="zh-CN",
                             is_mobile=True, has_touch=True, device_scale_factor=2)
        lctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        lp = lctx.new_page()
        lp.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        lp.wait_for_selector(".conv__item", timeout=30000)
        lp.wait_for_timeout(500)
        layout = lp.evaluate(LAYOUT_JS)
        # 先确认「模拟环境真的是粗指针」，否则这条用例等于在桌面上量了个假的通过
        check("M1 横屏上下文确实是粗指针（hasTouch 生效）", layout.get("coarse") is True,
              json.dumps(layout, ensure_ascii=False))
        check("M1 844×390 走移动布局：底部 Tab 可见 + 顶部胶囊导航隐藏",
              layout.get("tabDisplay") not in ("none", "missing")
              and layout.get("navDisplay") == "none",
              json.dumps(layout, ensure_ascii=False))
        # 进会话后再补一条「形态证据」：手机是横向推入，会有可见的「返回会话列表」；
        # 桌面三栏没有这个按钮（一致量的话它在旧构建上就是隐藏的）。
        lp.get_by_text("评审验证群", exact=False).first.click()
        lp.wait_for_selector(".msg", timeout=20000)
        lp.wait_for_timeout(500)
        back = lp.locator("button[aria-label='返回会话列表']").first
        check("M1 横屏进会话后是手机「横向推入」形态（有可见的返回会话列表）",
              back.count() == 1 and back.is_visible(),
              f"count={back.count()} visible={back.is_visible() if back.count() else 'n/a'}")
        lp.screenshot(path=os.path.join(SHOTS, "fix-landscape-mobile.png"))
        lctx.close()

        # ---------------------------------------------------------------- 1b) 桌面宽度也必须 16px
        # 评审的真窟窿在基础规则（14px）：横屏/宽窗口那些不进 ≤760px 分支的场景才会缩放
        dctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        dctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        dp = dctx.new_page()
        dp.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        dp.wait_for_selector(".conv__item", timeout=30000)
        dp.wait_for_timeout(300)
        dfont = dp.evaluate(FONT_JS)
        check("P1-1 1280×900（基础规则）搜索框字号也是 16px",
              bool(dfont) and dfont["size"] == "16px", json.dumps(dfont))
        dctx.close()

        # ---------------------------------------------------------------- 4) V2 头像 URL 过滤
        me_now, _ = api("/api/me", None, cookie, method="GET")
        # 4a 对照：合法站内相对地址必须照常渲染（别把头像一起修坏）
        good = dict(me_now)
        good["avatarUrl"] = "/icons/icon-192.png"
        gctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        gctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        gctx.route(re.compile(r".*/api/me$"), lambda route: route.fulfill(
            status=200, headers={"content-type": "application/json; charset=utf-8"},
            body=json.dumps(good, ensure_ascii=False)))
        gp = gctx.new_page()
        gp.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        gp.wait_for_selector(".conv__item", timeout=30000)
        gp.wait_for_timeout(800)
        gavatar = gp.evaluate(AVATAR_JS)
        check("V2 对照：合法头像地址照常渲染成 <img>",
              gavatar["count"] == 1 and gavatar["srcs"] and gavatar["srcs"][0].endswith("/icons/icon-192.png"),
              json.dumps(gavatar, ensure_ascii=False))
        gctx.close()

        # 4b 注入：javascript: 必须被 safeMediaUrl 拦掉 → 回退几何头像（没有 <img>）
        bad = dict(me_now)
        bad["avatarUrl"] = "javascript:alert(1)"
        bctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        bctx.add_cookies([{"name": "sid", "value": sid_value, "domain": host, "path": "/"}])
        bctx.route(re.compile(r".*/api/me$"), lambda route: route.fulfill(
            status=200, headers={"content-type": "application/json; charset=utf-8"},
            body=json.dumps(bad, ensure_ascii=False)))
        bp = bctx.new_page()
        bp.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        bp.wait_for_selector(".conv__item", timeout=30000)
        bp.wait_for_timeout(800)
        bavatar = bp.evaluate(AVATAR_JS)
        check("V2 javascript: 头像不出现在任何 <img src>", bavatar["bad"] == [],
              json.dumps(bavatar, ensure_ascii=False))
        check("V2 非法头像回退几何图案（.conv__me 下没有 <img>）", bavatar["count"] == 0,
              json.dumps(bavatar, ensure_ascii=False))
        bp.screenshot(path=os.path.join(SHOTS, "fix-avatar-injection.png"))
        bctx.close()

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
    print(f"全部通过：前端评审 P1/P2 修复 {len(executed)} 条（含静态断言）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
