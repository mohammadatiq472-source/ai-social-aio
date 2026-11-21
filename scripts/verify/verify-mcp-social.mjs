// AI 社交能力回归：好友（请求/接受/发现）、私聊（c2c）、表情包分享、Agent 上传、token 单把吊销。
//
// 顺序有讲究：吊销 token 会废掉当前这把钥匙，必须放最后；其它用例都复用它。
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-social.mjs
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

const main = async () => {
  const owner = await signup('社交主人');
  const stranger = await signup('社交路人');
  const a = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '社交AI1' } });
  const b = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '社交AI2' } });
  const ta = a.json.token;
  const tb = b.json.token;
  const g = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: '社交验证群', member_ids: [a.json.agent.id, b.json.agent.id] },
  });
  const gid = g.json.conversation.id;
  for (const ag of [a, b]) {
    await api(`/api/conversations/${gid}/reply-mode`, {
      method: 'POST', cookie: owner.cookie, body: { principal_id: ag.json.agent.id, reply_mode: 'high', allow_ai_relay: true },
    });
    await api(`/api/agents/${ag.json.agent.id}/limits`, {
      method: 'PATCH', cookie: owner.cookie, body: { bucket_capacity: 30, bucket_refill_per_min: 120, daily_limit: 1000 },
    });
  }
  await api(`/api/conversations/${gid}/agent-settings`, {
    method: 'PATCH', cookie: owner.cookie, body: { round_quota: 20, relay_depth: 6, group_daily_limit: 1000 },
  });

  // ================================================================ 1) 好友
  const empty = await mcp(ta, 'list_friends', {});
  check('初始没有好友', empty.isError === false && (empty.json?.friends || []).length === 0, `n=${(empty.json?.friends || []).length}`);

  const req = await mcp(ta, 'add_friend', { principal_id: b.json.agent.id });
  check('AI 向同群 AI 发起好友请求 → pending', req.isError === false && req.json?.accepted === false, `accepted=${req.json?.accepted}`);
  const bPending = await mcp(tb, 'list_friends', {});
  check('对方能看到待处理请求', (bPending.json?.pending_requests || []).some((p) => Number(p.id) === Number(a.json.agent.id)),
    JSON.stringify((bPending.json?.pending_requests || []).map((p) => p.id)));
  const accept = await mcp(tb, 'accept_friend', { principal_id: a.json.agent.id });
  check('对方接受后成为好友', accept.isError === false && accept.json?.accepted === true, `reason=${accept.json?.reason_code}`);
  const aFriends = await mcp(ta, 'list_friends', {});
  check('发起方看到好友', (aFriends.json?.friends || []).some((f) => Number(f.id) === Number(b.json.agent.id)), `n=${(aFriends.json?.friends || []).length}`);

  // 开放范围：可发现的人类也可以被 AI 加好友（仍需对方接受）
  const coldDiscoverable = await mcp(ta, 'add_friend', { principal_id: stranger.id });
  check('可发现的人类可以被 AI 加好友（范围已开放）', coldDiscoverable.isError === false && coldDiscoverable.json?.accepted === false,
    `reason=${coldDiscoverable.json?.reason_code}`);
  // 关掉「可被发现」+ 不同群 + 非主人 → 403
  await api('/api/me/discoverable', { method: 'POST', cookie: stranger.cookie, body: { discoverable: false } });
  const stranger2 = await signup('不可见路人');
  await api('/api/me/discoverable', { method: 'POST', cookie: stranger2.cookie, body: { discoverable: false } });
  const cold = await mcp(ta, 'add_friend', { principal_id: stranger2.id });
  check(
    '不可发现的陌生人（人类、不同群、非主人）→ 被拒（forbidden / not_discoverable）',
    cold.isError === true && ['forbidden', 'not_discoverable'].includes(cold.json?.reason),
    `reason=${cold.json?.reason}`,
  );

  // Q5（2026-11-19 修）：主人关掉「可发现」后，自己的 AI 仍然要能加主人。
  // 「可发现」关的是「被陌生人搜到」，不是「不认自己的 AI」——以前主人豁免算在拦截之后，
  // 导致主人一关开关，新接入的 AI 连主人都加不上（首次接入必踩）。
  const ownerOffAi = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '主人关灯AI' } });
  const tOwnerOff = ownerOffAi.json?.token;
  await api('/api/me/discoverable', { method: 'POST', cookie: owner.cookie, body: { discoverable: false } });
  const toOwnerWhenHidden = await mcp(tOwnerOff, 'add_friend', { principal_id: owner.id });
  check(
    '主人关闭可发现后，自己的 AI 仍能向主人发起好友请求',
    toOwnerWhenHidden.isError === false,
    `isError=${toOwnerWhenHidden.isError} reason=${toOwnerWhenHidden.json?.reason_code}`,
  );
  await api('/api/me/discoverable', { method: 'POST', cookie: owner.cookie, body: { discoverable: true } });

  // ================================================================ 2) 发现（新窗口没有群也能找到同伴）
  const c = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '社交AI3' } });
  const tc = c.json.token;
  const foundAgents = await mcp(tc, 'find_agents', { query: '社交AI2' });
  const foundId = (foundAgents.json?.agents || []).find((g2) => g2.display_name === '社交AI2')?.principal_id;
  check('find_agents 能搜到其他可发现 AI（无群也能找）', Boolean(foundId),
    JSON.stringify((foundAgents.json?.agents || []).map((g2) => g2.display_name)));
  if (foundId) {
    const coldAgent = await mcp(tc, 'add_friend', { principal_id: foundId });
    check('向可发现 AI 冷发起好友请求 → 允许（仍需对方接受）', coldAgent.isError === false && coldAgent.json?.accepted === false,
      `reason=${coldAgent.json?.reason_code}`);
  }

  // 新人窗口：两个刚注册的 AI 应该能通过 find_agents 互相看到（目录 6h 缓存的补丁）
  const n1 = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '新人甲' } });
  const n2 = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '新人乙' } });
  const seen = await mcp(n1.json.token, 'find_agents', { query: '新人乙' });
  check('刚注册的 AI 能被 find_agents 搜到（新人互相可见）', (seen.json?.agents || []).some((g3) => g3.display_name === '新人乙'),
    JSON.stringify((seen.json?.agents || []).map((g3) => g3.display_name)));

  // ================================================================ 3) 私聊
  // 开放范围：好友之间默认可以私聊（can_initiate_dm 只挡「陌生人冷启动」）
  const dmFriend = await mcp(ta, 'dm', { principal_id: b.json.agent.id, body: '私聊你好', client_msg_id: rnd() + rnd() });
  check('好友之间可以直接私聊（不受 can_initiate_dm 限制）', dmFriend.json?.accepted === true, `reason=${dmFriend.json?.reason_code}`);
  const dmStranger = await mcp(ta, 'dm', { principal_id: stranger2.id, body: '陌生人私聊', client_msg_id: rnd() + rnd() });
  check('陌生非好友私聊 → 403', dmStranger.isError === true && dmStranger.json?.reason === 'forbidden', `reason=${dmStranger.json?.reason}`);

  const dmOwner = await mcp(ta, 'dm', { principal_id: owner.id, body: '主人好，这是私聊', client_msg_id: rnd() + rnd() });
  check('可以私聊自己的主人（不受 can_initiate_dm 限制）', dmOwner.json?.accepted === true, `reason=${dmOwner.json?.reason_code}`);
  const dmGid = dmOwner.json?.conversation_id;


  if (dmGid) {
    const ownerList = await api('/api/conversations', { cookie: owner.cookie });
    const c2c = (ownerList.json || []).find((x) => Number(x.id) === Number(dmGid));
    check('私聊会话是 c2c 类型', c2c?.type === 'c2c', `type=${c2c?.type}`);
    const reply = await api(`/api/conversations/${dmGid}/messages`, {
      method: 'POST', cookie: owner.cookie, body: { body: '收到，主人回复', client_msg_id: rnd() + rnd() },
    });
    check('私聊里人类能回', reply.status === 200, `status=${reply.status}`);
    const aRead = await mcp(ta, 'whats_new', { detail: true, since_seq: 0, conversation_ids: [Number(dmGid)] });
    check('AI 能在私聊里读到回复', (aRead.json?.events || []).length >= 1, `n=${(aRead.json?.events || []).length}`);
  }

  // ================================================================ 4) 表情包分享
  const pack = await mcp(ta, 'create_sticker_pack', { title: '社交测试包' });
  const packId = pack.json?.pack_id;
  const slug = pack.json?.slug;
  await mcp(ta, 'add_sticker_item', { pack_id: packId, url: 'https://example.com/social.png', key: 'k1' });

  const before = await mcp(tb, 'send_message', {
    conversation_id: gid, body: '', parts: [{ type: 'sticker', pack: slug, key: 'k1' }], client_msg_id: rnd() + rnd(),
  });
  check('分享前别人用私有包 → sticker_not_visible', before.isError === true && before.json?.reason_code === 'sticker_not_visible',
    `reason_code=${before.json?.reason_code}`);

  const share = await mcp(ta, 'share_sticker_pack', { pack_id: packId, conversation_id: gid });
  check('分享到群 → 200', share.isError === false && share.json?.accepted === true, `reason=${share.json?.reason_code}`);

  const found = await mcp(tb, 'search_stickers', { query: '社交' });
  check('同群 AI 能搜到分享后的包（按包名）', (found.json?.stickers || []).some((s) => s.pack === slug), `n=${(found.json?.stickers || []).length}`);
  const after = await mcp(tb, 'send_message', {
    conversation_id: gid, body: '', parts: [{ type: 'sticker', pack: slug, key: 'k1' }], client_msg_id: rnd() + rnd(),
  });
  check('分享后别人能发这个包', after.json?.accepted === true, `reason=${after.json?.reason_code}`);

  // ================================================================ 4.5) 人类发起私聊
  const humanDm = await api('/api/conversations/dm', { method: 'POST', cookie: owner.cookie, body: { principal_id: b.json.agent.id } });
  check('人类可以发起与 AI 的私聊（返回 c2c 会话）', humanDm.status === 200 && Number(humanDm.json?.conversation_id) > 0,
    `status=${humanDm.status} conv=${humanDm.json?.conversation_id}`);

  // ================================================================ 5) Agent 上传（Bearer + 原始字节）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(`${BASE}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ta}`, 'content-type': 'image/png' },
    body: png,
  });
  const upJson = await up.json().catch(() => null);
  const attId = Number(upJson?.attachment?.id ?? upJson?.attachment_id ?? upJson?.id);
  check('Agent 用 Bearer 上传图片 → 200 + attachment_id', up.status === 200 && attId > 0, `status=${up.status}`);
  if (attId) {
    const imgMsg = await mcp(ta, 'send_message', {
      conversation_id: gid, body: '', parts: [{ type: 'image', attachment_id: attId }], client_msg_id: rnd() + rnd(),
    });
    check('上传的图片能作为 image 段发出', imgMsg.json?.accepted === true, `reason=${imgMsg.json?.reason_code}`);
  }

  // ================================================================ 5.5) 搜索 / 表情 caption / 主人提示
  const search = await mcp(ta, 'search_messages', { query: '主人好' });
  check('search_messages 能搜到自己看得到的历史消息', (search.json?.results || []).length >= 1,
    `n=${(search.json?.results || []).length}`);
  const limits = await mcp(ta, 'my_limits', {});
  check('my_limits 带主人信息与「找主人」提示', Boolean(limits.json?.owner?.principal_id) && typeof limits.json?.hint === 'string'
    && limits.json.hint.includes('dm('), `owner=${limits.json?.owner?.principal_id}`);

  const pack2 = await mcp(ta, 'create_sticker_pack', { title: '字幕包' });
  const slug2 = pack2.json?.slug;
  await mcp(ta, 'add_sticker_item', { pack_id: pack2.json?.pack_id, url: 'https://example.com/cap.png', key: 'cap', caption: '有字幕的表情' });
  const stickerSend = await mcp(ta, 'send_message', {
    conversation_id: gid, body: '', parts: [{ type: 'sticker', pack: slug2, key: 'cap' }], client_msg_id: rnd() + rnd(),
  });
  const readBack = await mcp(tb, 'whats_new', { detail: true, since_seq: 0, conversation_ids: [Number(gid)] });
  const stickerEvent = (readBack.json?.events || []).find((e) => Number(e.event_id) === Number(stickerSend.json?.event_id));
  const caption = (stickerEvent?.parts || []).find((p) => p.type === 'sticker')?.caption;
  check('表情段发送时回灌 item 的 caption', caption === '有字幕的表情', `caption=${caption}`);

  // ================================================================ 5.6) 查看 / 退群（P2）
  // 「查看」：list_conversations 要能看出自己在哪些群、什么角色（不需要新工具）
  const viewable = await mcp(tb, 'list_conversations', {});
  const mine = (viewable.json?.conversations || []).find((c) => Number(c.id) === Number(gid));
  check('AI 能查看自己在哪些群（type/role/last_seq 齐全）',
    Boolean(mine) && mine.type === 'group' && mine.role === 'member' && Number.isFinite(Number(mine.last_seq)),
    JSON.stringify(mine || {}).slice(0, 160));

  const leaveG = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: `退群验证${rnd()}`, member_ids: [b.json.agent.id] },
  });
  const leaveGid = Number(leaveG.json?.conversation?.id);
  // 默认关闭：主人没点头时必须是拒绝，不能静默把 AI 从群里摘掉
  const denied = await mcp(tb, 'leave_group', { conversation_id: leaveGid });
  check('AI 退群默认关闭（主人未授权）→ isError + leave_not_allowed',
    denied.isError === true && denied.json?.reason_code === 'leave_not_allowed', JSON.stringify(denied.json));
  const stillIn = await mcp(tb, 'list_conversations', {});
  check('被拒后仍是成员（不会半退）',
    (stillIn.json?.conversations || []).some((c) => Number(c.id) === leaveGid));

  const allowLeave = await api(`/api/agents/${b.json.agent.id}/leave`, {
    method: 'PATCH', cookie: owner.cookie, body: { allow: true },
  });
  check('主人打开「允许退群」→ 200 + canLeaveGroup:true',
    allowLeave.status === 200 && allowLeave.json?.canLeaveGroup === true, `status=${allowLeave.status}`);
  const left = await mcp(tb, 'leave_group', { conversation_id: leaveGid });
  check('AI 退群成功 → left:true + event_id（events 里有 MemberRemoved）',
    left.isError === false && left.json?.left === true && Number(left.json?.event_id) > 0, JSON.stringify(left.json));
  const afterLeft = await mcp(tb, 'list_conversations', {});
  check('退群后会话列表不再包含该群',
    !(afterLeft.json?.conversations || []).some((c) => Number(c.id) === leaveGid));
  const leaveAgain = await mcp(tb, 'leave_group', { conversation_id: leaveGid });
  check('已退的群再 leave_group → not_found（幂等语义，不是 500）',
    leaveAgain.isError === true && leaveAgain.json?.reason_code === 'not_found', JSON.stringify(leaveAgain.json));

  // ================================================================ 6) token：一个窗口一把，单独吊销（放最后）
  const login2 = await api('/api/agents/login', {
    method: 'POST', body: { account_no: a.json.agent.accountNo, password: a.json.login?.password || '' },
  });
  const token2 = login2.json?.token;
  const listTokens = await api(`/api/agents/${a.json.agent.id}/tokens`, { cookie: owner.cookie });
  check('token 列表能看到多把钥匙', (listTokens.json?.tokens || []).length >= 2, `n=${(listTokens.json?.tokens || []).length}`);
  const defaultToken = (listTokens.json?.tokens || []).find((t) => t.label === 'default' && t.active);
  const revoke = await api(`/api/agents/${a.json.agent.id}/tokens/${defaultToken?.id}`, { method: 'DELETE', cookie: owner.cookie });
  check('可以单独吊销一把钥匙', revoke.status === 200, `status=${revoke.status}`);
  const revokedUse = await mcp(ta, 'list_friends', {});
  const stillOk = await mcp(token2, 'list_friends', {});
  check('吊销的钥匙失效（401）、新钥匙仍可用', revokedUse.status === 401 && stillOk.isError === false,
    `revokedStatus=${revokedUse.status} kept=${stillOk.isError}`);

  // ================================================================ 7) AI 自助注册（默认关闭）
  const signupProbe = await api('/api/agents/signup', { method: 'POST', body: { invite_code: 'wrong-code', display_name: '自助AI' } });
  // 未配置时 404 not_enabled；配置了但对错邀请码 403 invalid_invite。两种都算「没有正确邀请码进不来」。
  check(
    '自助注册没有正确邀请码进不来（404 未开启 / 403 邀请码错）',
    (signupProbe.status === 404 && signupProbe.json?.error === 'not_enabled')
      || (signupProbe.status === 403 && signupProbe.json?.error === 'invalid_invite'),
    `status=${signupProbe.status} ${signupProbe.json?.error}`,
  );

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
