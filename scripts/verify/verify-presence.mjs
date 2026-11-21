// 在线状态 + 正在输入（WS 协议层回归）
//
// 覆盖的契约：
//   1. 上线广播：B 连上 WS → 和 B 有共同会话的 A 收到 {t:'presence',principalId,online:true}
//   2. 多标签页不闪：B 的第二个连接不该再广播一次 online
//   3. 下线才广播：关掉第二个连接不广播；关掉最后一个才广播 offline
//   4. typing 转发：B 发 {t:'typing',conversationId} → 同会话的 A 收到（带 name）
//   5. 非成员不能刷屏：C 不在群里，发 typing 没人收到；C 上线/下线也不广播给 A（没有共同会话）
//   6. 限频：10 秒内同一人同一群最多转发 5 条 typing
//   7. 不认识的帧不会让连接崩掉（发垃圾 JSON 后还能收到后续帧）
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-presence.mjs
// 测试账号「在线A/B/C」由 cleanup-test.mjs 清理。
import crypto from 'node:crypto';
import WebSocket from 'ws';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, cookie: sid || cookie };
}

async function signup(name) {
  const email = `t_${rnd()}@test.dev`;
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'passw0rd!x', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

/** 连一条 WS，收集帧，支持「等某一类帧」 */
function connectWs(user) {
  const frames = [];
  const waiters = [];
  const ws = new WebSocket(WS_URL, { headers: { cookie: user.cookie } });
  ws.on('message', (raw) => {
    let frame = null;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.pred(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  const api_ = {
    ws,
    frames,
    waitFor(pred, timeoutMs = 3000, label = 'frame') {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.pred === pred);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push({
          pred,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
        void label;
      });
    },
    close: () => ws.close(),
    send: (frame) => ws.send(JSON.stringify(frame)),
  };
  return api_;
}

const isPresence = (principalId, online) => (f) => f.t === 'presence' && f.principalId === principalId && f.online === online;
const isTypingFrom = (principalId) => (f) => f.t === 'typing' && f.principalId === principalId;

const main = async () => {
  const A = await signup('在线A');
  const B = await signup('在线B');
  const C = await signup('在线C');
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '在线验证群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;
  check('准备：群建好（A、B 在，C 不在）', Boolean(gid), `gid=${gid}`);

  // A 先上线（这样才收得到 B 的 presence）
  const a1 = connectWs(A);
  const helloA = await a1.waitFor((f) => f.t === 'hello', 4000);
  check('WS 握手：收到 hello', Boolean(helloA), helloA ? `id=${helloA.me?.id}` : 'timeout');

  // 1) B 上线 → A 看到 online
  const b1 = connectWs(B);
  await b1.waitFor((f) => f.t === 'hello', 4000);
  const presenceOn = await a1.waitFor(isPresence(B.id, true), 4000);
  check('B 上线：同群的 A 收到在线广播', Boolean(presenceOn), JSON.stringify(presenceOn || {}));

  // 2) 第二个连接不重复广播
  const beforeDup = a1.frames.filter(isPresence(B.id, true)).length;
  const b2 = connectWs(B);
  await b2.waitFor((f) => f.t === 'hello', 4000);
  await sleep(600);
  const afterDup = a1.frames.filter(isPresence(B.id, true)).length;
  check('多标签页：第二个连接不再广播 online', afterDup === beforeDup, `${beforeDup} → ${afterDup}`);

  // 3) 关掉第二个连接不广播 offline
  b2.close();
  await sleep(600);
  const offlineAfterSecond = a1.frames.filter(isPresence(B.id, false)).length;
  check('关掉多余连接：不广播 offline（还有别的连接在）', offlineAfterSecond === 0, `offline 帧=${offlineAfterSecond}`);

  // 4) typing 转发
  b1.send({ t: 'typing', conversationId: gid });
  const typing = await a1.waitFor(isTypingFrom(B.id), 3000);
  check(
    'typing：同群的 A 收到（带 conversationId 与昵称）',
    Boolean(typing) && typing.conversationId === gid && typing.name === '在线B',
    JSON.stringify(typing || {}),
  );

  // 6) 限频：10 秒内同一人同一群最多 5 条（刚才已用 1 条）
  const typingBefore = a1.frames.filter(isTypingFrom(B.id)).length;
  for (let i = 0; i < 8; i += 1) {
    b1.send({ t: 'typing', conversationId: gid });
    await sleep(40);
  }
  await sleep(700);
  const typingAfter = a1.frames.filter(isTypingFrom(B.id)).length;
  check('限频：10 秒内最多转发 5 条 typing', typingAfter - typingBefore <= 4, `新增 ${typingAfter - typingBefore} 条（已用 1，上限 5）`);

  // 5) 非成员 C：typing 没人收到；C 上下线也不广播给 A
  const c1 = connectWs(C);
  await c1.waitFor((f) => f.t === 'hello', 4000);
  await sleep(500);
  const presenceC = a1.frames.filter(isPresence(C.id, true)).length;
  check('非成员 C 上线：A 收不到（没有共同会话）', presenceC === 0, `presence 帧=${presenceC}`);
  const typingCBefore = a1.frames.filter(isTypingFrom(C.id)).length;
  c1.send({ t: 'typing', conversationId: gid });
  await sleep(700);
  const typingCAfter = a1.frames.filter(isTypingFrom(C.id)).length;
  check('非成员 C 发 typing：不转发', typingCAfter === typingCBefore, `${typingCBefore} → ${typingCAfter}`);
  c1.close();

  // 7) 垃圾帧不影响连接
  b1.ws.send('not-json{{{');
  b1.send({ t: 'typing', conversationId: gid });
  const afterGarbage = await a1.waitFor(isTypingFrom(B.id), 2500);
  check('垃圾 JSON 之后连接仍然可用', Boolean(afterGarbage));

  // 3b) 关掉最后一个连接 → 广播 offline
  b1.close();
  const presenceOff = await a1.waitFor(isPresence(B.id, false), 4000);
  check('B 下线（最后一个连接）：A 收到离线广播', Boolean(presenceOff), JSON.stringify(presenceOff || {}));

  a1.close();
  await sleep(200);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exitCode = 1;
});
