# -*- coding: utf-8 -*-
"""P1-6 前端图片缩略图回归：气泡用 thumbUrl、灯箱仍是原图、刷新后不回退、老图不受影响。

为什么需要这条门（脚本存在的前提，不是复述代码）：
  1) 缩略图 URL 的签名**按变体**参与 HMAC，所以前端不能自己给 url 加 `v=thumb`；
     一旦有人把 src 算错，浏览器拿到的是 403 —— 图上什么也不显示，静态检查看不出来。
  2) 图片 part 要过两道白名单才到 <img>：服务端 `hydrateMessageParts`（聊天读路径）
     与前端 `parts.ts#normalizeImage`。任意一处漏字段，缩略图就只在「刚发完」那一刻存在，
     刷新/断线补齐后悄悄掉回原图 —— 这类不一致只能靠「刷新后再断言一次」抓住。
  3) 没有 thumbUrl 的老图/GIF/外链必须继续走原图，不能因为引入缩略图就破图。

用法：
  SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 python scripts/verify/verify-thumbnail-ui.py
前置：演示账号；8787 带 sharp（上传时派生 480px WebP）。会发 1 条测试图片消息（不清理）。
断言条数以本脚本实际输出为准；有 FAIL 退出码非 0。
"""
import os
import re
import struct
import sys
import time
import zlib

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://chat.example.com")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "docs", "shots"))  # SHOTS_DIR 可覆盖（CI 写临时目录）
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

problems = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + detail) if detail else ""))
    if not ok:
        problems.append(name)


def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def make_png(width=480, height=320):
    """纯标准库生成渐变 PNG：不引 Pillow，且 8bit RGB 一定可被 sharp 缩略（≠GIF/SVG）。

    用渐变而不是纯色：纯色图压到几 KB，看不出「缩略图省流量」这件事是否真的发生。
    """
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # 每行 filter type 0
        for x in range(width):
            raw += bytes(((x * 255) // width, (y * 255) // height, ((x + y) * 255) // (width + height)))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b""))


def png_path(name="thumb-ui-test.png", width=480, height=320):
    path = os.path.join(ROOT, "tmp", name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(make_png(width, height))
    return path


def login(page):
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("input[type=email]", timeout=30000)
    page.fill("input[type=email]", EMAIL)
    page.fill("input[type=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_selector(".conv__item", timeout=30000)


def open_group(page):
    items = page.locator(".conv__item")
    for i in range(items.count()):
        if "AI 圆桌" in (items.nth(i).inner_text() or ""):
            items.nth(i).click()
            page.wait_for_timeout(700)
            return
    items.nth(0).click()
    page.wait_for_timeout(700)


def img_state(page, att_id):
    """返回该附件在气泡里的状态：src / 是否用变体 / 是否真的解码成功。"""
    return page.evaluate(
        """(id) => {
            const hit = Array.from(document.querySelectorAll('.msg__image img'))
              .find((i) => (i.getAttribute('src') || '').includes('/media/' + id));
            if (!hit) return null;
            const src = hit.getAttribute('src') || '';
            return {
              src,
              isThumb: src.includes('v=thumb'),
              loaded: hit.complete && hit.naturalWidth > 0,
              broken: document.querySelectorAll('.msg__image--broken').length,
            };
        }""",
        att_id,
    )


def last_img_state(page):
    """最后一条（最新）气泡图片的状态。

    为什么不按 attachment id 找：附件是内容寻址去重的，同一份测试图跨多次运行会复用同一个
    attachment id，历史消息里可能有同 id 的图片（它们的 thumb 已经加载成功），按 id 找会命中旧的。
    新消息永远追加在列表末尾，所以「最后一个 .msg__image img」才是本次上传的那条。
    """
    return page.evaluate(
        """() => {
            const imgs = Array.from(document.querySelectorAll('.msg__image img'));
            const last = imgs[imgs.length - 1];
            if (!last) return null;
            const src = last.getAttribute('src') || '';
            return {
              src,
              isThumb: src.includes('v=thumb'),
              loaded: last.complete && last.naturalWidth > 0,
              width: last.naturalWidth,
              broken: document.querySelectorAll('.msg__image--broken').length,
            };
        }"""
    )


def wait_img(page, att_id, want_thumb, timeout_ms=20000):
    """等到 DOM 里那条附件图片达到期望形态（上传是异步的，发完还有一次 WS 回执替换）。"""
    deadline = time.time() + timeout_ms / 1000
    last = None
    while time.time() < deadline:
        last = img_state(page, att_id)
        if last and last["isThumb"] == want_thumb and last["loaded"]:
            return last
        page.wait_for_timeout(250)
    return last


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME)
        ctx = browser.new_context(
            viewport={"width": 430, "height": 900},
            device_scale_factor=2,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            # 屏蔽 Service Worker：它会把 /media 响应放进缓存，route 拦不到就测不了「缩略图失败回退」
            service_workers="block",
        )
        page = ctx.new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        login(page)
        open_group(page)
        page.wait_for_selector("textarea", timeout=30000)
        page.wait_for_timeout(600)

        # ---------- 1) 上传响应必须带 thumbUrl，且是 v=thumb 变体 ----------
        # 用 route 自己转一手再 fulfill：expect_response + .json() 在「大 body + 回执帧」时会被
        # inspector cache 驱逐（实测 Network.getResponseBody: Request content was evicted），
        # 这里先把响应读进内存，再原样交还给页面，页面行为完全不变。
        captured = {}

        def capture_upload(route):
            response = route.fetch()
            if "attachment" in (response.text() or ""):
                try:
                    captured.update(response.json())
                except Exception:  # noqa: BLE001 - 非 JSON 就当没捕到
                    pass
            route.fulfill(response=response)

        page.route("**/api/attachments", capture_upload)
        page.set_input_files("input[accept='image/*']", png_path())
        deadline = time.time() + 60
        while time.time() < deadline and not captured.get("attachment"):
            page.wait_for_timeout(200)
        page.unroute("**/api/attachments")
        payload = captured
        att = (payload or {}).get("attachment") or {}
        att_id = att.get("id")
        orig_url = att.get("url") or ""
        thumb_url = att.get("thumbUrl") or ""
        check("上传响应带原图 url", bool(orig_url), orig_url.split("?")[0] or "(缺失)")
        check("上传响应带 thumbUrl", bool(thumb_url))
        check("thumbUrl 是 v=thumb 变体（签名按变体绑定）", "v=thumb" in thumb_url, thumb_url.split("?")[0] or "(缺失)")
        check("thumbUrl 与原图 url 不是同一个地址", bool(thumb_url) and thumb_url.split("?")[0].count("/") >= 0 and thumb_url != orig_url)

        if att_id:
            # ---------- 2) 发完的气泡必须用缩略图，且图片真的解码成功 ----------
            live = wait_img(page, att_id, want_thumb=True)
            check("发完的气泡 img src 用缩略图（含 v=thumb）", bool(live and live["isThumb"]),
                  (live or {}).get("src", "(没找到该附件的 img)").split("?")[0])
            check("缩略图真的加载成功（没回退成原图/破图）", bool(live and live["loaded"]),
                  f"loaded={(live or {}).get('loaded')}")

            # ---------- 3) 点开是原图（灯箱不能漏成缩略图） ----------
            page.locator(".msg__image").last.click()
            page.wait_for_selector(".lightbox__img", timeout=15000)
            lb_src = page.locator(".lightbox__img").get_attribute("src") or ""
            check("灯箱打开的是原图（不含 v=thumb）", "v=thumb" not in lb_src and "/media/" in lb_src,
                  lb_src.split("?")[0] or "(空)")
            check("灯箱原图与上传返回的 url 指向同一附件", f"/media/{att_id}" in lb_src, f"/media/{att_id}")
            page.screenshot(path=os.path.join(SHOTS, "92-thumb-lightbox.png"))
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

            # ---------- 4) 刷新后仍用缩略图（聊天读路径 hydrate 是否带 thumbUrl） ----------
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".conv__item", timeout=30000)
            open_group(page)
            page.wait_for_selector(".msg__image img", timeout=30000)
            after = wait_img(page, att_id, want_thumb=True)
            check("刷新后同一条消息仍用缩略图（聊天读路径 hydrate 带 thumbUrl）",
                  bool(after and after["isThumb"]),
                  (after or {}).get("src", "(没找到该附件的 img)").split("?")[0])
            page.screenshot(path=os.path.join(SHOTS, "93-thumb-after-reload.png"))

        # ---------- 5) 老图（没有 thumbUrl）继续走原图且不破图 ----------
        # 注意：气泡 <img> 是 loading="lazy"，且列表滚在底部，屏幕外的老图 naturalWidth=0 是正常的。
        # 所以先挑一张老图滚进视口，再只针对它断言「解码成功 + 没有变成破图占位」。
        probe = page.evaluate(
            """() => {
                const imgs = Array.from(document.querySelectorAll('.msg__image img'));
                const old = imgs.filter((i) => !(i.getAttribute('src') || '').includes('v=thumb'));
                const target = old[0];
                if (target) target.scrollIntoView({ block: 'center' });
                return { total: imgs.length, legacy: old.length, src: target ? target.getAttribute('src') : null };
            }"""
        )
        check("没有 thumbUrl 的旧图仍用原图", probe["legacy"] > 0,
              f"旧图 {probe['legacy']} / 共 {probe['total']} 张")
        page.wait_for_timeout(1500)  # 给 lazy 图一点真的去取的时间
        legacy_state = page.evaluate(
            """(src) => {
                const i = Array.from(document.querySelectorAll('.msg__image img'))
                  .find((el) => el.getAttribute('src') === src);
                return {
                  found: Boolean(i),
                  loaded: Boolean(i && i.complete && i.naturalWidth > 0),
                  broken: document.querySelectorAll('.msg__image--broken').length,
                };
            }""",
            probe["src"],
        )
        check("老图滚进视口后能正常解码（没被判成破图）",
              bool(probe["src"]) and legacy_state["found"] and legacy_state["loaded"] and legacy_state["broken"] == 0,
              f"loaded={legacy_state['loaded']} 破图占位={legacy_state['broken']}")

        # ---------- 6) 缩略图真的取不到时：只回退一次到原图，不变成破图、不来回抖 ----------
        # 服务端缩略图正常情况下不会坏，所以这里用 route 让 thumb 请求直接失败，专测前端 onError 那条分支。
        # 必须换一张**内容不同**的图：附件是内容寻址去重的，同一份字节会复用同一个 attachment（含同一个
        # thumb URL），那样浏览器直接用缓存、abort 根本不会触发，等于没测。
        gap_id = None
        gap_captured = {}

        def capture_gap_upload(route):
            response = route.fetch()
            if "attachment" in (response.text() or ""):
                try:
                    gap_captured.update(response.json())
                except Exception:  # noqa: BLE001
                    pass
            route.fulfill(response=response)

        page.route("**/api/attachments", capture_gap_upload)
        # 用正则匹配 v=thumb 变体（glob 里 ? 容易被当成量词/通配，历史上踩过）；aborted 记录命中次数，
        # 断言失败时一眼能看出「是没拦住」还是「拦住了但没回退」。
        thumb_url_pattern = re.compile(r"[?&]v=thumb(&|$)")
        aborted = []

        def abort_thumb(route):
            aborted.append(route.request.url.split("?")[0])
            route.abort()

        page.route(thumb_url_pattern, abort_thumb)

        def scroll_to_bottom():
            # 上一段为了验证老图把列表滚上去了；新消息在底部，而 <img> 是 loading="lazy"，
            # 不入视口就不会发请求，abort 也就不会触发 —— 必须先滚回底部。
            page.evaluate("() => { const el = document.querySelector('.messages'); if (el) el.scrollTop = el.scrollHeight; }")

        scroll_to_bottom()
        page.wait_for_timeout(300)
        page.set_input_files("input[accept='image/*']", png_path("thumb-ui-test-2.png", 500, 340))
        deadline = time.time() + 60
        while time.time() < deadline and not gap_captured.get("attachment"):
            page.wait_for_timeout(200)
        gap_id = (gap_captured.get("attachment") or {}).get("id")
        gap = None
        deadline = time.time() + 20
        while time.time() < deadline:
            scroll_to_bottom()
            gap = last_img_state(page)
            # 目标状态：最新那张已经回退到原图（无 v=thumb）且解码成功
            if gap and not gap["isThumb"] and gap["loaded"]:
                break
            page.wait_for_timeout(300)
        check("缩略图取不到时回退到原图（src 不再含 v=thumb）",
              bool(gap) and not gap["isThumb"],
              f"{(gap or {}).get('src', '(没有图片气泡)').split('?')[0]}；已拦截 thumb 请求 {len(aborted)} 次")
        check("回退后的原图能正常解码（不是破图占位）",
              bool(gap) and gap["loaded"],
              f"loaded={(gap or {}).get('loaded')} 宽={((gap or {}).get('width'))} 破图占位={(gap or {}).get('broken')}")
        page.wait_for_timeout(600)
        again = last_img_state(page)
        check("回退只发生一次（600ms 后 src 稳定，没有来回打）",
              bool(again) and not again["isThumb"] and again["src"] == (gap or {}).get("src"),
              (again or {}).get("src", "(空)").split("?")[0])
        page.unroute(thumb_url_pattern)
        page.unroute("**/api/attachments")

        if page_errors:
            check("页面没有 JS 异常", False, str(page_errors[:3]))

        ctx.close()
        browser.close()

    print("---")
    total = len(problems) + 0
    if problems:
        print(f"缩略图 UI 校验失败：{len(problems)} 条")
        for item in problems:
            print(" -", item)
        sys.exit(1)
    print("THUMBNAIL UI CHECK PASSED")


main()
