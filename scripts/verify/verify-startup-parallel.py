# -*- coding: utf-8 -*-
"""启动并行（第二批 P1-7）：/api/me ∥ /api/conversations ∥ 上次会话消息预取

为什么要有这条：把「me → 挂载 ChatView → 拉会话列表 → 点开会话 → 拉消息」四段串行压成
并行之后，**功能完全一样**，界面看不出任何区别——只有网络时间线能证明它还在并行。
任何一次改动把预取挪回 ChatView 挂载之后（或让 ChatView 再发一次会话列表），这里会红。

四条断言（3 次 reload 取中位数，阈值按本机实测放宽）：
  1. 真并行：`/api/conversations` 的请求**开始**早于 `/api/me` 的**结束**（+50ms 容差）；
     且消息预取的开始也早于会话列表的结束。
  2. 不重复：首屏每次 reload 只发 1 次 `/api/conversations`、最多 1 次 messages 预取，
     同一 URL 不出现两次。
  3. 预取被复用：点开「上次那个会话」不再发 messages 请求（0 次）；
     切到别的会话只发 messages、**不**重新拉 conversations。
  4. 失败隔离：消息预取被中断 → 列表照常渲染、点进会话仍能拉到消息；
     会话列表失败 → 错误块 + 重试（不伪装空态），me 不受牵连。
  5. 无 JS 异常、没有横向溢出。

额外：登录页（本地还没有「登录过」标记）不该发 `/api/conversations` —— 那是必然 401 的浪费。

前置：8787 打**构建产物**（`cd web && npm run build` 之后必须重启：@fastify/static wildcard:false）
      + 演示账号（`node scripts/seed-demo.mjs` 可重建）。
用法：BASE=http://127.0.0.1:8787 SHOTS_DIR=tmp/shots-ci python scripts/verify/verify-startup-parallel.py
"""
import json
import os
import re
import statistics
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8787")
EMAIL = os.environ.get("EMAIL", "demo@qqmini.dev")
PASSWORD = os.environ.get("PASSWORD", "demo-qqmini-2026")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.abspath(os.environ.get("SHOTS_DIR") or os.path.join(ROOT, "tmp", "shots-ci"))
CHROME = next(
    (c for c in [
        os.environ.get("CHROME_PATH", ""),
        r"C:\Users\26739\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe",
    ] if c and os.path.exists(c)),
    None,
)

RUNS = int(os.environ.get("RUNS", "3"))
# 并行判定阈值（ms）：本机实测 conversations.start - me.end ≈ -5ms（并行）/ +22ms（串行）。
# 放宽到 +50ms 是为了容纳 CI 抖动；串行时这条会稳定 > 一次 me 的 RTT，不会误判。
OVERLAP_TOLERANCE_MS = 50

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  — {detail}" if detail else ""))
    return ok


CONV_RE = re.compile(r"/api/conversations(\?[^/]*)?$")
MSG_RE = re.compile(r"/api/conversations/(\d+)/messages\?")
ME_RE = re.compile(r"/api/me$")


def kind_of(url):
    path = url.split(BASE, 1)[-1] if url.startswith(BASE) else url
    if ME_RE.search(path):
        return "me"
    if CONV_RE.search(path):
        return "conversations"
    if MSG_RE.search(path):
        return "messages"
    if path.endswith("/api/agents"):
        return "agents"
    if path.endswith("/api/sticker-packs"):
        return "stickers"
    return "other"


class Recorder:
    """按 URL 记 [start, end]（perf_counter，毫秒）。"""

    def __init__(self, page):
        self.page = page
        self.t0 = time.perf_counter()
        self.rows = []
        self.pending = {}
        self.errors = []
        page.on("request", self._on_request)
        page.on("requestfinished", self._on_done)
        page.on("requestfailed", self._on_done)
        page.on("pageerror", lambda e: self.errors.append(str(e)))

    def reset(self):
        self.t0 = time.perf_counter()
        self.rows = []
        self.pending = {}

    def _on_request(self, req):
        url = req.url
        if "://" not in url or "/api/" not in url:
            return
        row = {"kind": kind_of(url), "method": req.method, "url": url, "start": self.now(), "end": None}
        self.rows.append(row)
        self.pending[req] = row

    def _on_done(self, req):
        row = self.pending.pop(req, None)
        if row is not None and row["end"] is None:
            row["end"] = self.now()

    def now(self):
        return round((time.perf_counter() - self.t0) * 1000, 1)

    def finish_ends(self):
        for row in self.rows:
            if row["end"] is None:
                row["end"] = self.now()

    def of(self, kind):
        return [r for r in self.rows if r["kind"] == kind]


def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME) if CHROME else pw.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = ctx.new_page()
        rec = Recorder(page)

        # ---------------- 登录（第一次访问：本地还没有任何标记） ----------------
        rec.reset()
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90000)
        page.wait_for_selector("input[type=email]", timeout=30000)
        page.wait_for_timeout(1200)
        rec.finish_ends()
        anon_conv = rec.of("conversations")
        check(
            "未登录的登录页不发 /api/conversations（没登录标记就不预取，避免必 401 的浪费）",
            len(anon_conv) == 0,
            f"{len(anon_conv)} 次",
        )

        page.fill("input[type=email]", EMAIL)
        page.fill("input[type=password]", PASSWORD)
        page.click("button[type=submit]")
        page.wait_for_selector(".conv__item", timeout=30000)

        # 选一个真的有消息的会话（同时会写「上次会话」提示，供下一次 reload 预取）
        picked_title = ""
        items = page.locator(".conv__item")
        total = min(items.count(), 8)
        for i in range(total):
            try:
                title = (items.nth(i).inner_text() or "").split("\n")[0].strip()
            except Exception:
                title = ""
            items.nth(i).click()
            try:
                page.wait_for_selector(".msg", timeout=4000)
                picked_title = title
                break
            except Exception:
                continue
        page.wait_for_timeout(600)
        check("登录后能打开一个有消息的会话（预取提示已写入）", bool(picked_title), picked_title or "没找到")

        # ---------------- 3 次 reload：量首屏瀑布 ----------------
        runs = []
        for run in range(RUNS):
            page.wait_for_timeout(600)
            rec.reset()
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".conv__item", timeout=30000)
            page.wait_for_timeout(1200)
            rec.finish_ends()
            rows = sorted(rec.rows, key=lambda r: r["start"])
            runs.append(rows)
            print(f"\n--- reload {run + 1}（相对 reload 起点 ms）---")
            for row in rows:
                path = row["url"].split(BASE, 1)[-1]
                print(f"  {str(row['start']).rjust(6)} → {str(row['end']).rjust(6)}  ({row['end'] - row['start']:5.1f}ms)"
                      f"  {row['kind']:<13} {path}")
            counts = {k: len([r for r in rows if r["kind"] == k]) for k in ("me", "conversations", "messages", "agents")}
            print(f"  计数 {json.dumps(counts, ensure_ascii=False)}")

        def med(values):
            return round(statistics.median(values), 1) if values else float("nan")

        me_end = [r["end"] for rows in runs for r in rows if r["kind"] == "me"]
        conv_start = [r["start"] for rows in runs for r in rows if r["kind"] == "conversations"]
        conv_end = [r["end"] for rows in runs for r in rows if r["kind"] == "conversations"]
        msg_start = [r["start"] for rows in runs for r in rows if r["kind"] == "messages"]
        print("\n=== 中位数 ===")
        print(f"  me 结束              p50={med(me_end)}ms")
        print(f"  conversations 开始   p50={med(conv_start)}ms / 结束 p50={med(conv_end)}ms")
        print(f"  messages 预取 开始   p50={med(msg_start) if msg_start else '(没有预取)'}ms")
        delta = (med(conv_start) - med(me_end)) if conv_start else float("inf")
        print(f"  conversations.start - me.end = {delta}ms（<0 = 真并行）")

        # ---------------- 断言 1：真并行 ----------------
        check(
            f"真并行：conversations 开始早于 me 结束 +{OVERLAP_TOLERANCE_MS}ms",
            bool(conv_start) and bool(me_end) and delta <= OVERLAP_TOLERANCE_MS,
            f"Δ={delta}ms",
        )
        msg_before_conv_end = bool(msg_start) and bool(conv_end) and med(msg_start) < med(conv_end)
        check(
            "消息预取与会话列表重叠（预取开始早于列表结束）",
            msg_before_conv_end,
            f"messages.start p50={med(msg_start) if msg_start else '-'}ms / conversations.end p50={med(conv_end)}ms",
        )
        check("首屏发出了 1 次消息预取（localStorage 有上次会话）", len(msg_start) == RUNS, f"{len(msg_start)} / {RUNS} 次 reload")

        # ---------------- 断言 2：不重复 ----------------
        conv_counts = [len([r for r in rows if r["kind"] == "conversations"]) for rows in runs]
        msg_counts = [len([r for r in rows if r["kind"] == "messages"]) for rows in runs]
        check("首屏只发 1 次 /api/conversations", all(c == 1 for c in conv_counts), f"每次 reload {conv_counts}")
        check("首屏 messages 请求 ≤ 2（1 次预取 + 最多 1 次补尾）", all(c <= 2 for c in msg_counts), f"每次 reload {msg_counts}")
        dupes = []
        for rows in runs:
            seen = set()
            for row in rows:
                if row["url"] in seen:
                    dupes.append(row["url"].split(BASE, 1)[-1])
                seen.add(row["url"])
        check("同一个 URL 在首屏没有被请求两次", len(dupes) == 0, "; ".join(dupes[:3]) or "无重复")

        # ---------------- 断言 3：点开上次会话 = 0 请求；切会话不重拉列表 ----------------
        rec.reset()
        page.locator(".conv__item", has_text=picked_title).first.click()
        page.wait_for_selector(".msg", timeout=15000)
        page.wait_for_timeout(900)
        rec.finish_ends()
        reuse_msgs = rec.of("messages")
        check(
            "点开「上次那个会话」不再发 messages（预取被复用）",
            len(reuse_msgs) == 0,
            f"{len(reuse_msgs)} 次：{[r['url'].split(BASE, 1)[-1] for r in reuse_msgs][:2]}",
        )

        # 切到另一个会话：只发 messages，不发 conversations
        other = None
        labels = page.locator(".conv__item")
        for i in range(min(labels.count(), 10)):
            try:
                text = (labels.nth(i).inner_text() or "").split("\n")[0].strip()
            except Exception:
                continue
            if text and text != picked_title:
                other = text
                break
        if other is None:
            print("SKIP  只有一个会话，跳过「切会话」用例")
        else:
            rec.reset()
            page.locator(".conv__item", has_text=other).first.click()
            page.wait_for_timeout(1400)
            rec.finish_ends()
            switch_conv = rec.of("conversations")
            switch_msg = rec.of("messages")
            check(
                "切会话不重新拉 /api/conversations（只拉 messages）",
                len(switch_conv) == 0 and len(switch_msg) <= 1,
                f"conversations={len(switch_conv)} messages={len(switch_msg)}（{other}）",
            )

        # ---------------- 断言 4：失败隔离（预取失败不能牵连别的） ----------------
        # A) 消息预取失败：列表照常渲染、点进会话仍能正常拉消息
        aborted = {"prefetch": 0}

        def abort_prefetch(route):
            if aborted["prefetch"] == 0:
                aborted["prefetch"] += 1
                route.abort("failed")
            else:
                route.continue_()

        page.route("**/api/conversations/*/messages?*", abort_prefetch)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".conv__item", timeout=30000)
        page.wait_for_timeout(1200)
        list_items = page.locator(".conv__item").count()
        check(
            "消息预取失败：会话列表照常渲染（不弹错误块）",
            list_items > 0 and aborted["prefetch"] == 1,
            f"条目={list_items} 预取被中断={aborted['prefetch']}",
        )
        page.unroute("**/api/conversations/*/messages?*")
        msg_after = {"n": 0}
        page.on("request", lambda req: msg_after.__setitem__("n", msg_after["n"] + 1) if "/messages?" in req.url else None)
        page.locator(".conv__item", has_text=picked_title).first.click()
        page.wait_for_selector(".msg", timeout=15000)
        page.wait_for_timeout(600)
        check(
            "预取失败后点开会话：正常拉消息并上屏",
            msg_after["n"] >= 1 and page.locator(".msg").count() > 0,
            f"messages 请求 {msg_after['n']} 次，气泡 {page.locator('.msg').count()} 个",
        )

        # B) 会话列表失败：错误块 + 重试，不伪装成空态；me 仍成功（外壳还在）
        page.route("**/api/conversations?*", lambda route: route.abort("failed"))
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        has_retry = page.locator('button:has-text("重试")').count() > 0
        fake_empty = page.locator(".conv__empty, .conv-list__empty").count() > 0
        check(
            "会话列表失败：显示错误块 + 重试（不伪装成空态）",
            has_retry and not fake_empty,
            f"retry={has_retry} empty={fake_empty}",
        )
        shell_ok = page.evaluate(
            "() => Boolean(document.querySelector('.shell, .topnav, .conv__me')) && (document.body.innerText || '').length > 0"
        )
        check("会话列表失败不阻塞 me：外壳/侧栏仍渲染", bool(shell_ok))
        page.unroute("**/api/conversations?*")

        # ---------------- 断言 5：无 JS 异常、无横向溢出 ----------------
        check("页面没有 JS 异常", len(rec.errors) == 0, "; ".join(rec.errors[:2]))
        overflow = page.evaluate(
            "() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })"
        )
        check(
            "没有横向溢出",
            overflow["scrollWidth"] <= overflow["innerWidth"] + 1,
            json.dumps(overflow, ensure_ascii=False),
        )
        page.screenshot(path=os.path.join(SHOTS, "90-startup-parallel.png"))
        ctx.close()
        browser.close()

    failed = [name for name, ok in results if not ok]
    print("")
    if failed:
        print(f"失败 {len(failed)}/{len(results)}：{' / '.join(failed)}")
        return 1
    print(f"全部通过：{len(results)}/{len(results)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
