// 表情包可见性 + mine 归属回归：私包不泄露、群包对成员可见但非主人 mine=false
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const CONV = 91;

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email, password: 'demo-qqmini-2026' }),
  });
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
}
async function api(cookie, p, init = {}) {
  const headers = { cookie, 'user-agent': UA, ...(init.headers || {}) };
  const r = await fetch(`${BASE}${p}`, { ...init, headers });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

const demo = await login('demo@qqmini.dev');
const buddy = await login('buddy@qqmini.dev');
const problems = [];

// 1) demo 建一个私包，不分享
const created = await api(demo, '/api/sticker-packs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: `私密回归${Date.now() % 1000}` }),
});
const packId = created.body?.pack?.id;
const slug = created.body?.pack?.slug;
console.log('创建私包:', packId, slug, 'mine=', created.body?.pack?.mine);
if (created.body?.pack?.mine !== true) problems.push('自己建的包 mine 不为 true');

const demoList = await api(demo, '/api/sticker-packs');
const buddyList = await api(buddy, '/api/sticker-packs');
const demoHas = (demoList.body?.packs || []).some((p) => p.id === packId);
const buddyHas = (buddyList.body?.packs || []).some((p) => p.id === packId);
console.log('私包可见性: demo=', demoHas, 'buddy=', buddyHas);
if (!demoHas) problems.push('自己看不到自己的私包');
if (buddyHas) problems.push('别人的私包泄露给 buddy');

// 2) 分享到群：buddy 应该能看见，但 mine 必须是 false
const share = await api(demo, `/api/sticker-packs/${packId}/share`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ conversation_id: CONV }),
});
console.log('分享:', share.status, 'notice.seq=', share.body?.notice?.seq);
const buddyList2 = await api(buddy, '/api/sticker-packs');
const groupPackForBuddy = (buddyList2.body?.packs || []).find((p) => p.id === packId);
console.log('群包在 buddy 眼里:', groupPackForBuddy ? { mine: groupPackForBuddy.mine, scope: groupPackForBuddy.scope } : null);
if (!groupPackForBuddy) problems.push('群成员看不到分享到群的包');
else if (groupPackForBuddy.mine === true) problems.push('群包在非主人眼里 mine=true（能点编辑/删除）');

const demoList2 = await api(demo, '/api/sticker-packs');
const mineForDemo = (demoList2.body?.packs || []).find((p) => p.id === packId);
console.log('群包在 demo 眼里 mine=', mineForDemo?.mine);
if (mineForDemo?.mine !== true) problems.push('主人自己的群包 mine 不为 true');

// 3) 清理：删包（会级联删 items）
const del = await api(demo, `/api/sticker-packs/${packId}`, { method: 'DELETE' });
console.log('清理:', del.status);

console.log(JSON.stringify({ problems }, null, 2));
console.log(problems.length ? '\nPACK VISIBILITY FAILED' : '\nPACK VISIBILITY PASSED');
process.exit(problems.length ? 1 : 0);
