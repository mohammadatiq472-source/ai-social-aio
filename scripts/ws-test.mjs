// WebSocket 实时链路验证：登录 → 连 WS → 另一个用户发消息 → 断言收到 event 帧
// 用法：node scripts/ws-test.mjs [base]
import WebSocket from 'ws';

const BASE = (process.argv[2] || process.env.QQMINI_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() || [res.headers.get('set-cookie')];
  const cookie = setCookie.map((c) => String(c).split(';')[0]).join('; ');
  return cookie;
}

const cookie = await login('demo@qqmini.dev', 'demo-qqmini-2026');
const convs = await (await fetch(`${BASE}/api/conversations`, { headers: { cookie } })).json();
const conv = convs[0];
if (!conv) throw new Error('no conversation');

const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws`;
const ws = new WebSocket(wsUrl, { headers: { cookie } });

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout: 未收到 hello 或 event')), 15000);
  let gotHello = false;
  ws.on('open', () => {});
  ws.on('message', async (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.t === 'hello') {
      gotHello = true;
      // 用另一个账号发一条，触发推送
      const buddyCookie = await login('buddy@qqmini.dev', 'demo-qqmini-2026');
      await fetch(`${BASE}/api/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: buddyCookie },
        body: JSON.stringify({ body: 'WS 推送测试', client_msg_id: crypto.randomUUID() }),
      });
    }
    if (frame.t === 'event') {
      clearTimeout(timer);
      resolve({ gotHello, frame });
    }
  });
  ws.on('error', (e) => { clearTimeout(timer); reject(e); });
});

console.log(JSON.stringify({ ok: true, hello: result.gotHello, event: result.frame }, null, 2));
ws.close();
