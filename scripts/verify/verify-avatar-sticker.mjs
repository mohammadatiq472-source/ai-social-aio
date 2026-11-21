// 后端 E2E：图片头像（人类附件 / Agent 外链）+ Agent 自建表情包 + 外链 untrusted 标记
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CONV = 91;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const problems = [];
const out = {};

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }),
  });
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
};
const cookie = await login();
const api = async (p, init = {}) => {
  const headers = { cookie, 'user-agent': UA, ...(init.headers || {}) };
  const r = await fetch(`${BASE}${p}`, { ...init, headers });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
};

// 1) 人类：上传 → 绑头像
const up = await fetch(`${BASE}/api/attachments`, {
  method: 'POST',
  headers: { cookie, 'user-agent': UA, 'content-type': 'image/png', 'x-width': '512', 'x-height': '512' },
  body: PNG,
});
const upBody = await up.json();
out.upload = { status: up.status, id: upBody?.attachment?.id };
if (!upBody?.attachment?.id) problems.push('上传头像附件失败');
const bind = await api('/api/me/avatar', { method: 'POST', body: JSON.stringify({ attachment_id: upBody.attachment.id, width: 512, height: 512 }), headers: { 'content-type': 'application/json' } });
out.bindAvatar = { status: bind.status, avatarUrl: bind.body?.me?.avatarUrl };
if (!String(bind.body?.me?.avatarUrl || '').startsWith('/media/')) problems.push('人类头像没绑上');

const me = await api('/api/me');
out.me = { avatarUrl: me.body?.avatarUrl };
if (!String(me.body?.avatarUrl || '').startsWith('/media/')) problems.push('/api/me 没带 avatarUrl');

// 2) Agent：外链头像 + 自建表情包
const created = await api('/api/agents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ display_name: `头像包AI${Date.now() % 1000}`, persona: '验收' }),
});
const token = created.body?.token;
const agentId = created.body?.agent?.id;
await api(`/api/conversations/${CONV}/members`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ principal_id: agentId }) });
await api(`/api/conversations/${CONV}/reply-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ principal_id: agentId, reply_mode: 'high' }) });
out.agentId = agentId;

const mcp = async (method, params) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
};
const call = async (name, args) => {
  const r = await mcp('tools/call', { name, arguments: args });
  const text = (r.result?.content || [{}])[0]?.text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { isError: r.result?.isError, data: parsed };
};
await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });

const AVATAR = 'https://interactive-examples.mdn.mozilla.net/media/cc0-images/grapefruit-slice-332-332.jpg';
const setAv = await call('set_avatar', { url: AVATAR });
out.setAvatar = setAv;
if (!setAv.data?.accepted) problems.push('Agent 设头像失败');

const pack = await call('create_sticker_pack', { title: `猫猫${Date.now() % 100}` });
out.pack = pack.data;
if (!pack.data?.accepted) problems.push('Agent 建表情包失败');

const item = await call('add_sticker_item', {
  pack_id: pack.data?.pack_id,
  url: AVATAR,
  caption: '猫猫比心',
  tags: ['猫', '爱心'],
  emotion: '开心',
  key: 'cat1',
});
out.item = item;
if (!item.data?.accepted) problems.push('Agent 加表情失败');

const sendSticker = await call('send_message', {
  conversation_id: CONV,
  client_msg_id: `sticker-e2e-${Date.now()}`,
  parts: [{ type: 'sticker', pack: pack.data?.slug, key: item.data?.key || 'cat1' }],
});
out.sendSticker = sendSticker.data;
if (!sendSticker.data?.accepted) problems.push(`Agent 发表情失败：${JSON.stringify(sendSticker.data)}`);

// 等冷却，再发一条外链图片，测 untrusted
await new Promise((r) => setTimeout(r, 16000));
const sendImg = await call('send_message', {
  conversation_id: CONV,
  client_msg_id: `img-e2e-${Date.now()}`,
  parts: [{ type: 'image', url: AVATAR, width: 332, height: 332 }],
});
out.sendImg = sendImg.data;

// 3) 校验：人类能看到 Agent 的包；消息里带 Agent 头像；whats_new 有 untrusted
const packs = await api('/api/sticker-packs');
const agentPack = (packs.body?.packs || []).find((p) => p.slug === pack.data?.slug);
out.visiblePack = agentPack ? { slug: agentPack.slug, items: agentPack.itemCount, url: agentPack.items?.[0]?.url } : null;
if (!agentPack) problems.push('人类看不到 Agent 的表情包（可见性没修好）');
else if (agentPack.itemCount < 1) problems.push('Agent 的表情包里没有图');

const msgs = await api(`/api/conversations/${CONV}/messages?since_seq=0&limit=200`);
const mine = (msgs.body?.messages || []).filter((m) => m.senderId === agentId);
const withAvatar = mine.filter((m) => m.avatarUrl === AVATAR);
out.messages = { fromAgent: mine.length, withAvatar: withAvatar.length, sample: mine[mine.length - 1] };
if (withAvatar.length < 1) problems.push('消息里没有带 Agent 的头像地址');

const wn = await call('whats_new', { since_seq: 0, detail: true, limit: 50 });
const events = wn.data?.events || [];
const ext = events.filter((e) => (e.parts || []).some((p) => p.type === 'image' && /^https:/.test(p.url || '')));
out.untrusted = { events: events.length, external: ext.length, flags: ext.slice(-2).map((e) => e.untrusted) };
if (!ext.length) problems.push('whats_new 里没找到外链消息');
else if (!ext.every((e) => e.untrusted === true)) problems.push('外链消息没有 untrusted:true');

console.log(JSON.stringify({ out, problems }, null, 2));
console.log(problems.length ? '\nAVATAR/STICKER E2E FAILED' : '\nAVATAR/STICKER E2E PASSED');
process.exit(problems.length ? 1 : 0);
