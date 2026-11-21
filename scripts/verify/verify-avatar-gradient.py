# -*- coding: utf-8 -*-
"""头像渐变回归：同一页面出现多个「同一个人」的头像时，渐变必须还在。

为什么：`Avatar.tsx` 以前用 `ag${seed % 991}${ai?'x':'y'}` 当 SVG 渐变 id。
同一个人的头像在会话列表 + 每条消息里各出现一次，就会生成**多个相同的 id**；
SVG 里 id 必须文档内唯一，Chromium 只认第一份，后面的 `<rect fill="url(#ag123y)">`
全部解析到第一个 `<linearGradient>` —— 表现出来就是「消息头像退化成平涂色块」。
宣传片里的界面是按真实 DOM 渲染的，所以这个缺陷会原样进片子。

本脚本的两层断言：
  1. 同一页 ≥3 个同一人的头像（同一发送者连发多条）；
  2. 全页 `[id^="ag"]` **无重复**；并且每个 `rect[fill="url(#…")]` 的 id
     必须在**它自己那个 <svg> 内**存在（跨引用会漏过去，所以不能只查全页唯一）。

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-avatar-gradient.py
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


# 返回：消息里的头像数量、id 列表、跨引用数量、发送者名集合
AUDIT_JS = """
() => {
  const arts = Array.from(document.querySelectorAll('.msg .avatar__art'))
  const ids = []
  const crossRefs = []
  arts.forEach((svg, idx) => {
    svg.querySelectorAll('[id]').forEach((el) => ids.push(el.id))
    svg.querySelectorAll('rect[fill^="url(#"]').forEach((rect) => {
      const m = (rect.getAttribute('fill') || '').match(/url\\(#([^)]+)\\)/)
      if (!m) return
      // 浏览器的 url(#id) 是**文档级**解析：永远取文档里第一个该 id 的元素。
      // 所以「解析到自己的渐变」等价于：getElementById 拿到的就是我所在 svg 里的那一个。
      const first = document.getElementById(m[1])
      const own = svg.querySelector('#' + CSS.escape(m[1]))
      if (!own || first !== own) crossRefs.push({ idx, id: m[1] })
    })
  })
  const senders = Array.from(new Set(
    Array.from(document.querySelectorAll('.msg .msg__name')).map((el) => el.textContent.trim())
  ))
  return { count: arts.length, ids, crossRefs, senders }
}
"""


def main():
    v_email = f"av_{uuid.uuid4().hex[:8]}@test.dev"
    u_email = f"av_{uuid.uuid4().hex[:8]}@test.dev"
    V, vcookie = api("/api/auth/register", {
        "email": v_email, "password": "passw0rd!x", "display_name": "渐变发送者",
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    U, ucookie = api("/api/auth/register", {
        "email": u_email, "password": "passw0rd!x", "display_name": "渐变观察者",
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    if not vcookie or not ucookie:
        print("注册失败")
        return 1
    # 注册响应不带完整档案，统一从 /api/me 拿（accountNo / id 都在这里）
    V, _ = api("/api/me", None, vcookie, "GET")
    U, _ = api("/api/me", None, ucookie, "GET")
    # 只能拉好友进群（产品规则）
    api("/api/friends/request", {"account_no": V.get("accountNo")}, ucookie)
    api("/api/friends/accept", {"principal_id": U.get("id")}, vcookie)
    agent, _ = api("/api/agents", {"display_name": "渐变AI"}, ucookie)
    agent_id = (agent.get("agent") or {}).get("id")
    group, _ = api("/api/conversations", {
        "title": "头像渐变验证群", "member_ids": [agent_id, V.get("id")],
    }, ucookie)
    gid = (group.get("conversation") or {}).get("id")
    if not gid:
        print("建群失败：", group)
        return 1
    # 同一个发送者连发 4 条 → 消息列表里 4 个同一人的头像（修复前 id 会重复）
    for i in range(4):
        api(f"/api/conversations/{gid}/messages",
            {"body": f"渐变验证消息 {i + 1}", "client_msg_id": uuid.uuid4().hex[:12]}, vcookie)

    import urllib.parse
    host = urllib.parse.urlparse(BASE).hostname
    sid = ucookie.split("=", 1)[1]

    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
        ctx.add_cookies([{"name": "sid", "value": sid, "domain": host, "path": "/"}])
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".conv__item", timeout=30000)
        page.locator(".conv__item", has_text="头像渐变验证群").first.click()
        page.wait_for_selector(".msg .avatar__art", timeout=30000)
        page.wait_for_timeout(500)
        # 多等一会儿：如果渐变 id 冲突，Chromium 解析失败是静默的，DOM 不变但视觉退化
        page.wait_for_timeout(200)

        out = page.evaluate(AUDIT_JS)
        page.screenshot(path=os.path.join(SHOTS, "avatar-gradient-messages.png"))

        check("同一页出现 ≥3 个头像（同一发送者连发）", out["count"] >= 3, f"count={out['count']}")
        check("这些头像都属于同一个人（消息发送者唯一）", len(out["senders"]) == 1, f"senders={out['senders']}")
        dup = len(out["ids"]) - len(set(out["ids"]))
        check("全页 svg 内 id 无重复（id 必须文档内唯一）", dup == 0,
              f"ids={len(out['ids'])} unique={len(set(out['ids']))} 重复={dup}")
        check("每个 rect 的渐变都解析到它自己那个 <svg> 内的定义（不是跨引用第一个）",
              len(out["crossRefs"]) == 0, f"crossRefs={out['crossRefs'][:3]}")
        ctx.close()
        b.close()

    if problems:
        print(f"\n有失败：{len(problems)} 条")
        for item in problems:
            print("  - " + item)
        return 1
    print("\n全部通过：头像渐变（同页多头像 id 唯一 + 渐变自引用）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
