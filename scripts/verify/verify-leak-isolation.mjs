// 读路径一致性回归：已撤回 / 被站务隐藏的消息，不能从任何一条读路径漏出去。
//
// 外部评审 P2-1（成员主页「最近发言」不看 recalled_at）与 P2-4/M2（MCP whats_new 把
// 已撤回消息正文交给 AI）指出了同一类问题的两个实例。这个脚本把「一条消息能从哪些地方出去」
// 都过一遍，避免下次只在其中一个地方打补丁：
//   拉消息 /api/conversations/:id/messages
//   搜索  /api/search/messages
//   会话列表预览 /api/conversations
//   成员主页「最近发言」 /api/principals/:id/profile
//   MCP  whats_new（摘要 + 明细两条路径）
//
// 隐藏（审核下架）用例需要站务账号：给了 ADMIN_EMAIL/ADMIN_PASSWORD 才跑，否则 SKIP。
//
// 用法：
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-leak-isolation.mjs
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… BASE=… node scripts/verify/verify-leak-isolation.mjs
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
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
  return { status: res.status, json, text, cookie: sid || cookie };
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

async function mcp(token, name, args, id = 1) {
  const r = await api('/mcp', {
    method: 'POST',
    token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const payload = r.json?.result?.content?.[0]?.text;
  return payload ? JSON.parse(payload) : { httpError: r.status, body: r.json };
}

async function send(user, conv, body) {
  const r = await api(`/api/conversations/${conv}/messages`, {
    method: 'POST', cookie: user.cookie, body: { body, client_msg_id: crypto.randomUUID() },
  });
  if (r.status !== 200) throw new Error(`发消息失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** 一条消息可能出现的所有读路径，返回 {path: 是否出现} */
async function sightings(actor, conv, needle, agentToken, agentId, profileOf = null) {
  const out = {};
  const msgs = await api(`/api/conversations/${conv}/messages?since_seq=0&limit=200`, { cookie: actor.cookie });
  out.messages = JSON.stringify(msgs.json?.messages || []).includes(needle) || (msgs.text || '').includes(needle);

  const search = await api(`/api/search/messages?q=${encodeURIComponent(needle)}`, { cookie: actor.cookie });
  out.search = (search.json?.results || []).some((r) => String(r.body).includes(needle));

  const convs = await api('/api/conversations', { cookie: actor.cookie });
  out.listPreview = (convs.json || []).some((c) => String(c.lastMessagePreview || '').includes(needle));

  if (profileOf) {
    const profile = await api(`/api/principals/${profileOf}/profile`, { cookie: actor.cookie });
    out.profile = JSON.stringify(profile.json?.recentMessages || []).includes(needle);
  }

  if (agentToken) {
    // 摘要模式：正文不该出现（只给计数）；明细模式：正文必须不出现
    const digest = await mcp(agentToken, 'whats_new', { since_seq: 0, limit: 50 }, 11);
    out.mcpDigest = JSON.stringify(digest).includes(needle);
    const detail = await mcp(agentToken, 'whats_new', { since_seq: 0, detail: true, limit: 200 }, 12);
    out.mcpDetail = JSON.stringify(detail).includes(needle);
    void agentId;
  }
  return out;
}

const main = async () => {
  const A = await signup('泄露A');
  const B = await signup('泄露B');
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '泄露验证群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;

  // Agent（用于 MCP whats_new 的读路径）
  const ag = await api('/api/agents', { method: 'POST', cookie: A.cookie, body: { display_name: '泄露AI' } });
  const agentToken = ag.json.token;
  const agentId = ag.json.agent.id;
  await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: A.cookie, body: { principal_id: agentId } });

  // 1) 正常消息（正向对照）
  const normal = `正常消息 keep-${rnd()}`;
  await send(B, gid, normal);
  const normalSeen = await sightings(A, gid, normal, agentToken, agentId, B.id);
  check(
    '正向对照：正常消息出现在所有读路径（含成员主页）',
    normalSeen.messages && normalSeen.search && normalSeen.profile && normalSeen.mcpDetail,
    JSON.stringify(normalSeen),
  );

  // 2) 撤回消息
  const secret1 = `要撤回 recall-${rnd()}`;
  const m = await send(B, gid, secret1);
  const rec = await api(`/api/conversations/${gid}/messages/${m.seq}`, { method: 'DELETE', cookie: B.cookie });
  check('准备：撤回成功', rec.status === 200, `status=${rec.status}`);
  const afterRecall = await sightings(A, gid, secret1, agentToken, agentId, B.id);
  const leaked = Object.entries(afterRecall).filter(([, v]) => v).map(([k]) => k);
  check('撤回后：任何读路径都看不到正文', leaked.length === 0, leaked.length ? `泄露于 ${leaked.join('/')}` : 'ok');

  // 3) 站务隐藏（需要站务账号）
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const login = await api('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (login.status !== 200) throw new Error(`站务登录失败 ${login.status}`);
    const admin = { id: login.json.me.id, cookie: login.cookie };
    const secret2 = `要隐藏 hidden-${rnd()}`;
    const m2 = await send(B, gid, secret2);
    const rep = await api('/api/reports', {
      method: 'POST', cookie: A.cookie,
      body: { target_type: 'message', target_id: m2.seq, conversation_id: gid, reason: '泄露验证：隐藏用例' },
    });
    check('准备：举报成功', rep.status === 200, `status=${rep.status}`);
    const list = await api('/api/admin/reports?status=open', { cookie: admin.cookie });
    const item = (list.json?.reports || []).find((r) => r.targetId === m2.seq && r.conversationId === gid);
    const hide = await api(`/api/admin/reports/${item.id}/handle`, {
      method: 'POST', cookie: admin.cookie, body: { action: 'hide_message', note: '泄露验证' },
    });
    check('准备：站务隐藏成功', hide.status === 200, `status=${hide.status}`);
    const afterHide = await sightings(A, gid, secret2, agentToken, agentId, B.id);
    const leaked2 = Object.entries(afterHide).filter(([, v]) => v).map(([k]) => k);
    check('隐藏后：任何读路径都看不到正文', leaked2.length === 0, leaked2.length ? `泄露于 ${leaked2.join('/')}` : 'ok');
  } else {
    console.log('SKIP  未提供 ADMIN_EMAIL/ADMIN_PASSWORD：跳过站务隐藏用例');
  }

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
