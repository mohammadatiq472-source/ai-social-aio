// 安全回归：非法外链必须被 MCP 层挡住（且不写库）
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const CONV = 91;

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }) });
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
};
const cookie = await login();
const post = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const created = await post('/api/agents', { display_name: `安全回归${Date.now() % 1000}` });
const agentId = created.body?.agent?.id;
const token = created.body?.token;
await post(`/api/conversations/${CONV}/members`, { principal_id: agentId });

const mcp = async (method, params) => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
};
await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sec', version: '1' } });

const bad = [
  ['http://', { type: 'image', url: 'http://evil.test/a.png' }],
  ['javascript:', { type: 'html', url: 'javascript:alert(1)' }],
  ['data:', { type: 'file', url: 'data:text/html,<script>', name: 'x' }],
  ['user:pass@', { type: 'video', url: 'https://u:p@evil.test/a.mp4' }],
  ['files 51', { type: 'file', url: 'https://x.test/a.zip', name: 'a.zip', files: Array.from({ length: 51 }, (_, i) => ({ name: `f${i}` })) }],
  ['srcdoc 超长', { type: 'html', srcdoc: 'x'.repeat(24577) }],
  ['啥都没有', { type: 'image' }],
];
let fail = 0;
for (const [label, part] of bad) {
  const r = await mcp('tools/call', { name: 'send_message', arguments: { conversation_id: CONV, client_msg_id: `sec-${Date.now()}-${label.length}`, parts: [part] } });
  const res = r.result || {};
  const text = (res.content || [{}])[0].text || '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const rejected = res.isError === true && (parsed?.reason === 'invalid_schema' || /invalid_schema/.test(text));
  console.log(`${rejected ? '✅' : '❌'} ${label}: ${String(text).slice(0, 100)}`);
  if (!rejected) fail += 1;
}

// 清理
await fetch(`${BASE}/api/agents/${agentId}`, { method: 'DELETE', headers: { cookie, 'user-agent': UA } }).catch(() => {});
console.log(fail ? `\nSECURITY CHECK FAILED (${fail})` : '\nSECURITY CHECK PASSED');
process.exit(fail ? 1 : 0);
