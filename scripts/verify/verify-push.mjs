// 系统通知（Web Push）回归
//
// 覆盖的契约：
//   1. 未登录 → 401；服务器没配 VAPID → 503（这台配了，用 enabled 自检）
//   2. 订阅入库：GET /api/push/status 能看到设备（只回主机名，不回完整 endpoint）
//   3. 非法 endpoint（http://）/ 缺密钥 → 400，不会写库
//   4. 离线成员：别人发消息 → 真的尝试推送（attempts+1；假 endpoint 必然失败，lastError 非空）
//   5. 在线成员不推：同一账号挂着 WS 连接时不再推（避免看得到还弹通知）
//   6. 退订按设备生效：删掉一台，另一台照推
//   7. 自己发的不推
//   8. 冷却：同一会话 60 秒内第二条普通消息不推；被 @ 的立刻推（不受冷却限制）
//   9. 非成员不推（推送对象来自会话成员，不是所有订阅者）
//  10. 单账号最多 10 台设备
//
// 做法：用「合法但连不通」的 endpoint（https://127.0.0.1:9/…）——加密流程照常跑，
//      只有最后的 POST 失败；attempts/lastError 是服务端可观测的证据。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-push.mjs
// 前置：服务端配了 VAPID_*（否则第 2 步就会提示 push_disabled）。测试账号「推送A/B/C」由 cleanup-test.mjs 清理。
import crypto from 'node:crypto';
import WebSocket from 'ws';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

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

/** 造一对「格式合法」的订阅密钥：加密流程能跑，只有网络 POST 会失败 */
function fakeSubscription(n) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://127.0.0.1:9/push-${n}-${rnd()}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

async function subscribe(user, sub) {
  return api('/api/push/subscribe', { method: 'POST', cookie: user.cookie, body: sub });
}

async function status(user) {
  const r = await api('/api/push/status', { cookie: user.cookie });
  return r.json || { enabled: false, subscriptions: [] };
}

/** 等某个账号的推送被尝试过（attempts 涨到 atLeast） */
async function waitAttempts(user, atLeast, timeoutMs = 6000) {
  const started = Date.now();
  let last = await status(user);
  while (Date.now() - started < timeoutMs) {
    const max = Math.max(0, ...last.subscriptions.map((s) => s.attempts));
    if (max >= atLeast) return last;
    await new Promise((r) => setTimeout(r, 150));
    last = await status(user);
  }
  return last;
}

const maxAttempts = (st) => Math.max(0, ...(st.subscriptions || []).map((s) => s.attempts));

function connectWs(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws`, { headers: { cookie: user.cookie } });
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 8000);
    ws.on('message', (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame?.t === 'hello') {
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function post(user, conv, body, mentions) {
  const r = await api(`/api/conversations/${conv}/messages`, {
    method: 'POST',
    cookie: user.cookie,
    body: { body, client_msg_id: crypto.randomUUID(), ...(mentions ? { mentions } : {}) },
  });
  if (r.status !== 200) throw new Error(`发消息失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const main = async () => {
  const A = await signup('推送A');
  const B = await signup('推送B');
  const C = await signup('推送C');

  // 好友 + 群（A、B 在，C 不在）
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '推送验证群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;

  // 1) 鉴权与开关
  const anon = await api('/api/push/status');
  check('未登录查订阅 → 401', anon.status === 401, `status=${anon.status}`);
  const keyInfo = await api('/api/push/key');
  const cfg = await status(A);
  check('服务器已开启系统通知（VAPID 已配）', keyInfo.json?.enabled === true && cfg.enabled === true, `key_len=${keyInfo.json?.key?.length}`);

  // 3) 非法输入（先验，避免污染订阅表）
  const badScheme = await subscribe(A, { endpoint: 'http://insecure.example/1', keys: fakeSubscription(9).keys });
  check('http:// endpoint → 400', badScheme.status === 400 && badScheme.json?.error === 'invalid_endpoint', `status=${badScheme.status}`);
  const noKeys = await subscribe(A, { endpoint: 'https://127.0.0.1:9/x', keys: {} });
  check('缺 p256dh/auth → 400', noKeys.status === 400 && noKeys.json?.error === 'invalid_keys', `status=${noKeys.status}`);

  // 2) 订阅入库
  const sub1 = fakeSubscription(1);
  const sub2 = fakeSubscription(2);
  const s1 = await subscribe(A, sub1);
  const s2 = await subscribe(A, sub2);
  const afterSub = await status(A);
  check(
    '订阅入库：两台设备，attempts=0，只回主机名',
    s1.status === 200 && s2.status === 200 && afterSub.subscriptions.length === 2 && afterSub.subscriptions.every((s) => s.attempts === 0 && s.host === '127.0.0.1:9'),
    JSON.stringify(afterSub.subscriptions.map((s) => ({ host: s.host, attempts: s.attempts }))),
  );
  const resub = await subscribe(A, sub1);
  const afterResub = await status(A);
  check('同一 endpoint 重复订阅不新增行（不会推两遍）', resub.status === 200 && afterResub.subscriptions.length === 2, `n=${afterResub.subscriptions.length}`);

  // 4) 离线成员 → 真的尝试推送
  await post(B, gid, `离线推送测试 ${rnd()}`);
  let st = await waitAttempts(A, 2);
  check(
    '离线成员：两台设备都尝试推送（attempts 各 +1）',
    st.subscriptions.length === 2 && st.subscriptions.every((s) => s.attempts >= 1),
    JSON.stringify(st.subscriptions.map((s) => s.attempts)),
  );
  check(
    '假 endpoint 推送失败被记录（lastError 非空、lastPushAt 为空）',
    st.subscriptions.every((s) => s.lastError && !s.lastPushAt),
    st.subscriptions[0]?.lastError || '',
  );

  // 5) 在线成员不推
  const wsA = await connectWs(A);
  const before = maxAttempts(st);
  await post(B, gid, `在线也该收 WS，不用系统通知 ${rnd()}`, [A.id]);
  await new Promise((r) => setTimeout(r, 1200));
  const stOnline = await status(A);
  check('在线成员不推系统通知（@ 了也不推）', maxAttempts(stOnline) === before, `before=${before} after=${maxAttempts(stOnline)}`);

  // 8-b) 被 @ 的离线成员立即推（绕过冷却）
  wsA.close();
  await new Promise((r) => setTimeout(r, 500));
  await post(B, gid, `@你一下 ${rnd()}`, [A.id]);
  const stMentioned = await waitAttempts(A, before + 1);
  check('离线被 @：绕过 60 秒冷却，立刻推', maxAttempts(stMentioned) >= before + 1, `attempts=${maxAttempts(stMentioned)} before=${before}`);

  // 8-a) 冷却：紧接着的普通消息不再推
  const afterMention = maxAttempts(stMentioned);
  await post(B, gid, `普通消息，应该被冷却挡掉 ${rnd()}`);
  await new Promise((r) => setTimeout(r, 1200));
  const stCool = await status(A);
  check('冷却生效：同会话 60 秒内普通消息不重复推', maxAttempts(stCool) === afterMention, `before=${afterMention} after=${maxAttempts(stCool)}`);
  // 7) 自己发的不推
  await post(A, gid, `我自己发的 ${rnd()}`, [A.id]);
  await new Promise((r) => setTimeout(r, 1200));
  const stSelf = await status(A);
  check('自己发的消息不推给自己', maxAttempts(stSelf) === afterMention, `attempts=${maxAttempts(stSelf)}`);

  // 6) 退订按设备生效
  const un1 = await api('/api/push/unsubscribe', { method: 'POST', cookie: A.cookie, body: { endpoint: sub1.endpoint } });
  const afterUnsub = await status(A);
  check('退订一台设备：订阅数 2 → 1', un1.status === 200 && afterUnsub.subscriptions.length === 1, `n=${afterUnsub.subscriptions.length}`);
  const before2 = maxAttempts(afterUnsub);
  const t = rnd();
  await post(B, gid, `退订后另一台还该收到 ${t}`, [A.id]);
  const stAfter = await waitAttempts(A, before2 + 1);
  check('退订只影响那台设备，另一台照推', maxAttempts(stAfter) === before2 + 1, `attempts=${maxAttempts(stAfter)}`);

  // 9) 非成员不推
  const subC = fakeSubscription(3);
  await subscribe(C, subC);
  const stC1 = await status(C);
  await post(B, gid, `C 不在这个群，不该收到 ${rnd()}`, [C.id]);
  await new Promise((r) => setTimeout(r, 1200));
  const stC2 = await status(C);
  check('非成员订阅者收不到该会话的推送', maxAttempts(stC1) === 0 && maxAttempts(stC2) === 0, `attempts=${maxAttempts(stC2)}`);

  // 10) 设备上限
  for (let i = 0; i < 9; i += 1) await subscribe(C, fakeSubscription(10 + i));
  const overflow = await subscribe(C, fakeSubscription(99));
  const stC3 = await status(C);
  check(
    '单账号最多 10 台设备（第 11 台被拒）',
    overflow.status === 400 && overflow.json?.error === 'too_many_devices' && stC3.subscriptions.length === 10,
    `status=${overflow.status} n=${stC3.subscriptions.length}`,
  );

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
