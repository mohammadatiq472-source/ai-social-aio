// AI 的群发现 / 加入（MCP find_groups + join_group）回归。
//
// 覆盖：
//   1. 私有群不进目录、join_group 返回 not_found（不泄露存在性）
//   2. open 群：find_groups 搜到（字段 snake_case、joined/join_mode 正确）→ join_group 直接进
//      → list_conversations 能看到 → search_messages 能读到群消息（成员资格真的生效）
//   3. approval 群：join_group 落申请（pending=true 且 isError=false —— 不能把「等审批」当失败）
//      → 重复提交幂等（duplicated）→ 群主在 REST 审批列表看到该 AI → accept 后能读消息
//   4. 已是成员再 join → already_member 幂等；目录里 joined 变 true
//   5. 参数校验：缺 conversation_id / 0 / find_groups limit 21 / 未知参数 → invalid_schema
//   6. initialize.instructions 写明 find_groups / join_group（可发现性）
//   7. 解散的群从目录消失
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-groups.mjs
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
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${r.text?.slice(0, 120)}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

// 建群只能拉「好友 / 自己的 AI」进群（submit#create_group 的护栏），先互加好友。
async function befriend(a, b) {
  await api('/api/friends/request', { method: 'POST', cookie: a.cookie, body: { account_no: b.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: b.cookie, body: { principal_id: a.id } });
}

// MCP tools/call → { isError, json }
async function mcp(token, name, args, id = 1) {
  const r = await api('/mcp', {
    method: 'POST', token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const text = r.json?.result?.content?.[0]?.text;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, isError: r.json?.result?.isError === true, json: parsed, rpcError: r.json?.error ?? null };
}

const cardOf = (res, id) => (res.groups || []).find((g) => Number(g.id) === id) || null;

const main = async () => {
  const owner = await signup('群发现主人');
  const member = await signup('群发现成员');
  await befriend(owner, member);
  const a = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: `找群AI${rnd()}` } });
  const agentId = a.json?.agent?.id;
  const token = a.json?.token;
  if (!token) throw new Error(`建 AI 失败 ${a.status} ${a.text?.slice(0, 120)}`);

  // ---------------------------------------------------------------- 0) 可发现性
  const init = await api('/mcp', {
    method: 'POST', token,
    body: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-mcp-groups', version: '1.0.0' } },
    },
  });
  const instructions = init.json?.result?.instructions || '';
  check('initialize.instructions 写明 find_groups 与 join_group（AI 能自己发现入口）',
    instructions.includes('find_groups') && instructions.includes('join_group'), `len=${instructions.length}`);
  check('instructions 说明 approval 的 pending 不是失败',
    instructions.includes('pending=true') && instructions.includes('不是失败'), '');

  // ---------------------------------------------------------------- 1) 私有群
  const titlePrivate = `私群${rnd()}`;
  const gPrivate = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: titlePrivate, member_ids: [member.id] },
  });
  const gidPrivate = Number(gPrivate.json?.conversation?.id);
  const privFind = await mcp(token, 'find_groups', { query: titlePrivate });
  check('私有群不出现在 find_groups 目录', !cardOf(privFind.json, gidPrivate),
    `n=${(privFind.json?.groups || []).length}`);
  const privJoin = await mcp(token, 'join_group', { conversation_id: gidPrivate });
  check('对私有群 join_group → isError:true + not_found（不泄露存在性）',
    privJoin.isError === true && privJoin.json?.reason_code === 'not_found', JSON.stringify(privJoin.json));

  // ---------------------------------------------------------------- 2) open 群
  const titleOpen = `开群${rnd()}`;
  const gOpen = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: titleOpen, member_ids: [member.id] },
  });
  const gidOpen = Number(gOpen.json?.conversation?.id);
  const welcome = `欢迎加入公开群${rnd()}`;
  const sent = await api(`/api/conversations/${gidOpen}/messages`, {
    method: 'POST', cookie: owner.cookie, body: { body: welcome, client_msg_id: rnd() },
  });
  check('群主先在 open 群发一条欢迎消息', sent.status === 200, `status=${sent.status}`);

  const publish = await api(`/api/conversations/${gidOpen}/public`, {
    method: 'PATCH', cookie: owner.cookie,
    body: { discoverable: true, join_mode: 'open', description: 'AI 可以自己进来的群' },
  });
  check('群主设为公开（open）→ 200', publish.status === 200 && publish.json?.joinMode === 'open', `status=${publish.status}`);

  const found = await mcp(token, 'find_groups', { query: titleOpen });
  const card = cardOf(found.json, gidOpen);
  check('公开后 AI 能在 find_groups 搜到', found.isError === false && Boolean(card),
    `isError=${found.isError} n=${(found.json?.groups || []).length}`);
  check('目录字段是协议 snake_case（id/title/member_count/joined/join_mode/last_message_at）',
    Boolean(card) && card.title === titleOpen && card.member_count === 2 && card.joined === false
      && card.join_mode === 'open' && Boolean(card.last_message_at) && card.description === 'AI 可以自己进来的群',
    JSON.stringify(card || {}).slice(0, 200));
  check('MCP 目录不透出 web 用的 camelCase 别名（memberCount/joinMode）',
    Boolean(card) && !('memberCount' in card) && !('joinMode' in card) && !('lastMessageAt' in card),
    JSON.stringify(card || {}));
  check('目录带 count/has_more/next_before_id 翻页字段',
    typeof found.json?.has_more === 'boolean' && found.json?.count === (found.json?.groups || []).length
      && Object.prototype.hasOwnProperty.call(found.json || {}, 'next_before_id'),
    JSON.stringify({ count: found.json?.count, has_more: found.json?.has_more }));

  const joinOpen = await mcp(token, 'join_group', { conversation_id: gidOpen });
  check('open 群 join_group → joined:true / pending:false，isError:false',
    joinOpen.isError === false && joinOpen.json?.joined === true && joinOpen.json?.pending === false
      && joinOpen.json?.accepted === true,
    JSON.stringify(joinOpen.json));
  check('join_group 不透出 core 内部的 ok 字段', joinOpen.json && !('ok' in joinOpen.json), JSON.stringify(joinOpen.json));

  const convs = await mcp(token, 'list_conversations', {});
  check('加入后 list_conversations 能看到这个群',
    (convs.json?.conversations || []).some((c) => Number(c.id) === gidOpen),
    `n=${(convs.json?.conversations || []).length}`);
  const readMsg = await mcp(token, 'search_messages', { query: welcome.slice(0, 6) });
  check('加入后 AI 能读群消息（search_messages 命中欢迎语）',
    readMsg.isError === false && (readMsg.json?.results || []).some((r) => Number(r.conversation_id) === gidOpen),
    `n=${(readMsg.json?.results || []).length}`);

  const joinAgain = await mcp(token, 'join_group', { conversation_id: gidOpen });
  check('已是成员再 join → already_member:true 幂等（不是错误）',
    joinAgain.isError === false && joinAgain.json?.already_member === true, JSON.stringify(joinAgain.json));
  const foundAfter = await mcp(token, 'find_groups', { query: titleOpen });
  check('加入后目录里该群 joined=true', cardOf(foundAfter.json, gidOpen)?.joined === true,
    JSON.stringify(cardOf(foundAfter.json, gidOpen) || {}));

  // ---------------------------------------------------------------- 3) approval 群
  const titleAppr = `审群${rnd()}`;
  const gAppr = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: titleAppr, member_ids: [member.id] },
  });
  const gidAppr = Number(gAppr.json?.conversation?.id);
  const apprWelcome = `审批群的欢迎语${rnd()}`;
  await api(`/api/conversations/${gidAppr}/messages`, {
    method: 'POST', cookie: owner.cookie, body: { body: apprWelcome, client_msg_id: rnd() },
  });
  await api(`/api/conversations/${gidAppr}/public`, {
    method: 'PATCH', cookie: owner.cookie,
    body: { discoverable: true, join_mode: 'approval', description: '需要群主点同意' },
  });

  const apprCard = cardOf((await mcp(token, 'find_groups', { query: titleAppr })).json, gidAppr);
  check('approval 群也出现在目录，join_mode=approval', Boolean(apprCard) && apprCard.join_mode === 'approval',
    JSON.stringify(apprCard || {}));

  const apply = await mcp(token, 'join_group', { conversation_id: gidAppr });
  check('approval 群 join_group → pending:true / joined:false',
    apply.isError === false && apply.json?.pending === true && apply.json?.joined === false,
    JSON.stringify(apply.json));
  check('pending=true 时 isError=false（「等审批」不是失败，否则 AI 会反复重试）',
    apply.isError === false, `isError=${apply.isError}`);
  check('申请返回 request_id', Number(apply.json?.request_id) > 0, JSON.stringify(apply.json));

  const applyAgain = await mcp(token, 'join_group', { conversation_id: gidAppr });
  check('重复申请幂等 → pending:true + duplicated:true',
    applyAgain.isError === false && applyAgain.json?.pending === true && applyAgain.json?.duplicated === true,
    JSON.stringify(applyAgain.json));

  const stillNotMember = await mcp(token, 'list_conversations', {});
  check('审批前不是成员（会话列表里没有该群）',
    !(stillNotMember.json?.conversations || []).some((c) => Number(c.id) === gidAppr));

  const ownerList = await api(`/api/conversations/${gidAppr}/join-requests`, { cookie: owner.cookie });
  const pendingEntry = (ownerList.json?.requests || []).find((r) => Number(r.principal_id) === Number(agentId));
  check('群主在 REST 审批列表里看到这个 AI 的申请', ownerList.status === 200 && Boolean(pendingEntry),
    `status=${ownerList.status} n=${(ownerList.json?.requests || []).length}`);
  const accept = await api(`/api/conversations/${gidAppr}/join-requests/${agentId}`, {
    method: 'POST', cookie: owner.cookie, body: { accept: true },
  });
  check('群主 accept → accepted', accept.status === 200 && accept.json?.status === 'accepted', `status=${accept.status}`);

  const afterAccept = await mcp(token, 'list_conversations', {});
  check('审批通过后会话列表里出现该群',
    (afterAccept.json?.conversations || []).some((c) => Number(c.id) === gidAppr));
  const readAppr = await mcp(token, 'search_messages', { query: apprWelcome.slice(0, 6), conversation_id: gidAppr });
  check('审批通过后能读该群消息',
    readAppr.isError === false && (readAppr.json?.results || []).some((r) => Number(r.conversation_id) === gidAppr),
    `n=${(readAppr.json?.results || []).length}`);

  const acceptAgain = await api(`/api/conversations/${gidAppr}/join-requests/${agentId}`, {
    method: 'POST', cookie: owner.cookie, body: { accept: true },
  });
  check('重复审批同一条申请 → 404（已不是 pending）', acceptAgain.status === 404, `status=${acceptAgain.status}`);

  // ---------------------------------------------------------------- 4) 分页与参数校验
  const onePage = await mcp(token, 'find_groups', { limit: 1 });
  check('find_groups limit=1 → 最多 1 条 + has_more 布尔',
    (onePage.json?.groups || []).length <= 1 && typeof onePage.json?.has_more === 'boolean',
    `n=${(onePage.json?.groups || []).length} has_more=${onePage.json?.has_more}`);

  const badLimit = await mcp(token, 'find_groups', { limit: 21 });
  check('find_groups limit=21 → invalid_schema', badLimit.isError === true && badLimit.json?.reason_code === 'invalid_schema',
    JSON.stringify(badLimit.json));
  const badExtra = await mcp(token, 'find_groups', { conversation_id: 1 });
  check('find_groups 带未知参数 → invalid_schema', badExtra.isError === true && badExtra.json?.reason === 'invalid_schema',
    JSON.stringify(badExtra.json));
  const noArg = await mcp(token, 'join_group', {});
  check('join_group 缺 conversation_id → invalid_schema',
    noArg.isError === true && noArg.json?.reason_code === 'invalid_schema', JSON.stringify(noArg.json));
  const zeroArg = await mcp(token, 'join_group', { conversation_id: 0 });
  check('join_group conversation_id=0 → invalid_schema',
    zeroArg.isError === true && zeroArg.json?.reason_code === 'invalid_schema', JSON.stringify(zeroArg.json));

  // ---------------------------------------------------------------- 5) 解散后消失
  const dissolve = await api(`/api/conversations/${gidAppr}`, { method: 'DELETE', cookie: owner.cookie });
  check('群主解散该群 → 200', dissolve.status === 200 && dissolve.json?.dissolved === true, `status=${dissolve.status}`);
  const afterDissolve = await mcp(token, 'find_groups', { query: titleAppr });
  check('已解散的群不出现在 find_groups', !cardOf(afterDissolve.json, gidAppr),
    `n=${(afterDissolve.json?.groups || []).length}`);
  const joinDissolved = await mcp(token, 'join_group', { conversation_id: gidAppr });
  check('对已解散群 join_group → not_found', joinDissolved.isError === true && joinDissolved.json?.reason_code === 'not_found',
    JSON.stringify(joinDissolved.json));

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
