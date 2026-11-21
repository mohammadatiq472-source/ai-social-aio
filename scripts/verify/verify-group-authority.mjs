// 权限矩阵回归（群主 / 成员 / 非成员 / Agent）—— 用户问的「脚本能不能绕过拿群主权限、踢人」的答案。
//
// 逐个尝试真实攻击动作，断言全部被拒：
//   1. 普通成员：改群 AI 设置 / 读群 AI 设置 / 拉人 / 踢人 / 踢群主 / 改别人 AI 的发言档位 → 403/404
//   2. 非成员：同样动作全部 403（不能靠猜 conversation_id 越权）
//   3. Agent：Bearer token 打 REST 一律 401（REST 只认会话 cookie）；MCP 工具表里没有成员/群设置类工具
//   4. 伪造会话 cookie → 401
//   5. 普通成员：暂停/删除别人创建的 AI → 404（owner_user_id 校验）
//   6. 群主：上述动作（除「踢群主自己」）可以成功（正向对照，排除「全拒」蒙对）
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-group-authority.mjs
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

async function befriend(a, b) {
  await api('/api/friends/request', { method: 'POST', cookie: a.cookie, body: { account_no: b.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: b.cookie, body: { principal_id: a.id } });
}

async function mcp(token, name, args, id = 1) {
  const r = await api('/mcp', {
    method: 'POST', token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  return {
    status: r.status,
    result: r.json?.result,
    isError: r.json?.result?.isError === true,
    // 未知工具走 JSON-RPC error（HTTP 仍 200），这也是「明确失败」而不是静默成功
    rpcError: r.json?.error ?? null,
  };
}

const main = async () => {
  const owner = await signup('权限群主');
  const member = await signup('权限成员');
  const outsider = await signup('权限路人');
  await befriend(owner, member);

  const g = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title: '权限验证群', member_ids: [member.id] } });
  const gid = g.json.conversation.id;

  // 群主的 AI（成员想来改它）
  const ownerAgent = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '群主的AI' } });
  const agentId = ownerAgent.json.agent.id;
  const agentToken = ownerAgent.json.token;
  await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: owner.cookie, body: { principal_id: agentId } });

  // ---------------------------------------------------------------- 1) 普通成员
  const settingsPath = `/api/conversations/${gid}/agent-settings`;
  const memberRead = await api(settingsPath, { cookie: member.cookie });
  check('成员读群设置 → 403', memberRead.status === 403, `status=${memberRead.status}`);
  const memberWrite = await api(settingsPath, { method: 'PATCH', cookie: member.cookie, body: { relay_depth: 9 } });
  check('成员改群设置 → 403', memberWrite.status === 403, `status=${memberWrite.status}`);

  const memberAdd = await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: member.cookie, body: { principal_id: outsider.id } });
  check('成员拉人入群 → 被拒（403/400）', memberAdd.status === 403 || memberAdd.status === 400, `status=${memberAdd.status} reason=${memberAdd.json?.error}`);

  const memberKickOwner = await api(`/api/conversations/${gid}/members/${owner.id}`, { method: 'DELETE', cookie: member.cookie });
  check('成员踢群主 → 被拒', memberKickOwner.status === 403 || memberKickOwner.status === 400, `status=${memberKickOwner.status} reason=${memberKickOwner.json?.error}`);

  const memberKickOther = await api(`/api/conversations/${gid}/members/${agentId}`, { method: 'DELETE', cookie: member.cookie });
  check('成员踢别人 → 被拒', memberKickOther.status === 403 || memberKickOther.status === 400, `status=${memberKickOther.status} reason=${memberKickOther.json?.error}`);

  const memberReplyMode = await api(`/api/conversations/${gid}/reply-mode`, {
    method: 'POST', cookie: member.cookie, body: { principal_id: agentId, reply_mode: 'high' },
  });
  check('成员改别人 AI 的发言档位 → 被拒', memberReplyMode.status === 403 || memberReplyMode.status === 400, `status=${memberReplyMode.status} reason=${memberReplyMode.json?.error}`);

  const memberLimits = await api(`/api/agents/${agentId}/limits`, { method: 'PATCH', cookie: member.cookie, body: { daily_limit: 99999 } });
  check('成员改别人 AI 的额度 → 404（不是自己的 AI）', memberLimits.status === 404, `status=${memberLimits.status}`);
  const memberPause = await api(`/api/agents/${agentId}/pause`, { method: 'POST', cookie: member.cookie, body: { paused: true } });
  check('成员暂停别人的 AI → 404', memberPause.status === 404, `status=${memberPause.status}`);

  // ---------------------------------------------------------------- 2) 非成员
  const outRead = await api(settingsPath, { cookie: outsider.cookie });
  check('非成员读群设置 → 403', outRead.status === 403, `status=${outRead.status}`);
  const outWrite = await api(settingsPath, { method: 'PATCH', cookie: outsider.cookie, body: { group_daily_limit: 1 } });
  check('非成员改群设置 → 403', outWrite.status === 403, `status=${outWrite.status}`);
  const outKick = await api(`/api/conversations/${gid}/members/${agentId}`, { method: 'DELETE', cookie: outsider.cookie });
  check('非成员踢人 → 403/400', outKick.status === 403 || outKick.status === 400, `status=${outKick.status}`);
  const outAdd = await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: outsider.cookie, body: { principal_id: outsider.id } });
  check('非成员自己把自己拉进群 → 被拒', outAdd.status === 403 || outAdd.status === 400, `status=${outAdd.status}`);

  // ---------------------------------------------------------------- 3) Agent 的边界
  const agentRest = await api(settingsPath, { method: 'PATCH', token: agentToken, body: { relay_depth: 9 } });
  check('Agent 拿 Bearer 打 REST 改群设置 → 401（REST 只认会话 cookie）', agentRest.status === 401, `status=${agentRest.status}`);

  const tools = await api('/mcp', { method: 'POST', token: agentToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  const names = (tools.json?.result?.tools || []).map((t) => t.name);
  check(
    'MCP 工具表里没有成员管理/群设置类工具',
    names.length > 0 && !names.some((n) => /member|kick|role|settings|admin/i.test(n)),
    names.join(','),
  );
  const agentCallFake = await mcp(agentToken, 'set_group_settings', { conversation_id: gid, relay_depth: 9 });
  check(
    'Agent 调不存在的群设置工具 → 明确报错（JSON-RPC error，不是静默成功）',
    agentCallFake.isError === true || Boolean(agentCallFake.rpcError) || agentCallFake.status >= 400,
    `isError=${agentCallFake.isError} rpcError=${agentCallFake.rpcError?.code ?? '-'}`,
  );

  // ---------------------------------------------------------------- 4) 伪造 cookie
  const forged = await api(settingsPath, { cookie: 'sid=' + crypto.randomBytes(24).toString('hex') });
  check('伪造会话 cookie → 401', forged.status === 401, `status=${forged.status}`);

  // ---------------------------------------------------------------- 4.5) 成员角色（设管理员 / 取消 / 退群）
  const rolePath = (pid) => `/api/conversations/${gid}/members/${pid}/role`;
  const memberTryPromote = await api(rolePath(member.id), { method: 'POST', cookie: member.cookie, body: { role: 'admin' } });
  check('普通成员给自己/别人设管理员 → 403', memberTryPromote.status === 403, `status=${memberTryPromote.status}`);

  const promote = await api(rolePath(member.id), { method: 'POST', cookie: owner.cookie, body: { role: 'admin' } });
  check('群主把成员设为管理员 → 200', promote.status === 200 && promote.json?.role === 'admin',
    `status=${promote.status} role=${promote.json?.role}`);
  const memberNowAdmin = await api(settingsPath, { cookie: member.cookie });
  check('升为管理员后能读群设置', memberNowAdmin.status === 200, `status=${memberNowAdmin.status}`);

  const ownerRole = await api(rolePath(owner.id), { method: 'POST', cookie: owner.cookie, body: { role: 'member' } });
  check('不能修改群主自己的角色 → 403', ownerRole.status === 403, `status=${ownerRole.status}`);

  // 再加一个普通成员，验证「管理员不能设管理员」与「管理员不能踢管理员」
  const member2 = await signup('权限成员2');
  await befriend(owner, member2);
  const addM2 = await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: owner.cookie, body: { principal_id: member2.id } });
  check('准备：群主拉第二个成员进群', addM2.status === 200, `status=${addM2.status}`);
  const adminPromote = await api(rolePath(member2.id), { method: 'POST', cookie: member.cookie, body: { role: 'admin' } });
  check('管理员不能把别人设为管理员 → 403', adminPromote.status === 403, `status=${adminPromote.status}`);

  // member2 也升管理员，然后 member（管理员）试图踢 member2 → 应被拒
  await api(rolePath(member2.id), { method: 'POST', cookie: owner.cookie, body: { role: 'admin' } });
  const adminKickAdmin = await api(`/api/conversations/${gid}/members/${member2.id}`, { method: 'DELETE', cookie: member.cookie });
  check('管理员不能移出另一个管理员 → 400/403', adminKickAdmin.status === 400 || adminKickAdmin.status === 403,
    `status=${adminKickAdmin.status} reason=${adminKickAdmin.json?.error}`);
  const ownerKickAdmin = await api(`/api/conversations/${gid}/members/${member2.id}`, { method: 'DELETE', cookie: owner.cookie });
  check('群主可以移出管理员 → 200', ownerKickAdmin.status === 200, `status=${ownerKickAdmin.status}`);

  // 普通成员自己退群（不需要群主/管理员权限）
  const member3 = await signup('权限成员3');
  await befriend(owner, member3);
  await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: owner.cookie, body: { principal_id: member3.id } });
  const leave = await api(`/api/conversations/${gid}/members/${member3.id}`, { method: 'DELETE', cookie: member3.cookie });
  check('普通成员可以自己退群 → 200', leave.status === 200, `status=${leave.status}`);
  const afterLeave = await api(`/api/conversations/${gid}/messages?limit=1`, { cookie: member3.cookie });
  check('退群后读不到消息 → 403', afterLeave.status === 403, `status=${afterLeave.status}`);
  const ownerLeave = await api(`/api/conversations/${gid}/members/${owner.id}`, { method: 'DELETE', cookie: owner.cookie });
  check('群主不能退出自己的群 → 403', ownerLeave.status === 403, `status=${ownerLeave.status}`);

  // ---------------------------------------------------------------- 5) 群主正向对照
  const ownerWrite = await api(settingsPath, { method: 'PATCH', cookie: owner.cookie, body: { relay_depth: 3, round_quota: 4, group_daily_limit: 800 } });
  check('群主改群设置 → 200', ownerWrite.status === 200, `status=${ownerWrite.status}`);
  const ownerAdd = await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: owner.cookie, body: { principal_id: outsider.id } });
  // outsider 不是群主好友 → 仍应被「只能拉好友」拦住（这本身也是一条防护）
  check('群主拉陌生人 → 仍被「只能拉好友」拦住', ownerAdd.status === 400 || ownerAdd.status === 403,
    `status=${ownerAdd.status} reason=${ownerAdd.json?.error}`);
  const ownerKick = await api(`/api/conversations/${gid}/members/${agentId}`, { method: 'DELETE', cookie: owner.cookie });
  check('群主踢自己的 AI → 200', ownerKick.status === 200, `status=${ownerKick.status}`);

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
