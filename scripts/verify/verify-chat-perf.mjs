#!/usr/bin/env node
// ============================================================================
// scripts/verify/verify-chat-perf.mjs —— 聊天渲染性能 / 合并 / 懒加载回归
//
// 为什么要有这条：审计第二/三批的前端项（会话排序预解析、已读回执合并、弹窗懒加载、
// 音效延后预加载、消息行 memo、消息窗口上限）**都是"看不见的收益"**——功能照旧能用，
// 只有数字能证明它还在工作。任何一条被改回去，界面看不出来，只有这里会红。
//
// 五组断言：
//   1. 长任务 / 消息到达渲染延迟：真实 WS 推送 20 条，PerformanceObserver('longtask')
//      最大长任务 < 200ms；打印「WS 帧到达 → 该条 .msg 出现在 DOM」的 P50/P95。
//   2. 已读回执合并：A 打开会话，B 连发 5 条，A 的 POST /read 请求数 ≤ 2（500ms trailing）。
//   3. 消息窗口上限：600 条的群反复滚到顶翻页，DOM 里 .msg ≤ 520 且最老 seq > 1
//      （→ 裁剪只丢头部、保留尾部；loadOlder 顶到上限会停，不会无限重复请求）。
//   4. 音效延后预加载：登录页没有任何 .mp3 请求；点一下页面后出现（首个手势才 warmSounds）。
//   5. 弹窗懒加载：主 chunk 里没有「解散群」/「确定删除表情包」，assets 里有对应懒 chunk；
//      运行时点「群设置」才会真的拉那个 chunk。
//
// 前置：
//   - 本地 8787 打**构建产物**（`cd web && npm run build` 之后必须重启 8787：
//     @fastify/static wildcard:false 会在启动时注册当时 dist 里的文件名，不重启就 404）；
//   - 可注册账号（`REGISTER_CODE` 可选，与其它 verify 脚本一致）。
//
// 为什么**不进 CI**：要造 820 条消息 + 16 个账号（人类发消息是 60 条/分钟/账号的硬限流，
// 必须分摊），单跑 60~120s，比整套 UI 回归还慢；放 CI 会拖垮反馈时间。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-chat-perf.mjs
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DIST = path.join(ROOT, 'web', 'dist');
const rnd = () => crypto.randomBytes(4).toString('hex');

/** 长任务上限（ms）：超过这个数说明单帧里干了不该在渲染路径上干的事 */
const LONG_TASK_LIMIT_MS = 200;
/** 渲染延迟门槛（ms）：P95 超过它，用户就能感觉到「消息慢半拍」 */
const RENDER_P95_LIMIT_MS = 800;
/** 一个会话在 DOM 里允许保留的消息上限（useChatStream 的 MESSAGE_WINDOW=500，留 20 条余量） */
const DOM_WINDOW_LIMIT = 520;
/** 已读合并后的请求上限：5 条消息最多 2 次（首发 + 尾随一次） */
const READ_REQUESTS_LIMIT = 2;

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}

/* ---------------- REST：脚本自建账号 / 群 / 消息 ---------------- */

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((item) => String(item).split(';')[0]).find((item) => item.startsWith('sid='));
  return { status: res.status, json, text, sid: sid ? sid.slice(4) : null };
}

async function signup(name) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email: `perf_${rnd()}@test.dev`,
      password: 'passw0rd!x',
      display_name: name,
      invite_code: process.env.REGISTER_CODE || '',
    },
  });
  if (r.status !== 200 || !r.json?.me || !r.sid) throw new Error(`注册失败 ${r.status} ${r.text.slice(0, 160)}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, name, sid: r.sid };
}

async function befriend(owner, mate) {
  const req = await api('/api/friends/request', { method: 'POST', cookie: owner.cookie, body: { account_no: mate.accountNo } });
  const acc = await api('/api/friends/accept', { method: 'POST', cookie: mate.cookie, body: { principal_id: owner.id } });
  if (req.status !== 200 || acc.status !== 200) {
    throw new Error(`加好友失败 ${owner.name}->${mate.name} ${req.status}/${acc.status}`);
  }
}

async function createGroup(owner, members, title) {
  const r = await api('/api/conversations', {
    method: 'POST',
    cookie: owner.cookie,
    body: { title, member_ids: members.map((m) => m.id) },
  });
  if (r.status !== 200 || !r.json?.conversation?.id) throw new Error(`建群失败 ${r.status} ${r.text.slice(0, 160)}`);
  return r.json.conversation.id;
}

async function send(actor, conversationId, body) {
  const r = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    cookie: actor.cookie,
    body: { body, client_msg_id: rnd() },
  });
  if (r.status !== 200) throw new Error(`发送失败 ${r.status} ${r.text.slice(0, 160)}`);
  return r.json;
}

/** 一个账号连发 n 条（并发跑多个账号：人类限流是 60 条/分钟/账号，600 条必须分摊） */
async function fill(actor, conversationId, count, tag) {
  const seqs = [];
  for (let i = 0; i < count; i += 1) {
    const out = await send(actor, conversationId, `${tag} #${i + 1} ${rnd()}`);
    if (typeof out.seq === 'number') seqs.push(out.seq);
  }
  return seqs;
}

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 页面侧的度量钩子（在任何应用代码之前注入） ---------------- */

function installPerfHooks() {
  const perf = { arrivals: new Map(), renders: [], longtasks: [], gaps: [] };
  window.__perf = perf;

  // WS 帧到达时间：App 的 ChatSocket 也是在这里收帧，等于「消息到达客户端」的时刻
  const NativeWS = window.WebSocket;
  if (NativeWS) {
    class PatchedWS extends NativeWS {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          try {
            const frame = JSON.parse(event.data);
            if (frame && frame.t === 'event' && typeof frame.seq === 'number') perf.arrivals.set(frame.seq, performance.now());
          } catch {
            /* 非 JSON 帧 */
          }
        });
      }
    }
    window.WebSocket = PatchedWS;
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longtasks.push({ start: entry.startTime, dur: entry.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* 浏览器不支持就留空，断言里会看到 0，另有帧间隔兜底 */
  }

  // 连续 rAF 采样：① 页面真的在出帧，长任务条目才会被 flush（headless 下没有帧时实测会漏报）；
  // ② 帧间隔本身就是「主线程被占用」的独立证据（阻塞 300ms → 帧间隔 283ms，实测）。
  let lastFrameAt = null;
  const tick = (timestamp) => {
    if (lastFrameAt != null) perf.gaps.push(timestamp - lastFrameAt);
    lastFrameAt = timestamp;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // 「出现在 DOM」按一次 rAF 之后记时——那才是真的画上屏的一帧
  const collect = (root) => {
    const nodes = [];
    if (root.matches && root.matches('[data-seq]')) nodes.push(root);
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll('[data-seq]'));
    for (const el of nodes) {
      const seq = Number(el.getAttribute('data-seq'));
      requestAnimationFrame(() => perf.renders.push({ seq, at: performance.now() }));
    }
  };
  const start = () => {
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) collect(node);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
}

/* ---------------- 主流程 ---------------- */

const main = async () => {
  const stamp = rnd();

  /* ---------- 5) 懒加载：静态部分（不依赖浏览器，先跑，失败也不浪费时间） ---------- */
  const indexPath = path.join(DIST, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`找不到 ${indexPath}：先 cd web && npm run build`);
  const html = fs.readFileSync(indexPath, 'utf8');
  const assetsDir = path.join(DIST, 'assets');
  const assets = fs.readdirSync(assetsDir);
  const mainChunkName = assets.find((file) => /^index-.*\.js$/.test(file));
  if (!mainChunkName) throw new Error('assets 里找不到入口 chunk（index-*.js）');
  const mainCode = fs.readFileSync(path.join(assetsDir, mainChunkName), 'utf8');
  const mainBytes = Buffer.byteLength(mainCode);
  const gzipKb = (zlib.gzipSync(Buffer.from(mainCode)).length / 1000).toFixed(2);
  console.log(`\n主 chunk：${mainChunkName}  ${(mainBytes / 1000).toFixed(2)} kB / gzip ${gzipKb} kB`);

  const settingsChunk = assets.find((file) => /^GroupSettingsDialog-.*\.js$/.test(file));
  const packChunk = assets.find((file) => /^StickerPackDialog-.*\.js$/.test(file));
  check(
    '主 chunk 不含群设置/表情包弹窗文案（已拆成懒 chunk）',
    !mainCode.includes('解散群') && !mainCode.includes('确定删除表情包'),
    `解散群=${mainCode.includes('解散群')} 删除表情包=${mainCode.includes('确定删除表情包')}`,
  );
  check('assets 里存在 GroupSettingsDialog / StickerPackDialog 懒 chunk', Boolean(settingsChunk && packChunk), `${settingsChunk || '-'} / ${packChunk || '-'}`);
  if (settingsChunk) {
    const size = (fs.statSync(path.join(assetsDir, settingsChunk)).size / 1000).toFixed(2);
    console.log(`  ${settingsChunk} ${size} kB`);
  }
  if (packChunk) {
    const size = (fs.statSync(path.join(assetsDir, packChunk)).size / 1000).toFixed(2);
    console.log(`  ${packChunk} ${size} kB`);
  }

  const browser = await chromium.launch();

  try {
    /* ---------- 4) 音效延后预加载：登录页不该拉 mp3 ---------- */
    console.log('\n[音效] 未登录页面（登录页）的 mp3 请求');
    const soundCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const soundPage = await soundCtx.newPage();
    const mp3Requests = [];
    soundPage.on('request', (req) => {
      if (/\.mp3(\?|$)/.test(req.url())) mp3Requests.push(req.url());
    });
    await soundPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await soundPage.waitForTimeout(1800);
    const mp3BeforeGesture = mp3Requests.length;
    // 首个用户手势（点在左上角空白处，避开任何按钮）
    await soundPage.mouse.click(6, 6);
    await soundPage.waitForTimeout(1800);
    const mp3AfterGesture = mp3Requests.length;
    check('登录页首屏没有 mp3 请求（音效延后到首个手势）', mp3BeforeGesture === 0, `第一个手势前 ${mp3BeforeGesture} 个`);
    check('首个手势后 mp3 才出现（warmSounds 生效）', mp3AfterGesture > mp3BeforeGesture, `手势前 ${mp3BeforeGesture} → 手势后 ${mp3AfterGesture}`);
    await soundCtx.close();

    /* ---------- 造数据：A 群 220 条（4 个灌水号，每个 55 条） ---------- */
    console.log('\n[造数据] A 群 220 条 + B 群 600 条（限流 60 条/分钟/账号，必须分摊）');
    const startedAt = Date.now();
    const ownerA = await signup(`性能A-${stamp}`);
    ownerA.cookie = `sid=${ownerA.sid}`;
    const waterA = [];
    for (let i = 0; i < 4; i += 1) {
      const actor = await signup(`性能A灌水${i + 1}`);
      actor.cookie = `sid=${actor.sid}`;
      waterA.push(actor);
    }
    const liveSender = await signup(`性能A直播`);
    liveSender.cookie = `sid=${liveSender.sid}`;
    for (const actor of [...waterA, liveSender]) await befriend(ownerA, actor);
    const titleA = `性能A-220-${stamp}`;
    const groupA = await createGroup(ownerA, [...waterA, liveSender], titleA);

    const ownerB = await signup(`性能B-${stamp}`);
    ownerB.cookie = `sid=${ownerB.sid}`;
    const waterB = [];
    for (let i = 0; i < 10; i += 1) {
      const actor = await signup(`性能B灌水${i + 1}`);
      actor.cookie = `sid=${actor.sid}`;
      waterB.push(actor);
    }
    for (const actor of waterB) await befriend(ownerB, actor);
    const titleB = `性能B-600-${stamp}`;
    const groupB = await createGroup(ownerB, waterB, titleB);
    // 第 1 条先发一条「最早标记」：后面用它验证「搜索跳到窗口外的老消息」。
    // 人类限流 60 条/分钟/账号，ownerB 只发这 1 条，不影响 10 个灌水号各 60 条的预算。
    const markerB = `B群最早标记-${stamp}`;
    await send(ownerB, groupB, markerB);

    await Promise.all([
      ...waterA.map((actor, index) => fill(actor, groupA, 55, `A历史${index + 1}`)),
      ...waterB.map((actor, index) => fill(actor, groupB, 60, `B历史${index + 1}`)),
    ]);
    console.log(`  数据就绪：${((Date.now() - startedAt) / 1000).toFixed(1)}s（A 群 220 条 / B 群 600 条）`);

    /* ---------- 1) 长任务 + 到达渲染延迟；3) 已读合并 ---------- */
    console.log('\n[渲染] A 打开 220 条的群，另一个账号 WS 连发 20 条');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    await ctx.addCookies([{ name: 'sid', value: ownerA.sid, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    const readRequests = [];
    const pageRequests = [];
    page.on('request', (req) => {
      pageRequests.push(req.url());
      if (/\/api\/conversations\/\d+\/read/.test(req.url())) readRequests.push(req.url());
    });
    await page.addInitScript(installPerfHooks);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.conv__item', { timeout: 30000 });
    await page.locator('.conv__item', { hasText: titleA }).first().click();
    await page.waitForSelector('.msg', { timeout: 20000 });
    await page.waitForTimeout(1500);

    const seqsBefore = await page.evaluate(() =>
      [...document.querySelectorAll('.msg[data-seq]')].map((el) => Number(el.getAttribute('data-seq'))),
    );
    const baseMax = seqsBefore.length ? Math.max(...seqsBefore) : 0;
    console.log(`  打开时 DOM 里 ${seqsBefore.length} 条，maxSeq=${baseMax}`);

    await page.evaluate(() => {
      window.__perf.arrivals.clear();
      window.__perf.renders = [];
      window.__perf.longtasks = [];
      window.__perf.gaps = [];
    });

    // 先自证测量管线有效：故意阻塞 160ms，必须能被 PerformanceObserver('longtask')
    // 或 rAF 帧间隔看见。否则「0 个长任务」可能只是观测器根本没工作。
    const signalProbe = await page.evaluate(async () => {
      window.__perf.longtasks = [];
      window.__perf.gaps = [];
      const started = performance.now();
      while (performance.now() - started < 160) {
        /* 阻塞主线程 */
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      const observer = window.__perf.longtasks.reduce((acc, item) => Math.max(acc, item.dur), 0);
      const frameGap = window.__perf.gaps.reduce((acc, gap) => Math.max(acc, gap), 0);
      window.__perf.longtasks = [];
      window.__perf.gaps = [];
      return { observer, frameGap };
    });
    check(
      '长任务测量管线有效（人为阻塞 160ms 被记录）',
      signalProbe.observer >= 100 || signalProbe.frameGap >= 100,
      `observer=${signalProbe.observer.toFixed(1)}ms / rAF 帧间隔=${signalProbe.frameGap.toFixed(1)}ms`,
    );

    const burstStart = Date.now();
    const burst = await fill(liveSender, groupA, 20, 'A直播');
    const burstMs = Date.now() - burstStart;
    await page.waitForTimeout(1800);

    const perf = await page.evaluate(() => ({
      arrivals: [...window.__perf.arrivals.entries()],
      renders: window.__perf.renders,
      longtasks: window.__perf.longtasks,
      gaps: window.__perf.gaps,
    }));
    const seqsAfter = await page.evaluate(() =>
      [...document.querySelectorAll('.msg[data-seq]')].map((el) => Number(el.getAttribute('data-seq'))),
    );
    const arrived = new Set(perf.arrivals.map(([seq]) => Number(seq)));
    const renderedAt = new Map();
    for (const item of perf.renders) if (!renderedAt.has(item.seq)) renderedAt.set(item.seq, item.at);
    const latencies = [];
    for (const [seq, at] of perf.arrivals) {
      const renderAt = renderedAt.get(Number(seq));
      if (renderAt == null || Number(seq) <= baseMax) continue;
      latencies.push(renderAt - at);
    }
    const longTaskMax = perf.longtasks.reduce((acc, item) => Math.max(acc, item.dur), 0);
    const longTaskCount = perf.longtasks.length;
    const frameGapMax = perf.gaps.reduce((acc, gap) => Math.max(acc, gap), 0);
    // 两个信号取大：observer 是真·长任务；帧间隔是「主线程被占住」的独立证据（headless 漏报时兜底）
    const effectiveLongTask = Math.max(longTaskMax, frameGapMax);
    const arrivalP50 = pct(latencies, 50);
    const arrivalP95 = pct(latencies, 95);

    console.log(
      `  20 条推送耗时 ${burstMs}ms；WS 帧到达 ${arrived.size} 条；长任务 ${longTaskCount} 个，observer 最大 ${longTaskMax.toFixed(1)}ms，rAF 最大帧间隔 ${frameGapMax.toFixed(1)}ms`,
    );
    console.log(
      `  到达→渲染 P50 ${arrivalP50.toFixed(1)}ms / P95 ${arrivalP95.toFixed(1)}ms（样本 ${latencies.length}；含 rAF 一帧 ≈16.7ms）`,
    );
    check(`20 条全部上屏（baseMax ${baseMax} → ${baseMax + 20}）`, Math.max(...seqsAfter) >= baseMax + 20 && burst.length === 20, `burst=${burst.length}`);
    check(`最大长任务 < ${LONG_TASK_LIMIT_MS}ms`, effectiveLongTask < LONG_TASK_LIMIT_MS, `${effectiveLongTask.toFixed(1)}ms（observer ${longTaskMax.toFixed(1)} / 帧间隔 ${frameGapMax.toFixed(1)}）`);
    check(`消息到达渲染 P95 < ${RENDER_P95_LIMIT_MS}ms`, latencies.length > 0 && arrivalP95 < RENDER_P95_LIMIT_MS, `P95=${arrivalP95.toFixed(1)}ms n=${latencies.length}`);

    // 已读合并：清空计数后连发 5 条，只允许 ≤2 次 POST /read
    await page.waitForTimeout(700);
    readRequests.length = 0;
    await fill(liveSender, groupA, 5, 'A已读');
    await page.waitForTimeout(2500);
    console.log(`  /read 请求：${readRequests.length} 次（5 条消息，500ms trailing 合并）`);
    check(`已读回执合并：5 条消息 POST /read ≤ ${READ_REQUESTS_LIMIT}`, readRequests.length > 0 && readRequests.length <= READ_REQUESTS_LIMIT, `${readRequests.length} 次`);

    // 懒加载的运行时证据：点「群设置」之前不该有 GroupSettingsDialog chunk 请求
    const beforeClick = pageRequests.filter((url) => /GroupSettingsDialog/.test(url)).length;
    let dialogOpened = false;
    try {
      pageRequests.length = 0;
      await page.locator('button[aria-label="群设置"]').first().click();
      await page.waitForSelector('text=解散群', { timeout: 10000 });
      dialogOpened = true;
    } catch {
      dialogOpened = false;
    }
    const dialogChunkLoaded = pageRequests.some((url) => /GroupSettingsDialog/.test(url));
    check('点「群设置」前不加载懒 chunk，点开后才拉', beforeClick === 0 && dialogChunkLoaded && dialogOpened, `click前=${beforeClick} chunk=${dialogChunkLoaded} open=${dialogOpened}`);
    await page.keyboard.press('Escape').catch(() => {});
    await ctx.close();

    /* ---------- 2) 消息窗口上限：600 条的群翻到底 ---------- */
    console.log('\n[窗口上限] B 打开 600 条的群，反复滚到顶翻页');
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    await ctxB.addCookies([{ name: 'sid', value: ownerB.sid, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
    const pageB = await ctxB.newPage();
    const olderRequests = [];
    pageB.on('request', (req) => {
      if (/\/api\/conversations\/\d+\/messages\?/.test(req.url()) && /before_seq=/.test(req.url())) olderRequests.push(req.url());
    });
    await pageB.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await pageB.waitForSelector('.conv__item', { timeout: 30000 });
    await pageB.locator('.conv__item', { hasText: titleB }).first().click();
    await pageB.waitForSelector('.msg', { timeout: 20000 });
    await pageB.waitForTimeout(1500);

    const domCount = () =>
      pageB.evaluate(() => {
        const seqs = [...document.querySelectorAll('.msg[data-seq]')].map((el) => Number(el.getAttribute('data-seq')));
        return { count: seqs.length, min: seqs.length ? Math.min(...seqs) : 0, max: seqs.length ? Math.max(...seqs) : 0, seqs };
      });

    let first = await domCount();
    console.log(`  首屏 ${first.count} 条（${first.min}..${first.max}）`);
    // 关掉 CSS 平滑滚动：scrollTop=0 在 smooth 下是动画，测试会在动画途中就去数条数
    await pageB.evaluate(() => {
      const el = document.querySelector('.messages');
      if (el) el.style.scrollBehavior = 'auto';
    });
    let stableRounds = 0;
    let previousCount = first.count;
    for (let i = 0; i < 16; i += 1) {
      await pageB.evaluate(() => {
        const el = document.querySelector('.messages');
        if (!el) return;
        el.scrollTop = 60;
        el.scrollTop = 0;
      });
      await pageB.waitForTimeout(800);
      const now = await domCount();
      if (now.count === previousCount) stableRounds += 1;
      else stableRounds = 0;
      previousCount = now.count;
      console.log(`  第 ${i + 1} 次滚到顶：${now.count} 条（${now.min}..${now.max}），翻页请求累计 ${olderRequests.length}`);
      if (stableRounds >= 2) break;
    }
    const last = await domCount();
    const contiguous = last.seqs.every((seq, index) => index === 0 || seq === last.seqs[index - 1] + 1);
    check(`窗口上限：DOM 里 .msg ≤ ${DOM_WINDOW_LIMIT}`, last.count <= DOM_WINDOW_LIMIT, `实际 ${last.count} 条`);
    check('窗口上限：裁掉的是头部（最老 seq > 1）', last.min > 1, `min=${last.min}`);
    check('窗口边界内消息连续（没有中间空洞）', contiguous, `${last.min}..${last.max}`);
    check('翻页到上限后不再无限重复请求', olderRequests.length <= 12, `翻页请求 ${olderRequests.length} 次`);

    // 搜索跳到「窗口外」的最老那条：目标必须上屏并高亮。
    // 这条钉的是 useChatStream 的 jump pin —— 窗口裁剪会把比当前窗口更老的历史当头部丢掉，
    // 没有保护就会出现「提示找到了，列表里却没有，滚不过去」。
    console.log('\n[搜索跳转] 从窗口外跳回第 1 条');
    let jumpOk = false;
    let jumpDetail = '';
    try {
      await pageB.locator('.conv__search-input').fill(markerB);
      await pageB.waitForSelector('.sr__item', { timeout: 15000 });
      await pageB.locator('.sr__item').first().click();
      await pageB.waitForSelector('.msg--flash', { timeout: 15000 });
      const jumped = await pageB.evaluate(() => {
        const el = document.querySelector('.msg--flash');
        return { seq: el ? Number(el.getAttribute('data-seq')) : null, text: el ? el.innerText.slice(0, 40) : '' };
      });
      const afterJump = await domCount();
      jumpOk = jumped.seq === 1 && jumped.text.includes(markerB) && afterJump.min === 1;
      jumpDetail = `data-seq=${jumped.seq} min=${afterJump.min} 条数=${afterJump.count}`;
    } catch (err) {
      jumpDetail = String(err).slice(0, 80);
    }
    check('搜索跳到窗口外的老消息：目标上屏并高亮（窗口保护生效）', jumpOk, jumpDetail);
    await ctxB.close();

    /* ---------- 汇总 ---------- */
    const failed = results.filter((item) => !item.ok);
    console.log('');
    if (failed.length === 0) {
      console.log(`全部通过：${results.length}/${results.length}`);
    } else {
      console.log(`失败 ${failed.length}/${results.length}：${failed.map((item) => item.name).join(' / ')}`);
    }
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
};

main().catch((err) => {
  console.error('脚本异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
