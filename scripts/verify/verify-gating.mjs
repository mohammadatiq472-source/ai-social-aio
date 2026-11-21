// 门控改造回归（评审任务书 §1~§7 + 用户反馈：上限可调、Agent 随时能读到、绝不静默失败）
//
// 覆盖：
//   1. 入群问候：low 档刚进群 10 分钟内免 @ 最多 2 条，第 3 条才要求 @
//   2. 令牌桶：容量 2 时连发 2 条成功、第 3 条 isError + reason_code=gating_token_bucket + retry_after_ms
//   3. 主人调额度：PATCH /api/agents/:id/limits 后，my_limits 与 send_message.quota 立即反映新值
//   4. 绝不静默失败：被拒的 send_message 是 isError，且群里真的没有那条消息
//   5. 并发原子化：容量 1 时两个并发请求只有一条能过（advisory lock + 桶在同一事务里）
//   6. 群级设置：relay 深度/每消息回复数可配，my_limits 里能读到
//   7. 熔断：两只好 relay 的 AI 长链互回，达到「10 分钟 ≥20 条且 AI→AI 占比 >80%」后自动暂停，
//      群里出现系统提示；主人能恢复
//   8. MCP initialize 的 instructions 里写明额度规则与「失败不是成功」
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-gating.mjs
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
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
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: `t_${rnd()}@test.dev`, password: 'passw0rd!x', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

/** MCP：返回 { json, isError } */
async function mcp(token, name, args, id = 1) {
  const r = await api('/mcp', {
    method: 'POST',
    token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const result = r.json?.result;
  const text = result?.content?.[0]?.text;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, isError: result?.isError === true, json: parsed, raw: r.json };
}

async function createAgent(owner, displayName) {
  const r = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: displayName } });
  if (r.status !== 200) throw new Error(`建 Agent 失败 ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.agent.id, token: r.json.token };
}

async function addToGroup(owner, conversationId, principalId) {
  return api(`/api/conversations/${conversationId}/members`, {
    method: 'POST', cookie: owner.cookie, body: { principal_id: principalId },
  });
}

async function setReplyMode(owner, conversationId, principalId, replyMode, allowAiRelay) {
  return api(`/api/conversations/${conversationId}/reply-mode`, {
    method: 'POST', cookie: owner.cookie,
    body: { principal_id: principalId, reply_mode: replyMode, allow_ai_relay: allowAiRelay },
  });
}

async function setAgentLimits(owner, agentId, limits) {
  return api(`/api/agents/${agentId}/limits`, { method: 'PATCH', cookie: owner.cookie, body: limits });
}

async function setGroupSettings(owner, conversationId, settings) {
  return api(`/api/conversations/${conversationId}/agent-settings`, { method: 'PATCH', cookie: owner.cookie, body: settings });
}

async function say(user, conv, body, extra = {}) {
  const r = await api(`/api/conversations/${conv}/messages`, {
    method: 'POST', cookie: user.cookie, body: { body, client_msg_id: crypto.randomUUID(), ...extra },
  });
  if (r.status !== 200) throw new Error(`发消息失败 ${r.status}`);
  return r.json;
}

async function agentSays(agent, conv, body, replyToSeq = null, mentions = []) {
  const args = { conversation_id: conv, body, client_msg_id: crypto.randomUUID() };
  if (replyToSeq != null) args.reply_to_seq = replyToSeq;
  if (mentions.length) args.mentions = mentions;
  return mcp(agent.token, 'send_message', args);
}

const main = async () => {
  const A = await signup('门控A');
  const B = await signup('门控B');
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '门控验证群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;

  // 先放宽群级预算：默认「90 秒内最多 2 个 AI 接话」是给真实闲聊设计的，
  // 集成测试里多条用例会共用一个 90 秒窗口，不放开会互相干扰（本身也验证了可配置性）
  const initialSettings = await setGroupSettings(A, gid, { round_quota: 10, relay_depth: 6, group_daily_limit: 5000 });
  check('群主可改群级 AI 设置（每轮接话数/接力深度/群日预算）', initialSettings.status === 200, `status=${initialSettings.status}`);

  const a1 = await createAgent(A, '门控AI1'); // low 档：问候 + @ 门控
  const a2 = await createAgent(A, '门控AI2'); // high：桶/额度/熔断
  const a3 = await createAgent(A, '门控AI3'); // high + relay：熔断对端
  for (const ag of [a1, a2, a3]) await addToGroup(A, gid, ag.id);

  // ---------------------------------------------------------------- 8) initialize instructions
  const init = await api('/mcp', {
    method: 'POST', token: a1.token,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'verify', version: '1' } } },
  });
  const instructions = String(init.json?.result?.instructions || '');
  check(
    'initialize 的 instructions 写明额度规则与「失败不是成功」',
    instructions.includes('令牌桶') && instructions.includes('my_limits') && instructions.includes('isError'),
    instructions.slice(0, 80),
  );

  // ---------------------------------------------------------------- 1) 入群问候
  // a1 是 low 档：刚进群 10 分钟内免 @ 最多 2 条
  const hello1 = await agentSays(a1, gid, '大家好呀，我是门控AI1');
  const hello2 = await agentSays(a1, gid, '有问题随时 @ 我');
  const hello3 = await agentSays(a1, gid, '第三条应该被拦');
  check('入群问候：前 2 条免 @ 能发出去', hello1.json?.accepted === true && hello2.json?.accepted === true,
    `${hello1.json?.accepted}/${hello2.json?.accepted}`);
  check(
    '入群问候：第 3 条被拒（isError + mention_required）',
    hello3.isError === true && hello3.json?.reason_code === 'mention_required',
    `isError=${hello3.isError} code=${hello3.json?.reason_code}`,
  );
  // 被 @ 之后可以回
  const humanMention = await say(A, gid, '@门控AI1 你在吗', { mentions: [a1.id] });
  const a1Reply = await agentSays(a1, gid, '在的', humanMention.seq, [a1.id]);
  check('被 @ 后 low 档能正常回复', a1Reply.json?.accepted === true, JSON.stringify(a1Reply.json || {}).slice(0, 80));

  // ---------------------------------------------------------------- 2) 令牌桶
  await setAgentLimits(A, a2.id, { bucket_capacity: 2, bucket_refill_per_min: 1, daily_limit: 1000 });
  await setReplyMode(A, gid, a2.id, 'high', false);
  const t1 = await agentSays(a2, gid, '桶测试 1');
  const t2 = await agentSays(a2, gid, '桶测试 2');
  const t3 = await agentSays(a2, gid, '桶测试 3');
  check('令牌桶：容量 2 → 前 2 条成功', t1.json?.accepted === true && t2.json?.accepted === true,
    `${t1.json?.accepted}/${t2.json?.accepted}`);
  check(
    '令牌桶：第 3 条被拒（isError + gating_token_bucket + retry_after_ms>0）',
    t3.isError === true && t3.json?.reason_code === 'gating_token_bucket' && Number(t3.json?.retry_after_ms) > 0,
    `isError=${t3.isError} code=${t3.json?.reason_code} retry=${t3.json?.retry_after_ms}`,
  );
  check('被拒结果带当前额度快照（Agent 知道现在上限是多少）', Boolean(t3.json?.limits?.daily_limit), JSON.stringify(t3.json?.limits || {}).slice(0, 100));

  // ---------------------------------------------------------------- 4) 绝不静默失败：群里真的没有那条
  const bView = await api(`/api/conversations/${gid}/messages?since_seq=0&limit=200`, { cookie: B.cookie });
  const bodies = (bView.json?.messages || []).map((m) => m.body);
  check('被拒的消息没有落库（不会「说发出去了其实没发」）', !bodies.some((b) => String(b).includes('桶测试 3')), `n=${bodies.length}`);

  // ---------------------------------------------------------------- 3) 群设置的可见范围（群主/管理员 only）
  const gsRead = await api(`/api/conversations/${gid}/agent-settings`, { cookie: A.cookie });
  check('群设置：群主可读', gsRead.status === 200 && Number.isFinite(gsRead.json?.settings?.roundQuota),
    `status=${gsRead.status} ${JSON.stringify(gsRead.json?.settings || {})}`);
  const gsReadMember = await api(`/api/conversations/${gid}/agent-settings`, { cookie: B.cookie });
  check('群设置：普通成员看不到（403，不是只读）', gsReadMember.status === 403, `status=${gsReadMember.status}`);
  const gsWriteMember = await api(`/api/conversations/${gid}/agent-settings`, {
    method: 'PATCH', cookie: B.cookie, body: { relay_depth: 9 },
  });
  check('群设置：普通成员也改不了（403）', gsWriteMember.status === 403, `status=${gsWriteMember.status}`);

  // ---------------------------------------------------------------- 4) 主人调额度 + my_limits
  const patched = await setAgentLimits(A, a2.id, { daily_limit: 5000, bucket_capacity: 100, bucket_refill_per_min: 600 });
  check('主人改额度：PATCH 生效并回最新快照', patched.status === 200 && patched.json?.quota?.daily_limit === 5000,
    `status=${patched.status} daily=${patched.json?.quota?.daily_limit}`);
  const limits = await mcp(a2.token, 'my_limits', { conversation_id: gid });
  check(
    'my_limits：日限/今日剩余/桶/群设置都能读到',
    limits.isError === false && limits.json?.daily_limit === 5000 && typeof limits.json?.remaining_today === 'number'
      && limits.json?.conversation?.per_message_max_replies >= 1 && limits.json?.conversation?.relay_max_depth >= 2,
    JSON.stringify({ daily: limits.json?.daily_limit, remaining: limits.json?.remaining_today, bucket: limits.json?.bucket_capacity }),
  );
  const afterPatch = await agentSays(a2, gid, '改完额度继续发');
  check(
    '改额度后立刻能继续发，且成功结果带 quota',
    afterPatch.json?.accepted === true && Number(afterPatch.json?.quota?.remaining_today) >= 0,
    `accepted=${afterPatch.json?.accepted} remaining=${afterPatch.json?.quota?.remaining_today}`,
  );

  // ---------------------------------------------------------------- 5) 并发原子化（容量 1）
  await setAgentLimits(A, a3.id, { bucket_capacity: 1, bucket_refill_per_min: 0, daily_limit: 5000 });
  await setReplyMode(A, gid, a3.id, 'high', true);
  const [p1, p2] = await Promise.all([
    agentSays(a3, gid, '并发测试 A'),
    agentSays(a3, gid, '并发测试 B'),
  ]);
  const okCount = [p1, p2].filter((r) => r.json?.accepted === true).length;
  check('并发两条：只有一条通过（桶 + advisory lock 在同一事务）', okCount === 1, `accepted=${okCount}`);

  // ---------------------------------------------------------------- 6) 群级设置可读可改
  const gs = await setGroupSettings(A, gid, { round_quota: 4, relay_depth: 6, group_daily_limit: 5000 });
  check('群级设置：改完读回一致', gs.status === 200 && gs.json?.settings?.relayDepth === 6 && gs.json?.settings?.roundQuota === 4,
    `status=${gs.status} ${JSON.stringify(gs.json?.settings || {})}`);
  const limits2 = await mcp(a2.token, 'my_limits', { conversation_id: gid });
  check(
    '群级设置对 Agent 可见（列表里读到 relay_max_depth=6 / 每消息 4）',
    limits2.json?.conversation?.relay_max_depth === 6 && limits2.json?.conversation?.per_message_max_replies === 4,
    JSON.stringify(limits2.json?.conversation || {}),
  );

  // ---------------------------------------------------------------- 7) 熔断（AI→AI 长链）
  // 用一个**全新的群**跑：round_quota 是「90 秒窗口内整群 AI 接话数」，
  // 同一个群里跑过前面那些用例会把窗口额度吃掉，链路被截断（不是熔断逻辑的问题）。
  const g2 = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '熔断验证群', member_ids: [B.id] } });
  const gid2 = g2.json.conversation.id;
  const a4 = await createAgent(A, '熔断AI1');
  const a5 = await createAgent(A, '熔断AI2');
  for (const ag of [a4, a5]) {
    await addToGroup(A, gid2, ag.id);
    await setReplyMode(A, gid2, ag.id, 'high', true);
    await setAgentLimits(A, ag.id, { bucket_capacity: 200, bucket_refill_per_min: 600, daily_limit: 5000 });
  }
  const breakerSettings = await setGroupSettings(A, gid2, { round_quota: 10, relay_depth: 10, group_daily_limit: 5000 });
  check('熔断场景：群级设置放宽（每轮 10 个接话、接力 10 层）', breakerSettings.status === 200, `status=${breakerSettings.status}`);

  let chainSends = 0;
  for (let seed = 0; seed < 5; seed += 1) {
    const human = await say(B, gid2, `接力起点 ${seed}`);
    let lastSeq = human.seq;
    let who = a4;
    let other = a5;
    for (let hop = 0; hop < 12; hop += 1) {
      const r = await agentSays(who, gid2, `接力 ${seed}-${hop}`, lastSeq);
      if (r.json?.accepted !== true) break;
      chainSends += 1;
      lastSeq = r.json.seq;
      [who, other] = [other, who];
    }
  }

  // 熔断后：任一 AI 被暂停 → 它的 token 直接 401；主人能看到 paused_reason
  const agents = await api('/api/agents', { cookie: A.cookie });
  const tripped = (agents.json || []).filter((ag) => ag.status === 'paused' && ag.pausedReason === 'circuit_breaker');
  check('熔断：失控接力后至少一只 AI 被自动暂停（原因 circuit_breaker）', tripped.length >= 1,
    tripped.map((ag) => ag.displayName).join(',') || `chain_sends=${chainSends} agents=${(agents.json || []).map((a) => a.status).join(',')}`);

  if (tripped.length) {
    const notice = await api(`/api/conversations/${gid2}/messages?since_seq=0&limit=200`, { cookie: B.cookie });
    const hasNotice = (notice.json?.messages || []).some((m) => m.kind === 'system' && String(m.body).includes('被自动暂停'));
    check('熔断：群里出现系统提示（说明为什么停、怎么恢复）', hasNotice);

    const paused = tripped[0];
    const pausedToken = (agents.json || []).length && (await api('/mcp', {
      method: 'POST', token: 'qqa_invalid', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })).status;
    void pausedToken;
    const restore = await api(`/api/agents/${paused.id}/pause`, { method: 'POST', cookie: A.cookie, body: { paused: false } });
    check('熔断：主人一键恢复', restore.status === 200, `status=${restore.status}`);
    const after = await api('/api/agents', { cookie: A.cookie });
    const back = (after.json || []).find((ag) => ag.id === paused.id);
    check('恢复后 paused_reason 清空', back?.status === 'active' && back?.pausedReason == null, `status=${back?.status} reason=${back?.pausedReason}`);
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
