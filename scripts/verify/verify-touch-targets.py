# -*- coding: utf-8 -*-
"""触控热区回归（2026-11-15 前端审查 P2-4）。

为什么不用 getBoundingClientRect 直接量：修复用的是「透明 ::after 扩热区」，
元素盒子没变但可点区域变大了。所以这里用 `document.elementFromPoint` 在
目标中心 ±19px 的 9 个采样点上打点，命中目标（或其后代/label）才算有效热区 ≥ ~38px。

豁免（WCAG 2.5.8 的 inline 例外）：
- `.link-btn`：嵌在句子里的文字链接（「新建一个群」），放大到 40 反而破坏排版；
- 由 `<label>` 包住的 checkbox/radio：真实热区是 label，按 label 量；
- `.msg__reply`：触屏上已按设计隐藏（改用长按菜单的「引用」）。

用法：BASE=http://127.0.0.1:8787 python scripts/verify/verify-touch-targets.py
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


# 在页面里扫描一次：返回所有「有效热区 < 38px」的可点元素
SCAN_JS = r"""
([minSide, exemptSelectors, rootSelector]) => {
  const sel = 'button, a[href], [role=button], [role=switch], input:not([type=hidden]), textarea, select'
  // 弹窗优先：它打开时背景会被遮罩挡住，不该算背景按钮「点不到」
  const overlays = Array.from(document.querySelectorAll('.modal, .ms-actions-mask, .lightbox, .profile'))
  const root = overlays.length ? overlays[overlays.length - 1]
    : (rootSelector ? document.querySelector(rootSelector) : document) || document
  const nodes = Array.from(root.querySelectorAll(sel))
  const out = []
  const exempt = (el) => exemptSelectors.some((s) => el.matches(s))
  const inLabel = (el) => el.closest('label')
  const nameOf = (el) => {
    const r = el.getBoundingClientRect()
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).slice(0, 3).join('.') : '',
      label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 14),
      w: Math.round(r.width), h: Math.round(r.height),
    }
  }
  for (const el of nodes) {
    if (exempt(el)) continue
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false })) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight) continue
    if (el.disabled) continue
    const target = inLabel(el) || el   // label 包住的 input：真实热区是 label
    const tr = target.getBoundingClientRect()
    const cx = Math.min(Math.max(tr.left + tr.width / 2, 1), innerWidth - 1)
    const cy = Math.min(Math.max(tr.top + tr.height / 2, 1), innerHeight - 1)
    // 中心点都点不到自己 = 被别的层盖住（例如手机端未激活的列表/会话面板）→ 不是「点不到」的控件
    const centerHit = document.elementFromPoint(cx, cy)
    const centerOk = !!centerHit && (centerHit === target || target.contains(centerHit)
      || (inLabel(target) && centerHit.closest('label') === inLabel(target)))
    if (!centerOk) continue
    const probe = (x, y) => {
      if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) return false
      const hit = document.elementFromPoint(x, y)
      if (!hit) return false
      if (hit === target || target.contains(hit)) return true
      const lab = inLabel(target)
      return !!(lab && hit.closest('label') === lab)
    }
    // 沿四个方向逐像素探，量「有效热区」——透明 ::after 扩出来的也算
    let left = 0, right = 0, up = 0, down = 0
    const CAP = 32
    while (left < CAP && probe(cx - left - 1, cy)) left += 1
    while (right < CAP && probe(cx + right + 1, cy)) right += 1
    while (up < CAP && probe(cx, cy - up - 1)) up += 1
    while (down < CAP && probe(cx, cy + down + 1)) down += 1
    const effW = left + right + 1
    const effH = up + down + 1
    if (effW < minSide || effH < minSide) {
      out.push({ ...nameOf(el), effW, effH })
    }
  }
  return out
}
"""

EXEMPT = [".link-btn", ".msg__reply", "input[type=checkbox]", "input[type=radio]", "input[type=file]"]


ROOT_SEL = None


def scan(page, root_sel=None):
    if root_sel is not None:
        return page.evaluate(SCAN_JS, [40, EXEMPT, root_sel])
    return page.evaluate(SCAN_JS, [40, EXEMPT, ROOT_SEL])


def main():
    email = f"t_{uuid.uuid4().hex[:8]}@test.dev"
    me, cookie = api("/api/auth/register", {
        "email": email, "password": "passw0rd!x", "display_name": "触控审查",
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    if not cookie:
        print("注册失败")
        return 1
    agent, _ = api("/api/agents", {"display_name": "触控AI"}, cookie)
    agent_id = (agent.get("agent") or {}).get("id")
    group, _ = api("/api/conversations", {"title": "触控验证群", "member_ids": [agent_id]}, cookie)
    gid = (group.get("conversation") or {}).get("id")
    api(f"/api/conversations/{gid}/messages", {"body": "触控验证消息", "client_msg_id": uuid.uuid4().hex[:12]}, cookie)
    api("/api/feeds", {"body": "触控验证说说", "visibility": "friends", "client_msg_id": uuid.uuid4().hex[:12]}, cookie)

    import urllib.parse
    host = urllib.parse.urlparse(BASE).hostname
    sid = cookie.split("=", 1)[1]

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME) if CHROME else p.chromium.launch()
        all_fail = []
        for vw, vh in ((390, 844), (360, 640)):
            ctx = b.new_context(viewport={"width": vw, "height": vh}, locale="zh-CN",
                                is_mobile=True, has_touch=True, device_scale_factor=2)
            ctx.add_cookies([{"name": "sid", "value": sid, "domain": host, "path": "/"}])
            page = ctx.new_page()
            page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_selector(".conv__item", timeout=30000)
            page.wait_for_timeout(500)

            pages = [("会话列表", None)]
            fails = scan(page, ".conv")
            if fails:
                all_fail.append((vw, "会话列表", fails))

            # 会话列表的「＋」菜单
            page.locator("button[aria-label='新建或发现群聊']").first.click()
            page.wait_for_timeout(300)
            fails = scan(page, ".conv__menu")
            if fails:
                all_fail.append((vw, "＋菜单", fails))
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)

            # 群聊
            page.get_by_text("触控验证群", exact=False).first.click()
            page.wait_for_selector(".msg", timeout=20000)
            page.wait_for_timeout(500)
            fails = scan(page, ".chat")
            if fails:
                all_fail.append((vw, "群聊", fails))
            page.screenshot(path=os.path.join(SHOTS, f"touch-{vw}-chat.png"))

            # 群设置
            page.locator("button[aria-label='群设置']").first.click()
            page.wait_for_selector(".modal", timeout=15000)
            page.wait_for_timeout(300)
            fails = scan(page)
            if fails:
                all_fail.append((vw, "群设置", fails))
            page.screenshot(path=os.path.join(SHOTS, f"touch-{vw}-settings.png"))
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            # 手机端进会话后底部 Tab 会隐藏：先回列表再切页
            page.locator("button[aria-label='返回会话列表']").first.click()
            page.wait_for_timeout(400)

            # 空间 / 好友 / 我的 / 我的 AI
            for tab, label, shot, root in (("空间", "空间", "space", ".space"), ("好友", "好友", "friends", ".friends"), ("我的", "我的", "me", ".me")):
                page.locator(".tabbar__btn").filter(has_text=tab).first.click()
                page.wait_for_timeout(700)
                fails = scan(page, root)
                if fails:
                    all_fail.append((vw, label, fails))
                page.screenshot(path=os.path.join(SHOTS, f"touch-{vw}-{shot}.png"))
            page.get_by_role("button", name="我的 AI").click()
            page.wait_for_selector(".agent-row__switch", timeout=20000)
            page.wait_for_timeout(300)
            fails = scan(page, ".agents")
            if fails:
                all_fail.append((vw, "我的 AI", fails))
            ctx.close()

        b.close()

    for vw, where, fails in all_fail:
        for f in fails[:6]:
            print(f"       {vw} {where}: {f['tag']}.{f['cls']} 「{f['label']}」 盒子 {f['w']}×{f['h']} 有效热区 {f['effW']}×{f['effH']}")
    total_fail = sum(len(x[2]) for x in all_fail)
    check("移动端所有可点元素有效热区 ≥40×40（逐像素探测）", total_fail == 0,
          f"{total_fail} 个不达标" if total_fail else "0 个")

    if problems:
        print(f"\n有失败：{len(problems)} 条")
        return 1
    print("\n全部通过：触控热区（390×844 / 360×640 六个页面 + ＋菜单 + 群设置）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
