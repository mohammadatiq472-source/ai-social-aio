// MCP 真实互测发现的三个问题回归（真实客户端反馈，不是拍的）
//
//   1. 含 U+FFFD 的正文必须被拒（命令行 argv 编码坏掉时曾「200 + accepted 但存乱码」）
//   2. may_reply 对自己发的消息必须是 false（否则懒轮询客户端会自嗨）
//   3. may_reply 的接力深度与 group 配置一致；摘要/detail 的游标别名齐全
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-feedback.mjs
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
  return { id: r.json.me.id, cookie: r.cookie };
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
  const owner = await signup('反馈主人');
  const a = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '反馈AI1' } });
  const b = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '反馈AI2' } });
  const g = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: '反馈验证群', member_ids: [a.json.agent.id, b.json.agent.id] },
  });
  const gid = g.json.conversation.id;
  for (const ag of [a, b]) {
    await api(`/api/conversations/${gid}/reply-mode`, {
      method: 'POST', cookie: owner.cookie, body: { principal_id: ag.json.agent.id, reply_mode: 'high', allow_ai_relay: true },
    });
    await api(`/api/agents/${ag.json.agent.id}/limits`, {
      method: 'PATCH', cookie: owner.cookie, body: { bucket_capacity: 20, bucket_refill_per_min: 120, daily_limit: 1000 },
    });
  }
  await api(`/api/conversations/${gid}/agent-settings`, {
    method: 'PATCH', cookie: owner.cookie, body: { round_quota: 10, relay_depth: 4, group_daily_limit: 1000 },
  });

  // 1) 编码坏掉（U+FFFD）必须被拒，而不是「200 + accepted 存乱码」
  const broken = await mcp(a.json.token, 'send_message', {
    conversation_id: gid, body: '中文乱码探针 \uFFFD\uFFFD', client_msg_id: rnd() + rnd(),
  });
  check(
    '含 U+FFFD 的正文被拒（不再静默存乱码）',
    broken.isError === true && broken.json?.reason_code === 'invalid_encoding',
    `isError=${broken.isError} reason_code=${broken.json?.reason_code}`,
  );
  const readBroken = await api(`/api/conversations/${gid}/messages?limit=50`, { cookie: owner.cookie });
  check('坏编码消息没有落库', !(readBroken.json?.messages || []).some((m) => String(m.body).includes('乱码探针')),
    `n=${(readBroken.json?.messages || []).length}`);

  // 2) may_reply：自己发的消息必须是 false
  const seed = await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie: owner.cookie, body: { body: '互相认识一下', client_msg_id: rnd() + rnd() },
  });
  const aSend = await mcp(a.json.token, 'send_message', {
    conversation_id: gid, body: '我是反馈AI1', reply_to_seq: seed.json.seq, client_msg_id: rnd() + rnd(),
  });
  check('准备：AI1 发言成功', aSend.json?.accepted === true, `seq=${aSend.json?.seq}`);

  const aView = await mcp(a.json.token, 'whats_new', { detail: true, since_seq: 0 });
  const own = (aView.json?.events || []).find((e) => Number(e.event_id) === Number(aSend.json?.event_id));
  check('自己的消息 may_reply=false（不触发自嗨）', own && own.may_reply === false, `may_reply=${own?.may_reply}`);

  const bView = await mcp(b.json.token, 'whats_new', { detail: true, since_seq: 0 });
  const fromA = (bView.json?.events || []).find((e) => Number(e.event_id) === Number(aSend.json?.event_id));
  check('别人看到的 may_reply=true（high 档 + relay）', fromA && fromA.may_reply === true, `may_reply=${fromA?.may_reply}`);

  // 3) relay 深度按群配置：depth 4 时，深度 3 的 AI→AI 仍可回
  let lastSeq = aSend.json.seq;
  let who = b;
  const other = a;
  let reachedDepth3 = false;
  for (let i = 0; i < 6; i += 1) {
    const r = await mcp(who.json.token, 'send_message', {
      conversation_id: gid, body: `接力 ${i}`, reply_to_seq: lastSeq, client_msg_id: rnd() + rnd(),
    });
    if (r.json?.accepted !== true) {
      console.log(`  接力在第 ${i} 跳被拒：${r.json?.reason_code}`);
      break;
    }
    lastSeq = r.json.seq;
    if (i >= 2) reachedDepth3 = true;
    who = who === b ? a : b;
  }
  check('relay 深度用群配置（4 层可接力到第 3 跳以上）', reachedDepth3, `lastSeq=${lastSeq}`);

  // 3b) 读侧也要用同一份群配置：第 3 跳的 AI→AI 消息，在 depth=4 的群里必须 may_reply=true。
  //     回归的是「whats_new 的 memberships 没选 agent_relay_max_depth」——那时读侧恒按默认 2 算，
  //     写侧放行的第 3 跳会被读侧标成 may_reply=false，懒轮询客户端会漏回（写侧 12 条断言看不出来）。
  const deepView = await mcp(a.json.token, 'whats_new', { detail: true, since_seq: 0 });
  const deepEvent = (deepView.json?.events || []).find(
    (e) => Number(e.relay_depth || 0) >= 3 && e.sender_type === 'agent' && Number(e.sender_id) !== Number(a.json.agent.id),
  );
  check(
    'may_reply 的 relay 深度用群配置（第 3 跳读侧 = true）',
    Boolean(deepEvent) && deepEvent.may_reply === true,
    deepEvent ? `depth=${deepEvent.relay_depth} may_reply=${deepEvent.may_reply}` : '没有 depth>=3 的 AI 消息',
  );

  // 4) 游标别名与 reason_code：摘要里 from_event_id / conversation_id 都在；无效参数带 reason_code
  const digest = await mcp(a.json.token, 'whats_new', {});
  check(
    '摘要给出 from_event_id + conversations[].conversation_id 别名',
    typeof digest.json?.from_event_id === 'number'
      && Array.isArray(digest.json?.conversations)
      && digest.json.conversations.every((c) => typeof c.conversation_id === 'number'),
    `from_event_id=${digest.json?.from_event_id}`,
  );
  const badArg = await mcp(a.json.token, 'whats_new', { since_seq: -1 });
  check('无效参数也带 reason_code（客户端不用取 reason）', badArg.isError === true && badArg.json?.reason_code === 'invalid_schema',
    `reason_code=${badArg.json?.reason_code}`);

  // 5) 表情：空库要给出下一步；别人的私有包不能被 slug 直接引用
  const empty = await mcp(a.json.token, 'search_stickers', { query: '不存在的关键词zzz' });
  check(
    '空表情库返回 empty + 自建指引（不是只有 []）',
    empty.isError === false && empty.json?.empty === true && typeof empty.json?.hint === 'string' && empty.json.hint.includes('create_sticker_pack'),
    `empty=${empty.json?.empty}`,
  );
  const pack = await mcp(a.json.token, 'create_sticker_pack', { title: '反馈测试包' });
  const packSlug = pack.json?.slug;
  const item = await mcp(a.json.token, 'add_sticker_item', {
    pack_id: pack.json?.pack_id ?? pack.json?.id,
    url: 'https://example.com/s.png',
    key: 'k1',
  });
  check('准备：AI 自建包 + 加图', Boolean(packSlug) && item.isError === false, `slug=${packSlug}`);
  const ownSend = await mcp(a.json.token, 'send_message', {
    conversation_id: gid, body: '', parts: [{ type: 'sticker', pack: packSlug, key: 'k1' }], client_msg_id: rnd() + rnd(),
  });
  check('自己的包可以发（空 body + sticker 段）', ownSend.json?.accepted === true, `reason=${ownSend.json?.reason_code}`);
  const otherSend = await mcp(b.json.token, 'send_message', {
    conversation_id: gid, body: '', parts: [{ type: 'sticker', pack: packSlug, key: 'k1' }], client_msg_id: rnd() + rnd(),
  });
  check(
    '别人拿私有包 slug 直接发 → 被拒（sticker_not_visible，不再静默接受）',
    otherSend.isError === true && otherSend.json?.reason_code === 'sticker_not_visible',
    `isError=${otherSend.isError} reason_code=${otherSend.json?.reason_code}`,
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
