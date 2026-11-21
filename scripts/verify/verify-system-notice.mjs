// 验收：表情包分享 → 群系统消息（含幂等 + 另一个成员可见）
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CONV = Number(process.env.CONV || 91);

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
}

async function api(cookie, path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

const demo = await login('demo@qqmini.dev', 'demo-qqmini-2026');
const buddy = await login('buddy@qqmini.dev', 'demo-qqmini-2026');

const packs = await api(demo, '/api/sticker-packs');
const mine = (packs.body?.packs || []).filter((p) => p.mine && p.scope === 'private');
console.log('私有包数量:', mine.length, mine.map((p) => `${p.id}:${p.title}`).join(' '));
if (!mine.length) {
  console.log('没有私有包，先建一个');
  const created = await api(demo, '/api/sticker-packs', { method: 'POST', body: JSON.stringify({ title: '验收包', scope: 'private' }) });
  console.log('create ->', created.status, JSON.stringify(created.body).slice(0, 200));
  if (!created.body?.pack) process.exit(2);
  mine.push(created.body.pack);
}
const pack = mine[0];

const share1 = await api(demo, `/api/sticker-packs/${pack.id}/share`, { method: 'POST', body: JSON.stringify({ conversation_id: CONV }) });
console.log('share#1 ->', share1.status, JSON.stringify(share1.body).slice(0, 160));

const share2 = await api(demo, `/api/sticker-packs/${pack.id}/share`, { method: 'POST', body: JSON.stringify({ conversation_id: CONV }) });
console.log('share#2（幂等）->', share2.status, 'notice.seq=', share2.body?.notice?.seq, 'pack.scope=', share2.body?.pack?.scope);

const msgs = await api(demo, `/api/conversations/${CONV}/messages?since_seq=0&limit=200`);
const list = msgs.body?.messages || [];
const sys = list.filter((m) => m.kind === 'system');
console.log('消息总数:', list.length, '系统消息:', sys.length);
console.log('最后一条系统消息:', JSON.stringify(sys[sys.length - 1] || null));

const buddyMsgs = await api(buddy, `/api/conversations/${CONV}/messages?since_seq=0&limit=200`);
const buddySys = (buddyMsgs.body?.messages || []).filter((m) => m.kind === 'system');
console.log('buddy 看到的系统消息:', buddySys.length, JSON.stringify(buddySys[buddySys.length - 1] || null));

const ok =
  share1.status === 200 &&
  sys.length >= 1 &&
  /分享到本群/.test(sys[sys.length - 1]?.body || '') &&
  buddySys.length >= 1 &&
  // 幂等：第二条不应产生新的系统消息
  share2.body?.notice?.seq === sys[sys.length - 1]?.seq;
console.log(ok ? 'SYSTEM NOTICE PASS' : 'SYSTEM NOTICE FAIL');
process.exit(ok ? 0 : 1);
