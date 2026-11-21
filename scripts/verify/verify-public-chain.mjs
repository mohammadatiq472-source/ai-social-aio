// 公网全链路验证（走 CF → 隧道 → nginx:80）：登录 / 消息 / MCP / WS / 上传 / Range / 限流
import WebSocket from 'ws';

const BASE = process.env.BASE || 'https://chat.example.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const problems = [];
const out = {};

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }),
  });
  const body = await r.json().catch(() => null);
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
  out.login = { status: r.status, hasCookie: Boolean(cookie) };
  return { status: r.status, cookie, body };
};
const api = async (cookie, p, init = {}) => {
  const headers = { 'user-agent': UA, ...(cookie ? { cookie } : {}), ...(init.headers || {}) };
  const r = await fetch(`${BASE}${p}`, { ...init, headers });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};

const demo = await login();
if (demo.status !== 200) {
  console.log('LOGIN FAILED', out.login);
  process.exit(2);
}

const convs = await api(demo.cookie, '/api/conversations');
out.conversations = { status: convs.status, count: Array.isArray(convs.body) ? convs.body.length : null };
if (convs.status !== 200) problems.push(`会话列表 ${convs.status}`);

const convId = Array.isArray(convs.body) ? convs.body[0]?.id : null;
const msgs = await api(demo.cookie, `/api/conversations/${convId}/messages?since_seq=0&limit=50`);
out.messages = { status: msgs.status, count: (msgs.body?.messages || []).length };
if (msgs.status !== 200) problems.push(`消息列表 ${msgs.status}`);

// /media Range
const parts = (msgs.body?.messages || []).flatMap((m) => m.parts || []);
const media = parts.find((p) => typeof p.url === 'string' && p.url.startsWith('/media/'));
if (media) {
  const full = await fetch(`${BASE}${media.url}`, { headers: { 'user-agent': UA } });
  const range = await fetch(`${BASE}${media.url}`, { headers: { 'user-agent': UA, range: 'bytes=0-15' } });
  out.media = { status: full.status, etag: full.headers.get('etag'), range: range.status, contentRange: range.headers.get('content-range') };
  if (range.status !== 206) problems.push(`/media Range 未生效：${range.status}`);
} else {
  problems.push('没有可测的 media');
}

// 上传（100KB PNG）走 nginx 45m body 限制
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(100 * 1024 - 8, 0),
]);
const up = await fetch(`${BASE}/api/attachments`, {
  method: 'POST',
  headers: { cookie: demo.cookie, 'user-agent': UA, 'content-type': 'image/png' },
  body: png,
});
const upBody = await up.json().catch(() => null);
out.upload = { status: up.status, bytes: upBody?.attachment?.bytes, id: upBody?.attachment?.id };
if (up.status !== 200) problems.push(`上传失败 ${up.status} ${JSON.stringify(upBody).slice(0, 100)}`);

// WS：hello 帧
async function wsCheck(cookie) {
  const url = BASE.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(url, { headers: { cookie, 'user-agent': UA } });
  const res = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 15000);
    ws.on('message', (m) => {
      clearTimeout(t);
      resolve({ ok: true, frame: String(m).slice(0, 80) });
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, reason: e.message });
    });
  });
  try { ws.close(); } catch { /* ignore */ }
  return res;
}
out.ws = await wsCheck(demo.cookie);
if (!out.ws.ok) problems.push(`WS 失败：${JSON.stringify(out.ws)}`);

// MCP：建 Agent → initialize → tools/list（经 nginx）
const ag = await api(demo.cookie, '/api/agents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ display_name: `公网验收${Date.now() % 1000}` }),
});
const token = ag.body?.token;
if (!token) problems.push('建 Agent 失败');
else {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pub', version: '1' } } }),
  });
  const j = await r.json().catch(() => null);
  out.mcp = { status: r.status, serverInfo: j?.result?.serverInfo };
  if (!j?.result?.serverInfo) problems.push(`MCP initialize 失败 ${r.status}`);
  // 清理 agent
  await api(demo.cookie, `/api/agents/${ag.body.agent.id}`, { method: 'DELETE' }).catch(() => {});
}

// 限流：/api/ 20r/s burst 40 → 并发 120 个请求应出现 429
const burst = await Promise.all(Array.from({ length: 120 }, (_, i) => fetch(`${BASE}/api/conversations?probe=${i}`, { headers: { cookie: demo.cookie, 'user-agent': UA } }).then((r) => r.status).catch(() => 0)));
const counts = burst.reduce((m, s) => ((m[s] = (m[s] || 0) + 1), m), {});
out.rateLimit = counts;
if (!counts[429]) problems.push('并发 120 次 /api/ 没有出现 429（限流没生效）');

console.log(JSON.stringify({ out, problems }, null, 2));
console.log(problems.length ? '\nPUBLIC CHAIN FAILED' : '\nPUBLIC CHAIN PASSED');
process.exit(problems.length ? 1 : 0);
