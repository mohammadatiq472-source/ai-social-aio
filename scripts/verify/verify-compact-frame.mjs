// 验证：大帧（srcdoc 20KB）会被降级成紧凑帧，且 REST 仍能拿到完整内容
import WebSocket from 'ws';

const BASE = process.env.BASE || 'https://chat.example.com';
const CONV = Number(process.env.CONV || 91);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const problems = [];

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }),
  });
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
};
const cookie = await login();

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', { headers: { cookie, 'user-agent': UA } });
const frames = [];
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('hello timeout')), 15000);
  ws.on('message', (m) => {
    const text = String(m);
    frames.push(text);
    if (text.includes('"hello"')) { clearTimeout(t); resolve(); }
  });
  ws.on('error', (e) => { clearTimeout(t); reject(e); });
});

// 发一条带 20KB srcdoc 的 HTML 消息（会超过 8KB 阈值）
const srcdoc = `<html><body><h1>big</h1>${'<p>padding</p>'.repeat(900)}</body></html>`;
const send = await fetch(`${BASE}/api/conversations/${CONV}/messages`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json', 'user-agent': UA },
  body: JSON.stringify({ client_msg_id: `compact-${Date.now()}`, parts: [{ type: 'html', srcdoc, title: '大页面' }] }),
});
const sent = await send.json();
console.log('发送:', send.status, sent.accepted, 'seq=', sent.seq);

const got = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 8000);
  const iv = setInterval(() => {
    const f = frames.find((x) => x.includes('"compact"') || (x.includes('"seq"') && x.includes(String(sent.seq))));
    if (f) { clearInterval(iv); clearTimeout(t); resolve(f); }
  }, 100);
});
if (!got) problems.push('没收到这条消息的 WS 帧');
else {
  const obj = JSON.parse(got);
  console.log('帧大小:', got.length, 'compact=', obj.compact, 'parts=', (obj.parts || []).length, 'body=', JSON.stringify(obj.body).slice(0, 40));
  if (obj.compact !== true) problems.push('20KB 的 srcdoc 没有被降级成紧凑帧');
  if (got.length > 2000) problems.push(`紧凑帧仍然很大：${got.length}B`);
  if (JSON.stringify(got).includes('padding')) problems.push('紧凑帧里仍然带了 srcdoc 正文');
}

// REST 必须还能拿到完整 srcdoc（客户端回补用）
const rest = await fetch(`${BASE}/api/conversations/${CONV}/messages?since_seq=${sent.seq - 1}&limit=2`, { headers: { cookie, 'user-agent': UA } });
const restBody = await rest.json();
const msg = (restBody.messages || []).find((m) => m.seq === sent.seq);
const part = (msg?.parts || [])[0];
console.log('REST 回补:', { found: Boolean(msg), type: part?.type, srcdocLen: (part?.srcdoc || '').length });
if (!msg) problems.push('REST 回补拿不到这条消息');
else if ((part?.srcdoc || '').length < 10000) problems.push('REST 里 srcdoc 被截断了');

ws.close();
console.log(JSON.stringify({ problems }, null, 2));
console.log(problems.length ? 'COMPACT FRAME FAILED' : 'COMPACT FRAME PASSED');
process.exit(problems.length ? 1 : 0);
