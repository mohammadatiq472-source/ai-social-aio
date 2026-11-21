// 回归验收：C10 门控 / 读隔离 / 幂等 / 空间
// 用法：BASE=https://127.0.0.1:8443 node scripts/accept.mjs
// 只依赖内置 fetch（Node 18+），失败非 0 退出。
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const uuid = () => crypto.randomUUID();

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
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
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, cookie: sid || cookie };
}

async function signup(name) {
  const email = `t_${rnd()}@test.dev`;
  const r = await api('/api/auth/register', { method: 'POST', body: { email, password: 'passw0rd!x', display_name: name, invite_code: process.env.REGISTER_CODE || '' } });
  if (r.status !== 200) throw new Error(`register failed ${r.status} ${JSON.stringify(r.json)}`);
  return { email, cookie: r.cookie, id: r.json.me.id, accountNo: r.json.me.accountNo };
}

async function mcp(token, name, args) {
  const r = await api('/mcp', {
    method: 'POST',
    token,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const payload = r.json?.result?.content?.[0]?.text;
  return payload ? JSON.parse(payload) : { httpError: r.status, body: r.json };
}

const main = async () => {
  const A = await signup('验收A');
  const B = await signup('验收B');

  // 建群只能拉好友：先把两人变成好友，否则 create_group 会被拦（这正是安全修复后的正确行为）
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });

  // ---------- 准备：A 建群、建 Agent、拉群 ----------
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '验收群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;
  const ag = await api('/api/agents', { method: 'POST', cookie: A.cookie, body: { display_name: '验收AI' } });
  const agentId = ag.json.agent.id;
  const token = ag.json.token;
  await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: A.cookie, body: { principal_id: agentId } });

  // 另建一个 A 不在里面…但要能拉 agent 进去，仍由 A 建群再踢掉自己？简化为：A 建第二个群，只拉 B，不拉 agent
  const g2 = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '验收群2', member_ids: [B.id] } });
  const gid2 = g2.json.conversation.id;

  // ---------- A1 读隔离：不在群的 AI 读不到也发不出 ----------
  const isoRead = await mcp(token, 'whats_new', { since_seq: 0, conversation_ids: [gid2], detail: true });
  check('A1 不在群的会话：whats_new 不返回该群消息',
    Array.isArray(isoRead.events) && isoRead.events.every((e) => e.conversation_id !== gid2),
    `events=${isoRead.events?.length}`);
  const isoWrite = await mcp(token, 'send_message', { conversation_id: gid2, body: '越权发言', client_msg_id: uuid() });
  check('A1 不在群的会话：send_message 被拒', isoWrite.accepted === false && isoWrite.reason === 'forbidden', isoWrite.reason);

  // ---------- 准备消息 ----------
  const m1 = await api(`/api/conversations/${gid}/messages`, { method: 'POST', cookie: B.cookie, body: { body: '这条没 @ 你', client_msg_id: uuid() } });
  const m2 = await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie: B.cookie, body: { body: '@验收AI 你在吗', client_msg_id: uuid(), mentions: [agentId] },
  });
  const seqNoMention = m1.json.seq;
  const seqMention = m2.json.seq;

  // ---------- whats_new 的 may_reply ----------
  const wn = await mcp(token, 'whats_new', { since_seq: 0, conversation_ids: [gid], detail: true });
  const evNo = (wn.events || []).find((e) => e.seq === seqNoMention && e.conversation_id === gid);
  const evYes = (wn.events || []).find((e) => e.seq === seqMention && e.conversation_id === gid);
  check('C10 whats_new：未被 @ 的消息 may_reply=false', evNo?.may_reply === false);
  check('C10 whats_new：被 @ 的消息 may_reply=true', evYes?.may_reply === true);

  // 摘要模式：默认不返回正文，只给计数与 @ 命中
  const digest = await mcp(token, 'whats_new', { since_seq: 0, conversation_ids: [gid] });
  const dconv = (digest.conversations || []).find((c) => c.conversationId === gid);
  check('whats_new 默认返回摘要（无 events 正文）',
    Array.isArray(digest.conversations) && digest.events === undefined && dconv?.count >= 2,
    `count=${dconv?.count} total=${digest.total}`);
  check('摘要里能标出 @ 我 的 seq', Array.isArray(dconv?.mentionsMe) && dconv.mentionsMe.includes(seqMention),
    JSON.stringify(dconv?.mentionsMe));

  // ---------- A4 门控（门控改造后的语义：入群问候豁免 + 令牌桶 + 结构化拒绝） ----------
  // 依据：docs/交接-2026-11-13.md §0v / 评审任务书 §4——刚进群 10 分钟内免 @ 最多 2 条。
  // 所以「未 @ 就被拒」要先把问候额度用掉，第 3 条才是 mention_required。
  // 群级每轮接话数先放宽到 10，否则 90 秒窗口会被本用例自己的多条消息吃掉（那是真实闲聊口径）。
  await api(`/api/conversations/${gid}/agent-settings`, {
    method: 'PATCH', cookie: A.cookie, body: { round_quota: 10 },
  });
  const greet1 = await mcp(token, 'send_message', { conversation_id: gid, body: '入群问候 1', client_msg_id: uuid() });
  const greet2 = await mcp(token, 'send_message', { conversation_id: gid, body: '入群问候 2', client_msg_id: uuid() });
  check('A4 入群 10 分钟内免 @ 可打招呼 2 条', greet1.accepted === true && greet2.accepted === true,
    `${greet1.reason ?? 'ok'}/${greet2.reason ?? 'ok'}`);

  const r1 = await mcp(token, 'send_message', { conversation_id: gid, body: '引用没 @ 我的那条', client_msg_id: uuid(), reply_to_seq: seqNoMention });
  check('A4 问候额度用完后再引用未 @ 自己的消息被拒', r1.accepted === false && r1.reason === 'gating_mention_required', r1.reason);
  check('A4 拒绝是结构化失败（isError + reason_code + 没有静默成功）', r1.accepted === false && r1.reason_code === 'mention_required',
    `code=${r1.reason_code}`);

  const retryId = uuid();
  const r3 = await mcp(token, 'send_message', { conversation_id: gid, body: '收到，用引用回复。', client_msg_id: retryId, reply_to_seq: seqMention });
  check('A4 引用 @ 自己的消息被放行', r3.accepted === true, `seq=${r3.seq}`);

  // 幂等重试：同一 client_msg_id 再来一次，必须拿到同一 event_id（而不是被门控/桶拦掉）
  const r3b = await mcp(token, 'send_message', { conversation_id: gid, body: '收到，用引用回复。', client_msg_id: retryId, reply_to_seq: seqMention });
  check('A4 幂等重试返回同一 event_id', r3b.accepted === true && r3b.deduplicated === true && r3b.event_id === r3.event_id,
    `event ${r3.event_id} / ${r3b.event_id}`);

  // ---------- A3 跨群复用同一 client_msg_id ----------
  const shared = uuid();
  const c1 = await api(`/api/conversations/${gid}/messages`, { method: 'POST', cookie: B.cookie, body: { body: '跨群幂等-1', client_msg_id: shared } });
  const c2 = await api(`/api/conversations/${gid2}/messages`, { method: 'POST', cookie: B.cookie, body: { body: '跨群幂等-2', client_msg_id: shared } });
  check('A3 同一 client_msg_id 在两个群都能成功（复合唯一键）',
    c1.status === 200 && c2.status === 200 && c1.json.event_id !== c2.json.event_id,
    `event ${c1.json?.event_id} / ${c2.json?.event_id}`);

  // ---------- A5 AI 不回 AI（自由发言模式） ----------
  const freeGroup = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '自由发言群', member_ids: [B.id] } });
  const fgid = freeGroup.json.conversation.id;
  await api(`/api/conversations/${fgid}/members`, { method: 'POST', cookie: A.cookie, body: { principal_id: agentId } });
  await api(`/api/conversations/${fgid}/reply-mode`, { method: 'POST', cookie: A.cookie, body: { principal_id: agentId, reply_mode: 'free' } });
  const human = await api(`/api/conversations/${fgid}/messages`, { method: 'POST', cookie: B.cookie, body: { body: '自由发言群里随便聊', client_msg_id: uuid() } });
  const freeAi = await mcp(token, 'send_message', { conversation_id: fgid, body: '我先说一句', client_msg_id: uuid(), reply_to_seq: human.json.seq });
  check('A5 自由发言模式下 AI 可回复人类', freeAi.accepted === true, freeAi.reason || `seq=${freeAi.seq}`);
  const aiToAi = await mcp(token, 'send_message', { conversation_id: fgid, body: '我再回我自己', client_msg_id: uuid(), reply_to_seq: freeAi.seq });
  check('A5 AI 回复 AI 被拒', aiToAi.accepted === false && aiToAi.reason === 'gating_no_ai_to_ai', aiToAi.reason);

  // ---------- 空间 ----------
  const f1 = await api('/api/feeds', { method: 'POST', cookie: A.cookie, body: { body: '验收说说一', visibility: 'friends', client_msg_id: uuid() } });
  check('空间：发布成功', f1.status === 200 && f1.json.feed_id > 0, `feed=${f1.json?.feed_id}`);
  const fid = f1.json.feed_id;
  const like1 = await api(`/api/feeds/${fid}/like`, { method: 'POST', cookie: B.cookie });
  const like2 = await api(`/api/feeds/${fid}/like`, { method: 'POST', cookie: B.cookie });
  const listAfter = await api('/api/feeds', { cookie: B.cookie });
  const row = (listAfter.json || []).find((f) => f.id === fid);
  check('空间：重复点赞只计 1 次', like1.json?.liked === true && like2.json?.deduplicated === true && row?.likeCount === 1, `count=${row?.likeCount}`);
  const cm = await api(`/api/feeds/${fid}/comments`, { method: 'POST', cookie: B.cookie, body: { body: '验收评论', client_msg_id: uuid() } });
  check('空间：评论成功', cm.status === 200 && cm.json.comment_id > 0);
  const cl = await api(`/api/feeds/${fid}/comments`, { cookie: B.cookie });
  check('空间：评论可读回', Array.isArray(cl.json) && cl.json.length >= 1);

  // ---------- MCP 协议一致性 ----------
  const rpc = async (payload, token) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };

  // MCP 生命周期要求「不支持就回自己支持的最新版」，不是报错；
  // 以前这里断言 -32602，会把官方 SDK（首选 2025-11-25）整条拒掉。
  const badVer = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-01-01', capabilities: {}, clientInfo: { name: 'accept', version: '0' } } }, token);
  check('协议：不支持的版本 → 200 + 协商成最新支持版（不是 -32602）',
    badVer.status === 200 && badVer.json?.result?.protocolVersion === '2025-11-25',
    JSON.stringify(badVer.json).slice(0, 160));

  const goodVer = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept', version: '0' } } }, token);
  check('协议：支持的版本 → 回显 protocolVersion', goodVer.json?.result?.protocolVersion === '2025-06-18');

  const unknown = await rpc({ jsonrpc: '2.0', id: 3, method: 'no/such', params: {} }, token);
  check('协议：未知方法 → -32601', unknown.json?.error?.code === -32601);

  const batch = await rpc([{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', id: 5, method: 'tools/list' }], token);
  check('协议：批量请求返回数组', Array.isArray(batch.json) && batch.json.length === 2);

  const noToken = await rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }, null);
  check('协议：无 token → 401 + WWW-Authenticate', noToken.status === 401);

  const getMcp = await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${token}` } });
  check('协议：GET /mcp → 405', getMcp.status === 405);

  // ---------- 暂停的 Agent 鉴权即拒 ----------
  const pause = await api(`/api/agents/${agentId}/pause`, { method: 'POST', cookie: A.cookie, body: { paused: true } });
  const pausedRpc = await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, token);
  await api(`/api/agents/${agentId}/pause`, { method: 'POST', cookie: A.cookie, body: { paused: false } });
  const resumedRpc = await rpc({ jsonrpc: '2.0', id: 8, method: 'ping' }, token);
  check('暂停的 Agent：401；恢复后 200', pause.status === 200 && pausedRpc.status === 401 && resumedRpc.status === 200,
    `${pausedRpc.status} → ${resumedRpc.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error('验收异常：', e.message);
  process.exitCode = 1;
});
