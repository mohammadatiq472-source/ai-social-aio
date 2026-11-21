#!/usr/bin/env node
// WS 慢消费者（外部审查 Q4）——**确定性**回归：注入假 socket，不依赖内核收发缓冲。
//
// 为什么不再用「真实 TCP 造背压」：背压分支的触发条件 `socket.bufferedAmount > MAX_BUFFERED_BYTES`
// 能不能满足，取决于内核的 rcvbuf / tcp_wmem。Linux 会自动调优到几 MB，客户端把读暂停之后
// 我们要发几百 KB 才顶得过去——而人类发送还有 60 条/分钟的硬上限，根本发不够。
// 生产实测就是这样：脚本 7/12，失败项全是「丢帧 0 / resync 行 0」，背压分支压根没执行；
// CI（ubuntu）会长期红。把内核参数当契约是错的，所以改成注入一个 bufferedAmount 已知的假 socket。
//
// 生产路径一行没变（hub.mjs 只多了一个 __testHooks 导出）。本脚本直接 import hub，
// 在进程内注册假 socket 再调 deliverToConversation，所以：
//   - 不 spawn 整套服务（不需要 8794 端口，也不需要 WS_MAX_BUFFERED_BYTES）；
//   - 真实数据（用户 / AI / 群 / 消息 seq）仍走 REST 打到 BASE，补拉断言用的是真消息；
//   - 断言全部是「要么确定成立、要么确定不成立」，不看机器快慢。
//
// 覆盖的契约：
//   1. 背压时**不投递**给慢 socket（healthy 照常收到）；
//   2. 冷却窗口结束后给慢 socket 补一帧 {t:'resync_required', conversationId, lastSeq}；
//   3. 连丢多帧只合并成一帧，lastSeq 取最大的被丢 seq；
//   4. 日志 [ws.slow_consumer] 字段齐全（principal / 会话 / lastSeq / 水位 / 丢帧数），
//      **不含正文、不含 cookie/token**；
//   5. 用真实 cookie 走 GET ...?since_seq=0 补拉，seq 与发送时完全一致（连续、无重复）；
//   6. 正常 socket 全程收全、且从不需要 resync；
//   7. 公告帧（没有 seq）丢帧时 lastSeq=0：客户端只重拉元数据，不当作消息空洞；
//   8. 移除 socket 后不再有幽灵投递。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-ws-backpressure.mjs
// 前置：BASE 上有服务在跑（建用户/AI/群、发消息都走它）；本机 PG（DATABASE_URL，默认 5434/aio）。
import crypto from 'node:crypto';

// 先补默认 env 再 import：src/config.mjs 在 import 时读 process.env，src/db.mjs 用它建连接池
// （连接串为空会直接连不上，报错还很难看懂）。
process.env.DATABASE_URL ||= 'postgres://postgres@127.0.0.1:5434/aio';
process.env.WRITER_DATABASE_URL ||= process.env.DATABASE_URL;
process.env.SESSION_SECRET ||= 'dev-only-secret';

const { deliverAnnouncement, deliverToConversation, __testHooks } = await import('../../src/ws/hub.mjs');
const { closeDb } = await import('../../src/db.mjs');

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
/** hub 默认阈值（1.5MB）：本脚本不覆盖它，只用 10MB 的假 socket 保证一定超阈值 */
const DEFAULT_MAX_BUFFERED = 1.5 * 1024 * 1024;
const SLOW_BUFFERED = 10 * 1024 * 1024;
/** 服务端冷却窗口 1s（hub.mjs#SLOW_NOTIFY_COOLDOWN_MS）：等过它才能断言「合并成一帧」 */
const COOLDOWN_TIMEOUT = 3000;
/** 一共发几条真实消息：1 条触发首帧 + 5 条验证冷却合并 */
const MESSAGE_COUNT = 6;

const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 正文标记：只可能出现在正文里，用来断言日志没记正文（[C6]） */
const BODY_MARK = `背压正文标记-${rnd()}`;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const sid = (res.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

/**
 * 假 socket：sendText 只看 readyState / bufferedAmount / send()，其它成员给 no-op 占位，
 * 免得以后 hub 里加了 socket.close()/ping() 之类就把这条回归带崩。
 */
function fakeSocket(bufferedAmount) {
  return {
    readyState: 1,
    bufferedAmount,
    sent: [],
    send(text) { this.sent.push(text); },
    close() {},
    ping() {},
    on() {},
  };
}

function frames(socket) {
  return socket.sent.map((t) => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean);
}

/** 注册临时用户 + 建 AI + 建群（cleanup-test 按 t_%@test.dev 清用户，群按 owner 清） */
async function seed() {
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email: `t_${rnd()}@test.dev`,
      password: 'passw0rd!x',
      display_name: '背压探针',
      invite_code: process.env.REGISTER_CODE || '',
    },
  });
  if (reg.status !== 200) throw new Error(`注册失败 ${reg.status} ${reg.text?.slice(0, 160)}`);
  const meId = Number(reg.json.me.id);
  const cookie = reg.cookie;
  const ag = await api('/api/agents', { method: 'POST', cookie, body: { display_name: `背压AI${rnd()}` } });
  const aiId = Number(ag.json?.agent?.id);
  if (!aiId) throw new Error(`建 AI 失败 ${ag.status} ${ag.text?.slice(0, 160)}`);
  const conv = await api('/api/conversations', {
    method: 'POST', cookie, body: { title: `背压验证群-${rnd()}`, member_ids: [aiId] },
  });
  const convId = Number(conv.json?.conversation?.id);
  if (!convId) throw new Error(`建群失败 ${conv.status} ${conv.text?.slice(0, 160)}`);
  return { cookie, meId, aiId, convId };
}

const contiguous = (arr) => arr.every((v, i) => i === 0 || v === arr[i - 1] + 1);

/**
 * 等条件成立（最多 timeoutMs）。
 * 为什么不用固定 sleep：冷却窗口是服务端 1s 的定时器，CI 机器负载高时它会晚触发；
 * 固定 sleep(1300) 在慢机器上会读到「只有 1 帧」→ 假红。轮询到条件成立为止，慢一点但不误判。
 */
async function waitFor(fn, timeoutMs = COOLDOWN_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

const resyncFrames = (socket) => frames(socket).filter((f) => f.t === 'resync_required');

const main = async () => {
  let seeded = null;
  const slow = fakeSocket(SLOW_BUFFERED);
  const healthy = fakeSocket(0);
  const warnings = [];
  const origWarn = console.warn;
  let hooked = false;
  let attached = false;
  try {
    seeded = await seed();
    const { cookie, meId, aiId, convId } = seeded;

    // 真实消息：seq / body 都来自数据库，后面的补拉断言才有意义
    const sentSeqs = [];
    for (let i = 0; i < MESSAGE_COUNT; i += 1) {
      const r = await api(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        cookie,
        body: { body: `${BODY_MARK}-${i}`, client_msg_id: rnd() + rnd() },
      });
      if (r.status !== 200 || !r.json?.seq) throw new Error(`发消息失败 ${r.status} ${r.text?.slice(0, 160)}`);
      sentSeqs.push(Number(r.json.seq));
    }
    check('准备：临时用户 + AI + 群，发了 6 条真实消息（seq 连续）',
      sentSeqs.length === MESSAGE_COUNT && contiguous(sentSeqs),
      `conv=${convId} me=${meId} ai=${aiId} seq=${sentSeqs[0]}..${sentSeqs.at(-1)}`);

    // 劫持 console.warn 抓 [ws.slow_consumer]（db.mjs 的慢查询也用 warn，按 tag 过滤）
    console.warn = (...args) => { warnings.push(args.map((a) => String(a)).join(' ')); };
    hooked = true;

    // 注入两个假 socket：同一个 AI 的两条连接（一条慢、一条正常），覆盖「慢邻居不拖累别人」
    __testHooks.addSocket(aiId, slow);
    __testHooks.addSocket(aiId, healthy);
    attached = true;
    const payload = (seq, i) => ({
      conversationId: convId,
      seq,
      eventId: 900000 + seq,
      clientMsgId: `bp-${seq}`,
      senderId: meId,
      senderType: 'user',
      senderName: '背压探针',
      body: `${BODY_MARK}-${i}`,
      parts: [],
      replyToSeq: null,
      mentions: [],
      createdAt: new Date().toISOString(),
    });

    // ---- 第一帧：慢 socket 缓冲 10MB > 1.5MB → 丢；healthy 必须照常收到
    const first = await deliverToConversation(convId, payload(sentSeqs[0], 0));
    await waitFor(() => resyncFrames(slow).length >= 1, 2000);
    const slowEvents = frames(slow).filter((f) => f.t === 'event');
    const healthyEvents = frames(healthy).filter((f) => f.t === 'event');
    check('背压：healthy 收到 event，slow 没收到（不再「发了但不知道丢了」）',
      healthyEvents.length === 1 && slowEvents.length === 0,
      `deliver=${JSON.stringify({ recipients: first?.recipients, bytes: first?.bytes })} slow=${slowEvents.length} healthy=${healthyEvents.length}`);

    const slowLines = warnings.filter((w) => w.includes('[ws.slow_consumer]'));
    const parsed = slowLines.map((l) => {
      try { return JSON.parse(l.slice(l.indexOf('{'))) } catch { return null; }
    }).filter(Boolean);
    const firstLog = parsed[0] || {};
    check('日志 [ws.slow_consumer] 字段齐全（principal / 会话 / lastSeq / 水位 / 丢帧数）',
      parsed.length === 1
      && Number(firstLog.principalId) === aiId && Number(firstLog.conversationId) === convId
      && Number(firstLog.lastSeq) === sentSeqs[0]
      && Number(firstLog.bufferedAmount) >= DEFAULT_MAX_BUFFERED
      && Number(firstLog.droppedFrames) >= 1,
      JSON.stringify(firstLog));
    check('日志不含正文、不含 cookie/token（[C6]）',
      !warnings.join('\n').includes(BODY_MARK) && !warnings.join('\n').includes(String(cookie).replace(/^sid=/, '')));

    // ---- 冷却后补一帧 resync_required（首帧：notifiedAt=0 → 立即 flush）
    const resync1 = resyncFrames(slow);
    check('冷却后慢 socket 收到 resync_required，conversationId 正确、lastSeq=被丢的 seq',
      resync1.length === 1 && Number(resync1[0].conversationId) === convId && Number(resync1[0].lastSeq) === sentSeqs[0],
      JSON.stringify(resync1));

    // ---- 冷却窗口内连丢 5 帧：只能合并成 1 帧，lastSeq 取最大
    for (let i = 1; i < sentSeqs.length; i += 1) {
      await deliverToConversation(convId, payload(sentSeqs[i], i));
    }
    await waitFor(() => resyncFrames(slow).length >= 2);
    const resyncAll = resyncFrames(slow);
    check('连丢 5 帧在 1s 冷却窗口内合并成 1 帧，lastSeq 取最大（不逐帧轰炸）',
      resyncAll.length === 2 && Number(resyncAll[1].lastSeq) === sentSeqs.at(-1),
      `resync 帧=${JSON.stringify(resyncAll.map((f) => f.lastSeq))}`);

    const healthyAll = frames(healthy).filter((f) => f.t === 'event').map((f) => Number(f.seq));
    check('healthy 全程收全 6 条 event 且 seq 连续（慢邻居不拖累别人）',
      healthyAll.length === sentSeqs.length && healthyAll.every((v, i) => v === sentSeqs[i]),
      `收到 ${healthyAll.length}/${sentSeqs.length}`);
    check('healthy 从未收到 resync_required（正常客户端不需要补拉）',
      !frames(healthy).some((f) => f.t === 'resync_required'));
    // 日志要重新取一次：第二帧是在冷却窗口结束后才 flush 的（第一次读的时候只有 1 行）
    const parsedAll = warnings
      .filter((w) => w.includes('[ws.slow_consumer]'))
      .map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))) } catch { return null; } })
      .filter(Boolean);
    check('每条 resync_required 都对应一条 [ws.slow_consumer] 日志（可观测、不刷屏）',
      parsedAll.length === resyncAll.length
      && parsedAll.every((p) => Number(p.principalId) === aiId && Number(p.conversationId) === convId),
      `日志 ${parsedAll.length} 行 / resync ${resyncAll.length} 帧：${JSON.stringify(parsedAll.map((p) => ({ principalId: p.principalId, lastSeq: p.lastSeq, droppedFrames: p.droppedFrames })))}`);

    // ---- 补拉：真实 cookie + 真实消息，seq 必须和发送时一模一样
    const back = await api(`/api/conversations/${convId}/messages?since_seq=0&limit=200`, { cookie });
    const fetched = (back.json?.messages || []).map((m) => Number(m.seq));
    check('按 since_seq=0 补拉：seq 与发送时完全一致（连续、无重复、一条不少）',
      fetched.length === sentSeqs.length && fetched.every((v, i) => v === sentSeqs[i]),
      `补拉 ${fetched.length} 条：${fetched[0]}..${fetched.at(-1)}`);

    // ---- 公告帧（没有 seq）：丢帧时 lastSeq=0，客户端据此只重拉元数据、不当作消息空洞
    const annFramesBefore = resyncFrames(slow).length;
    await deliverAnnouncement(convId, { announcement: '背压公告（测试）', updatedAt: new Date().toISOString() });
    await waitFor(() => resyncFrames(slow).length >= annFramesBefore + 1);
    const annResync = resyncFrames(slow);
    check('公告帧（无 seq）丢帧 → resync_required.lastSeq=0（客户端只重拉元数据，不算消息空洞）',
      annResync.length === annFramesBefore + 1
      && Number(annResync.at(-1).lastSeq) === 0
      && Number(annResync.at(-1).conversationId) === convId,
      JSON.stringify(annResync.at(-1)));

    // ---- 移除假 socket：不能再有幽灵投递
    __testHooks.removeSocket(aiId, slow);
    __testHooks.removeSocket(aiId, healthy);
    attached = false;
    const beforeSlow = slow.sent.length;
    const beforeHealthy = healthy.sent.length;
    await deliverToConversation(convId, payload(sentSeqs.at(-1), 0));
    await sleep(300);
    check('移除 socket 后不再投递（removeSocket 生效，不留幽灵连接）',
      slow.sent.length === beforeSlow && healthy.sent.length === beforeHealthy,
      `slow +${slow.sent.length - beforeSlow} healthy +${healthy.sent.length - beforeHealthy}`);
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
    if (attached) {
      try { __testHooks.removeSocket(seeded.aiId, slow); } catch { /* ignore */ }
      try { __testHooks.removeSocket(seeded.aiId, healthy); } catch { /* ignore */ }
    }
    if (hooked) console.warn = origWarn;
    // 清理：删群 + 删 AI（临时账号留给 scripts/cleanup-test.mjs，events 还引用它）
    if (seeded) {
      try { await api(`/api/conversations/${seeded.convId}`, { method: 'DELETE', cookie: seeded.cookie }); } catch { /* ignore */ }
      try { await api(`/api/agents/${seeded.aiId}`, { method: 'DELETE', cookie: seeded.cookie }); } catch { /* ignore */ }
    }
    await closeDb().catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
    if (failed.length) {
      console.log('失败项：' + failed.map((f) => f.name).join('; '));
      process.exitCode = 1;
    }
  }
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exitCode = 1;
});
