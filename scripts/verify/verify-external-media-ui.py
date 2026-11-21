# -*- coding: utf-8 -*-
"""Q14 外链媒体「默认不自动加载」回归（Playwright，两个账号）。

为什么需要这条门（不是复述代码）：
  外链图片/语音/视频是**站外域名**提供的。直接挂 `img src` 的那一瞬间，
  对方就知道「谁、在什么时间、从哪个 IP 看了这条消息」；一张 1px 追踪图就能统计活跃成员。
  这类泄露**没有任何报错**：页面一切正常，只是悄悄把访问者信息送出去了，所以只能靠
  「断言点击前一个外部请求都没发生」来守。

覆盖：
  1) 外链图片：进入会话后**零**外部请求；占位卡显示域名 + 「外部内容，点击加载」+ 未审核提示；
  2) 点击后：确实发起一次请求（被 route 拦下来 fulfill 成 PNG，模拟正常外链图）；
  3) 该 <img> 带 `referrerpolicy=no-referrer` 与 `loading=lazy`（不把本站地址当 Referer 送出去）；
  4) 站内图片（真上传的附件）**仍然自动加载**、不被这道闸拦住（不能为了隐私把正常图片搞坏）；
  5) 响应头 `Referrer-Policy: no-referrer` 仍在（全局兜底，第二道保险）。

用法：
  SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 python scripts/verify/verify-external-media-ui.py
前置：8787 已起、允许注册（本地兼容模式）；会造 2 个临时账号 + 1 个群 + 2 条消息。
"""

import json
import os
import struct
import sys
import urllib.request
import zlib

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "tmp", "shots-ext-media"))
EXT_HOST = "tracker.example"
EXT_URL = f"https://{EXT_HOST}/pixel.png"

CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

problems = []


checks = {"n": 0}


def check(name, ok, detail=""):
    checks["n"] += 1
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + detail) if detail else ""))
    if not ok:
        problems.append(name)


# ---------------------------------------------------------------- HTTP（stdlib，避免依赖 requests）
def http(method, path, body=None, cookie=None, raw=None, content_type=None):
    headers = {}
    data = None
    if raw is not None:
        data = raw
        headers["content-type"] = content_type or "application/octet-stream"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    if cookie:
        headers["cookie"] = cookie
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            text = res.read().decode("utf-8", "replace")
            sid = None
            for c in res.headers.get_all("Set-Cookie") or []:
                if c.startswith("sid="):
                    sid = c.split(";")[0]
            payload = None
            try:
                payload = json.loads(text) if text else None
            except Exception:
                payload = None
            return res.status, payload, sid, dict(res.headers)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(text) if text else None
        except Exception:
            payload = None
        return e.code, payload, None, dict(e.headers)


def register(name):
    email = f"t_ext_{os.urandom(4).hex()}@test.dev"
    status, payload, sid, _ = http("POST", "/api/auth/register", {
        "email": email, "password": "ExtMedia!2026", "display_name": name,
        "invite_code": os.environ.get("REGISTER_CODE", ""),
    })
    if status != 200 or not sid:
        raise RuntimeError(f"注册失败 {status} {payload}")
    me = (payload or {}).get("me") or {}
    return {"email": email, "password": "ExtMedia!2026", "cookie": sid, "id": int(me.get("id") or 0)}


def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def make_png(w=64, h=48):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw += bytes(((x * 255) // w, (y * 255) // h, 90))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + _chunk(b"IEND", b""))


def main():
    os.makedirs(SHOTS, exist_ok=True)
    a = register(f"外链A{os.urandom(2).hex()}")
    b = register(f"外链B{os.urandom(2).hex()}")
    check("准备：两个临时账号", bool(a.get("cookie") and b.get("cookie")))

    title = f"外链验证-{os.urandom(3).hex()}"
    status, payload, _, _ = http("POST", "/api/conversations", {"title": title, "member_ids": []}, cookie=a["cookie"])
    gid = ((payload or {}).get("conversation") or {}).get("id")
    check("准备：建群", status == 200 and bool(gid), f"status={status} gid={gid}")
    http("PATCH", f"/api/conversations/{gid}/public", {"discoverable": True, "join_mode": "open"}, cookie=a["cookie"])
    status, payload, _, _ = http("POST", f"/api/conversations/{gid}/join", {}, cookie=b["cookie"])
    check("准备：B 通过 open 入群", status == 200 and (payload or {}).get("joined") is True, str(payload)[:120])

    # 站内附件 + 外链图各一条
    png = make_png()
    status, up, _, _ = http("POST", "/api/attachments", raw=png, cookie=a["cookie"], content_type="image/png")
    att_id = ((up or {}).get("attachment") or {}).get("id")
    check("准备：上传站内图片", status == 200 and bool(att_id), f"status={status} id={att_id}")

    status, _, _, _ = http("POST", f"/api/conversations/{gid}/messages", {
        "body": "外链图（默认不该自动加载）",
        "parts": [{"type": "image", "url": EXT_URL, "alt": "追踪图"}],
        "client_msg_id": f"ext-{os.urandom(4).hex()}",
    }, cookie=a["cookie"])
    check("准备：发一条外链图消息", status == 200, f"status={status}")
    http("POST", f"/api/conversations/{gid}/messages", {
        "body": "站内图（应该自动加载）",
        "parts": [{"type": "image", "attachment_id": att_id}],
        "client_msg_id": f"int-{os.urandom(4).hex()}",
    }, cookie=a["cookie"])

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True) if CHROME else p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1024, "height": 800}, locale="zh-CN")
        page = ctx.new_page()
        external_requests = []
        internal_requests = []

        def on_request(req):
            u = req.url
            if EXT_HOST in u:
                external_requests.append(u)
            if "/media/" in u and u not in internal_requests:
                internal_requests.append(u)

        page.on("request", on_request)
        # 外链图用 route 就地 fulfill：既能观察「点击后才发请求」，又不会因为域名不存在把 img 变破图
        page.route("**/pixel.png", lambda route: route.fulfill(
            status=200, content_type="image/png", body=png,
            headers={"cache-control": "no-store"},
        ))

        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("input[type=email]", timeout=30000)
        page.fill("input[type=email]", b["email"])
        page.fill("input[type=password]", b["password"])
        page.click("button[type=submit]")
        page.wait_for_selector(".conv__item", timeout=30000)

        def open_group():
            items = page.locator(".conv__item")
            for i in range(items.count()):
                if title in (items.nth(i).inner_text() or ""):
                    items.nth(i).click()
                    page.wait_for_timeout(900)
                    return True
            return False

        check("UI：B 能看到这个群并打开", open_group(), f"title={title}")
        page.wait_for_timeout(600)

        # 1) 点击前：零外部请求
        check("外链图：进入会话后**没有**任何发往站外域名的请求", len(external_requests) == 0,
            f"requests={external_requests[:3]}")
        gate = page.locator(".msg__ext-gate").first
        check("外链图：显示占位卡（不是直接加载的图）", gate.count() > 0, f"count={gate.count()}")
        gate_text = (gate.inner_text() if gate.count() else "") or ""
        check("占位卡写明域名", EXT_HOST in gate_text, gate_text.replace("\n", " / ")[:80])
        check("占位卡写明「外部内容，点击加载」", "点击加载" in gate_text, gate_text.replace("\n", " / ")[:80])
        check("占位卡写明「外链内容未经本站审核」", "未经本站审核" in gate_text, gate_text.replace("\n", " / ")[:80])

        # 2) 站内图仍然自动加载
        check("站内图：仍然自动加载（/media/ 请求已发生）", len(internal_requests) >= 1, f"n={len(internal_requests)}")

        page.screenshot(path=os.path.join(SHOTS, "ext-media-gate.png"), full_page=True)

        # 3) 点击后才请求
        if gate.count():
            gate.click()
            page.wait_for_timeout(900)
        check("点击后：确实发起了外链请求（且被 route 接住）", len(external_requests) == 1,
            f"requests={external_requests}")

        img = page.locator(f"img[src*='{EXT_HOST}']").first
        has_img = img.count() > 0
        check("点击后：外链图元素出现", has_img)
        if has_img:
            check("外链 <img> 带 referrerpolicy=no-referrer",
                (img.get_attribute("referrerpolicy") or "") == "no-referrer",
                str(img.get_attribute("referrerpolicy")))
            check("外链 <img> 带 loading=lazy", (img.get_attribute("loading") or "") == "lazy",
                str(img.get_attribute("loading")))
        page.screenshot(path=os.path.join(SHOTS, "ext-media-loaded.png"), full_page=True)

        # 4) 全局响应头兜底
        _, _, _, headers = http("GET", "/")
        rp = headers.get("Referrer-Policy") or headers.get("referrer-policy") or ""
        check("响应头 Referrer-Policy: no-referrer（全局兜底）", rp == "no-referrer", rp)

        browser.close()

    failed = [p for p in problems]
    total = checks["n"]
    print(f"\n{'全部通过' if not failed else '有失败'}：{total - len(failed)}/{total}")
    if failed:
        print("失败项：" + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
