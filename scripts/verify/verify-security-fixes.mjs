// 安全/性能回归：本轮修复项的回归验证（在服务器上以 localhost 跑）
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const CONV = 91;
const problems = [];
const out = {};

async function login(email, password = 'demo-qqmini-2026') {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body, cookie: (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ') };
}
async function api(cookie, p, init = {}) {
  const headers = { 'user-agent': UA, ...(cookie ? { cookie } : {}), ...(init.headers || {}) };
  const r = await fetch(`${BASE}${p}`, { ...init, headers });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}

const demo = await login('demo@qqmini.dev');
const buddy = await login('buddy@qqmini.dev');
if (demo.status !== 200 || buddy.status !== 200) {
  console.log('LOGIN FAILED', demo.status, buddy.status, demo.body, buddy.body);
  process.exit(2);
}

// ① 附件枚举：buddy 拿 demo 的附件 id，应该一条都拿不到
const att = await api(buddy.cookie, '/api/attachments?ids=1,2,3,4,12,13');
out.attachmentsForBuddy = Array.isArray(att.body) ? att.body.length : att.body;
if (Array.isArray(att.body) && att.body.length) problems.push(`别人仍能枚举附件：${att.body.length} 条`);

// ② 私包不可被别人的 Agent 搜到
const created = await api(demo.cookie, '/api/sticker-packs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: `回归私包${Date.now() % 1000}` }),
});
const packId = created.body?.pack?.id;
const slug = created.body?.pack?.slug;
if (!packId) problems.push('建私包失败');
// 加一张图（用 demo 已有附件 12）
const addItem = await api(demo.cookie, `/api/sticker-packs/${packId}/items`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ attachment_id: 12, caption: `regression-secret-${packId}`, key: 'secret1', tags: ['regression'] }),
});
out.addItem = { status: addItem.status, error: addItem.body?.error };
if (addItem.status !== 200) problems.push(`加图失败：${JSON.stringify(addItem.body).slice(0, 120)}`);

// 用 buddy 的 Agent 搜（建一个新 agent，避免改动别人）
const agentCreated = await api(buddy.cookie, '/api/agents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ display_name: `回归Agent${Date.now() % 1000}` }),
});
const token = agentCreated.body?.token;
async function mcp(method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
}
await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reg', version: '1' } });
const search = await mcp('tools/call', { name: 'search_stickers', arguments: { query: `regression-secret-${packId}` } });
const searchText = search.result?.content?.[0]?.text || '';
let searchJson = null;
try { searchJson = JSON.parse(searchText); } catch { searchJson = null; }
const hits = Array.isArray(searchJson?.stickers) ? searchJson.stickers : [];
out.searchHits = hits;
if (hits.length) problems.push(`别人的 Agent 仍能搜到 demo 的私包：${JSON.stringify(hits).slice(0, 120)}`);

// ③ create_group 不能拉陌生人
const strangerId = await (async () => {
  const r = await api(demo.cookie, '/api/directory?q=10000999');
  return null;
})();
// 用一个与 buddy 无好友关系的 principal（demo 的 AI 属于 demo，不是 buddy 的好友）
const demoAgents = await api(demo.cookie, '/api/agents');
const list = Array.isArray(demoAgents.body) ? demoAgents.body : (demoAgents.body?.agents || []);
const foreignAgentId = list[0]?.id;
out.foreignAgentId = foreignAgentId;
if (!foreignAgentId) problems.push('没拿到 demo 的 AI id，陌生人测试无效');
const group = await api(buddy.cookie, '/api/conversations', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: `回归陌生人${Date.now() % 1000}`, member_ids: [foreignAgentId] }),
});
out.createGroupStranger = { status: group.status, error: group.body?.error, message: group.body?.message };
if (group.status === 200) {
  problems.push('create_group 仍能把非好友/别人的 AI 拉进群');
  const gid = group.body?.conversation?.id || group.body?.conversation_id;
  if (gid) out.emptyGroupToClean = gid;
}

// ④ /media：Range / ETag / 缓存
const convs = await api(demo.cookie, '/api/conversations');
const firstConv = convs.body?.[0]?.id || CONV;
const msgs = await api(demo.cookie, `/api/conversations/${firstConv}/messages?since_seq=0&limit=50`);
const parts = (msgs.body?.messages || []).flatMap((m) => m.parts || []);
const media = parts.find((p) => typeof p.url === 'string' && p.url.startsWith('/media/'));
if (media) {
  const full = await fetch(`${BASE}${media.url}`, { headers: { 'user-agent': UA } });
  const etag = full.headers.get('etag');
  const acceptRanges = full.headers.get('accept-ranges');
  const rangeRes = await fetch(`${BASE}${media.url}`, { headers: { 'user-agent': UA, range: 'bytes=0-15' } });
  const cond = await fetch(`${BASE}${media.url}`, { headers: { 'user-agent': UA, 'if-none-match': etag || '' } });
  out.media = {
    status: full.status,
    etag: Boolean(etag),
    acceptRanges,
    cacheControl: full.headers.get('cache-control'),
    rangeStatus: rangeRes.status,
    contentRange: rangeRes.headers.get('content-range'),
    notModified: cond.status,
  };
  if (rangeRes.status !== 206) problems.push(`Range 未生效：${rangeRes.status}`);
  if (!etag) problems.push('缺少 ETag');
  if (cond.status !== 304) problems.push(`If-None-Match 未返回 304：${cond.status}`);
} else {
  problems.push('没找到可测的 /media 链接');
}

// ⑤ /healthz 公网口不应泄露备份细节（本机请求会是 loopback，测"非本机"用伪造头不行，这里只记录）
const hz = await api(null, '/healthz');
out.healthzLocal = hz.body;

// ⑥ 参数脏值不再 500
const dirty = await api(demo.cookie, '/api/conversations/99999999999999999999/messages?limit=-1');
out.dirtyParams = { status: dirty.status, body: dirty.body };
if (dirty.status >= 500) problems.push(`脏参数仍 500：${JSON.stringify(dirty.body).slice(0, 100)}`);

// ⑦ 邀请码：无码注册被拒
const noCode = await api(null, '/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `noreg-${Date.now()}@example.com`, password: 'regression-pass-1', display_name: '无码' }),
});
out.registerWithoutCode = { status: noCode.status, error: noCode.body?.error };
if (noCode.status !== 403) problems.push('无邀请码仍可注册');

// 清理：删 Agent、删私包
if (agentCreated.body?.agent?.id) {
  await api(buddy.cookie, `/api/agents/${agentCreated.body.agent.id}`, { method: 'DELETE' });
}
if (packId) await api(demo.cookie, `/api/sticker-packs/${packId}`, { method: 'DELETE' });

console.log(JSON.stringify({ out, problems }, null, 2));
console.log(problems.length ? '\nSECURITY/PERF REGRESSION FAILED' : '\nSECURITY/PERF REGRESSION PASSED');
process.exit(problems.length ? 1 : 0);
