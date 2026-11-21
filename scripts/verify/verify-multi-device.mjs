#!/usr/bin/env node
// ============================================================================
// scripts/verify/verify-multi-device.mjs —— 「手机和电脑，在同一个群里，消息同秒到」
//
// 为什么要这条：宣传里有一句「两端同群、消息同秒到」，此前只有代码推断
// （sessions 表不对 principal 加唯一约束 + WS 广播），没有任何自动化证据。
// 别人问「真的假的」时我们只能嘴上说。这个脚本把它变成可复跑的数字。
//
// 做法：两个独立 browser context = 两台设备（A=电脑 1280×900，B=手机 390×844），
// **同一个账号**登录（这是产品设计：同账号多会话共存，不要按「应踢旧端」写断言）。
// 一边用真实 UI 发消息，另一边用 WS 帧到达时间算延迟，并打印实测毫秒。
//
// 关于未读：读状态是**账号级**的（conversation_members.last_read_seq），不是每台设备一份。
// 所以「不重复计」的正确口径是：
//   - 两端各自登录同一个账号时，未读数必须相等且不被设备数放大（V 发 2 条 → 两边都是 2，不是 4）；
//   - 一端打开会话后，另一端也归零（共享读游标）；
//   - 自己发的消息不给自己记未读。
//
// 覆盖：
//   1. A→B：电脑端用真实 UI 发，手机端 ≤1000ms 收到（打印实测 ms）；
//   2. B→A：反方向同样 ≤1000ms（打印实测 ms）；
//   3. 两端 presence 在线（客户端 WS 已连接 + 会话成员 online=true）；
//   4. 未读共享、不重复计（第三方发 2 条 → 两端都是 2；一端读完 → 两端归零）；
//   5. 两端会话列表顺序一致、同一会话 last_seq 相同。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-multi-device.mjs
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SHOTS = process.env.SHOTS_DIR
  ? path.resolve(process.env.SHOTS_DIR)
  : path.join(ROOT, 'docs', 'shots');
const LIMIT_MS = 1000;

const problems = [];
function check(name, ok, detail = '') {
  if (!ok) problems.push(`${name}${detail ? '  — ' + detail : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(p, body, cookie, method = 'POST') {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      'user-agent': 'aio-verify/1.0',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('sid=')) || cookie;
  return { status: res.status, json, cookie: sid };
}

const convList = async (cookie) => {
  const r = await api('/api/conversations?limit=50', undefined, cookie, 'GET');
  return Array.isArray(r.json) ? r.json : r.json?.conversations || [];
};

// 读游标是客户端发起的异步写入（打开/渲染后调 POST /:id/read），所以 unread 会「先大后小」。
// 这里轮询等它收敛，再断言——这不是放宽阈值，而是等一个必然发生的事件（UI 上也是稍后才归零）。
const waitUnread = async (getList, gid, expected, timeoutMs = 6000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    const row = (await getList()).find((c) => c.id === gid);
    last = row?.unread;
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
};

// 记录 WS 帧到达时间（毫秒时间戳），用来量「同秒到」而不只是「DOM 变了」
const WS_LOG = () => {
  window.__wsLog = [];
  window.__wsOpen = false;
  const Orig = window.WebSocket;
  class Patched extends Orig {
    constructor(...args) {
      super(...args);
      this.addEventListener('open', () => { window.__wsOpen = true; });
      this.addEventListener('close', () => { window.__wsOpen = false; });
      this.addEventListener('message', (ev) => {
        try {
          window.__wsLog.push({ t: Date.now(), data: typeof ev.data === 'string' ? ev.data.slice(0, 6000) : '' });
        } catch { /* 忽略非文本帧 */ }
      });
    }
  }
  window.WebSocket = Patched;
};

const waitWsFrame = async (page, marker, timeout = 3000) => {
  await page.waitForFunction((m) => (window.__wsLog || []).some((f) => f.data.includes(m)), marker, { timeout });
  return page.evaluate((m) => (window.__wsLog.find((f) => f.data.includes(m)) || {}).t, marker);
};

const unreadDom = async (page) => page.evaluate(() => {
  const el = document.querySelector('.badge-dot');
  return el ? ((el.getAttribute('aria-label') || '') + '|' + (el.textContent || '').trim()) : '';
});

const openConversation = async (page, title) => {
  await page.waitForSelector('.conv__item', { timeout: 30000 });
  const item = page.locator('.conv__item', { hasText: title }).first();
  await item.click({ timeout: 15000 });
  await page.waitForSelector('.composer__input', { timeout: 30000 });
  await page.waitForTimeout(300);
};

const sendInUi = async (page, body) => {
  await page.fill('.composer__input', body);
  const t0 = await page.evaluate(() => Date.now());
  await page.press('.composer__input', 'Enter');
  return t0;
};

const hasBubble = (page, marker) => page.waitForFunction(
  (m) => Array.from(document.querySelectorAll('.bubble__body')).some((el) => el.textContent.includes(m)),
  marker, { timeout: 10000 },
).then(() => true).catch(() => false);

const register = async (prefix, name) => {
  const email = `${prefix}_${crypto.randomBytes(4).toString('hex')}@test.dev`;
  const r = await api('/api/auth/register', {
    email, password: 'passw0rd!x', display_name: name, invite_code: process.env.REGISTER_CODE || '',
  });
  if (!r.cookie) throw new Error(`注册失败 ${r.status} ${JSON.stringify(r.json)}`);
  const me = (await api('/api/me', undefined, r.cookie, 'GET')).json || {};
  return { cookie: r.cookie, me };
};

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  // 账号 U：两台设备共用；账号 V：第三方（只有"别人发的"才会产生未读）
  const U = await register('md', '多端验证');
  const V = await register('mdv', '旁观者');
  // 产品规则：只能拉好友（或自己的 AI）进群，所以先把 V 变成好友
  const freq = await api('/api/friends/request', { account_no: V.me.accountNo }, U.cookie);
  if (freq.status !== 200) { console.log('加好友失败：', freq.status, JSON.stringify(freq.json)); return 1; }
  const facc = await api('/api/friends/accept', { principal_id: U.me.id }, V.cookie);
  if (facc.status !== 200) { console.log('接受好友失败：', facc.status, JSON.stringify(facc.json)); return 1; }
  const agent = await api('/api/agents', { display_name: '多端验证AI' }, U.cookie);
  const agentId = agent.json?.agent?.id;
  const grp = await api('/api/conversations', { title: '多端验证群', member_ids: [agentId, V.me.id] }, U.cookie);
  const gid = grp.json?.conversation?.id;
  const grp2 = await api('/api/conversations', { title: '多端验证群B', member_ids: [agentId] }, U.cookie);
  const gid2 = grp2.json?.conversation?.id;
  if (!gid || !gid2) { console.log('建群失败：', grp.status, grp2.status, JSON.stringify(grp.json)); return 1; }
  await api(`/api/conversations/${gid}/messages`, { body: '开场白', client_msg_id: crypto.randomBytes(6).toString('hex') }, U.cookie);

  const host = new URL(BASE).hostname;
  const cookie = { name: 'sid', value: U.cookie.split('=')[1], domain: host, path: '/' };

  const browser = await chromium.launch();
  try {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const ctxB = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: 'zh-CN',
      isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    await ctxA.addCookies([cookie]);
    await ctxB.addCookies([cookie]);
    await ctxA.addInitScript(WS_LOG);
    await ctxB.addInitScript(WS_LOG);

    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    await A.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await B.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await A.waitForSelector('.conv__item', { timeout: 30000 });
    await B.waitForSelector('.conv__item', { timeout: 30000 });

    // ---------- 1) presence ----------
    await A.waitForSelector('.conn--on', { timeout: 20000 });
    await B.waitForSelector('.conn--on', { timeout: 20000 });
    check('电脑端 WS 已连接（.conn--on）', true);
    check('手机端 WS 已连接（.conn--on）', true);
    const list0 = await convList(U.cookie);
    const gidRow = list0.find((c) => c.id === gid) || {};
    const selfMember = (gidRow.members || []).find((m) => String(m.id) === String(U.me.id));
    check('服务端把本账号标为在线（同账号两块屏）', selfMember?.online === true, `member.online=${selfMember?.online}`);

    // 清掉「开场白」的初始未读：直接调读接口（客户端打开会话时做的也是这件事）。
    // 不从手机端点进点出——「推入式」导航里列表 DOM 一直在，容易误判成已回列表。
    const lastSeq0 = (await convList(U.cookie)).find((c) => c.id === gid)?.lastSeq ?? 0;
    await api(`/api/conversations/${gid}/read`, { seq: lastSeq0 }, U.cookie);

    // ---------- 2) 未读：账号级共享、不被设备数放大（两端都还在列表页） ----------
    const m3 = 'c' + crypto.randomBytes(4).toString('hex');
    const m4 = 'd' + crypto.randomBytes(4).toString('hex');
    const s3 = await api(`/api/conversations/${gid}/messages`, { body: `旁观一 ${m3}`, client_msg_id: m3 }, V.cookie);
    const s4 = await api(`/api/conversations/${gid}/messages`, { body: `旁观二 ${m4}`, client_msg_id: m4 }, V.cookie);
    if (s3.status !== 200 || s4.status !== 200) {
      console.log('第三方发消息失败：', s3.status, s4.status, JSON.stringify(s3.json));
      return 1;
    }
    await waitWsFrame(A, m3);
    await waitWsFrame(B, m4);
    await A.waitForTimeout(500);

    const unreadA = await waitUnread(() => convList(U.cookie), gid, 2);
    const listB0 = await B.evaluate(async () => {
      const r = await fetch('/api/conversations?limit=50', { credentials: 'include' });
      return r.ok ? await r.json() : [];
    });
    const unreadB = (listB0.find((c) => c.id === gid) || {}).unread;
    check('别人发 2 条 → 电脑端未读 2', unreadA === 2, `unread=${unreadA}`);
    check('别人发 2 条 → 手机端未读也是 2（不是 4，未读不按设备计数）', unreadB === 2, `unread=${unreadB}`);
    check('两端未读数完全一致', unreadA === unreadB, `A=${unreadA} / B=${unreadB}`);
    // 徽标是客户端本地状态：重新加载一次，验证「服务端真值 → 列表渲染」这条链
    // （不重载时客户端可能还没处理已读广播，那属于同步时效问题，不是数值算错）
    await B.reload({ waitUntil: 'domcontentloaded' });
    await B.waitForSelector('.conv__item', { timeout: 20000 });
    await B.waitForTimeout(400);
    const domBadge = await unreadDom(B);
    check('手机端刷新后列表徽标显示 2', domBadge.includes('2 条未读'), `badge="${domBadge}"`);

    // 一端读完 → 另一端也归零（共享读游标）
    await openConversation(A, '多端验证群');
    await A.waitForTimeout(600);
    const unreadA2 = await waitUnread(() => convList(U.cookie), gid, 0);
    const listB1 = await B.evaluate(async () => {
      const r = await fetch('/api/conversations?limit=50', { credentials: 'include' });
      return r.ok ? await r.json() : [];
    });
    const unreadB2 = (listB1.find((c) => c.id === gid) || {}).unread;
    check('电脑端读完后两端都清零（共享读游标）', unreadA2 === 0 && unreadB2 === 0, `A=${unreadA2} / B=${unreadB2}`);

    // ---------- 3) A（电脑）→ B（手机）：≤1000ms ----------
    const markerAB = 'ab' + crypto.randomBytes(4).toString('hex');
    const t0 = await sendInUi(A, `电脑发手机收 ${markerAB}`);
    const msAB = (await waitWsFrame(B, markerAB)) - t0;
    check(`A→B 通过 WS 收到（${msAB}ms ≤ ${LIMIT_MS}ms）`, msAB <= LIMIT_MS, `实测 ${msAB}ms`);
    console.log(`实测 A→B = ${msAB}ms`);
    const unreadAfterOwn = await waitUnread(() => convList(U.cookie), gid, 0);
    check('自己发的消息不给自己记未读（账号级读游标）', unreadAfterOwn === 0, `unread=${unreadAfterOwn}`);

    // ---------- 4) B 打开会话 → DOM 有消息、再反方向 ----------
    await openConversation(B, '多端验证群');
    check('手机端打开会话后消息在 DOM 里', await hasBubble(B, markerAB));
    const markerBA = 'ba' + crypto.randomBytes(4).toString('hex');
    const t2 = await sendInUi(B, `手机发电脑收 ${markerBA}`);
    const msBA = (await waitWsFrame(A, markerBA)) - t2;
    check(`B→A 通过 WS 收到（${msBA}ms ≤ ${LIMIT_MS}ms）`, msBA <= LIMIT_MS, `实测 ${msBA}ms`);
    console.log(`实测 B→A = ${msBA}ms`);
    check('电脑端看到手机发来的消息', await hasBubble(A, markerBA));

    // ---------- 6) 两端列表顺序与 seq 一致 ----------
    const listA = await convList(U.cookie);
    const listB = await B.evaluate(async () => {
      const r = await fetch('/api/conversations?limit=50', { credentials: 'include' });
      return r.ok ? await r.json() : [];
    });
    const seqA = (listA.find((c) => c.id === gid) || {}).lastSeq;
    const seqB = (listB.find((c) => c.id === gid) || {}).lastSeq;
    check('两端会话顺序一致（第一条是同一个会话）', listA[0]?.id === listB[0]?.id, `${listA[0]?.id} vs ${listB[0]?.id}`);
    check('两端读到同一个 last_seq', typeof seqA === 'number' && seqA === seqB, `A=${seqA} / B=${seqB}`);

    await A.screenshot({ path: path.join(SHOTS, 'multi-device-desktop.png') });
    await B.screenshot({ path: path.join(SHOTS, 'multi-device-mobile.png') });

    await ctxA.close();
    await ctxB.close();
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.log(`\n有失败：${problems.length} 条`);
    for (const p of problems) console.log('  - ' + p);
    return 1;
  }
  console.log('\n全部通过：双端同群（presence / 双向 ≤1000ms / 未读共享不重复计 / 顺序一致）');
  return 0;
}

process.exit(await main());
