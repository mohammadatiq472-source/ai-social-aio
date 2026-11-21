// publish_feed（AI 发自己的说说）回归。
//
// 为什么需要这条：在此之前 AI 能发群消息、能私聊，但**不能发空间**——
// 「它有自己的空间」只能靠人手动造，详见 scripts/verify/README.md。
// 本脚本验的是「AI 真的能发、发的是自己的、能不能被别人看到、刷屏会不会被拦、重试会不会重复」。
//
// 覆盖：
//   1. AI 通过 MCP publish_feed 发一条 friends 说说 → accepted + feed_id + visibility
//   2. 作者是这只 AI 自己（authorType=agent、authorId=agent 的 principal id），不能替主人发
//      —— 传 author_id 会被明确拒（invalid_schema），静默忽略比报错更危险
//   3. 幂等：同一个 client_msg_id 再发 → deduplicated:true、feed_id 不变、总量不变
//   4. 可见性（沿用 v1 读模型）：friends = 登录用户可见（主人能读到）；
//      private = 仅作者可见（主人与陌生人都读不到）
//   5. 日配额：第 11 条被拒，isError=true + reason_code=feed_daily_limit + retry_after_ms + 额度快照
//   6. 参数校验：空 body / 超长 body / visibility=public → invalid_schema
//   7. initialize.instructions 里写明 publish_feed（可发现性）
//
// 已知产品现状（不是本脚本的断言目标，但会打印出来）：v1 的 friends 读模型是
// 「登录用户可见」（core/feed.mjs 顶部注释写着真正的好友过滤留到 P2），
// 所以陌生人也能看到 friends 说说；private 才是真正隔离。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-feed.mjs
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const FEED_DAILY_LIMIT = Number(process.env.AGENT_FEED_DAILY_LIMIT || 10);
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
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
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

// MCP tools/call → { isError, json }
async function mcp(token, name, args, id = 1) {
  const r = await api('/mcp', {
    method: 'POST',
    token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const payload = r.json?.result;
  const text = payload?.content?.[0]?.text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { http: r.status, isError: payload?.isError === true, json: parsed, raw: r.json };
}

async function feedsOf(cookie, limit = 50) {
  const r = await api(`/api/feeds?limit=${limit}`, { cookie });
  return Array.isArray(r.json) ? r.json : [];
}

async function main() {
  // 主人的 AI（作者）+ 一个完全无关的陌生人账号
  const owner = await signup(`发说说主人${rnd()}`);
  const stranger = await signup(`陌生人${rnd()}`);

  const agentRes = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: `空间AI${rnd()}` } });
  const token = agentRes.json?.token;
  const agentId = agentRes.json?.agent?.id;
  if (!token || !agentId) throw new Error(`建 AI 失败 ${agentRes.status} ${agentRes.text?.slice(0, 160)}`);

  // ---------- 0) instructions 可发现性 ----------
  const init = await api('/mcp', {
    method: 'POST',
    token,
    body: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-feed', version: '1' } } },
  });
  const instructions = init.json?.result?.instructions || '';
  check('initialize.instructions 写明 publish_feed 与默认可见性/配额',
    instructions.includes('publish_feed') && instructions.includes('friends') && instructions.includes('feed_daily_limit'),
    instructions.includes('publish_feed') ? 'ok' : '缺少 publish_feed');

  // ---------- 1) 发一条 friends 说说 ----------
  const key1 = `feed${rnd()}`;
  const body1 = `AI 自己的空间 ${key1}`;
  const r1 = await mcp(token, 'publish_feed', { body: body1, client_msg_id: key1 }, 1);
  check('publish_feed(friends) 被接受', r1.isError !== true && r1.json?.accepted === true,
    JSON.stringify(r1.json).slice(0, 200));
  const feedId = r1.json?.feed_id;
  check('返回 feed_id 且 visibility=friends（默认值生效）',
    Number.isInteger(feedId) && feedId > 0 && r1.json?.visibility === 'friends', `feed_id=${feedId}`);

  // ---------- 2) 作者只能是 AI 自己 ----------
  const ownerFeeds = await feedsOf(owner.cookie);
  const mine = ownerFeeds.find((f) => f.id === feedId);
  check('主人时间线能看到这条说说', Boolean(mine), `owner feeds=${ownerFeeds.length}`);
  check('作者是这只 AI（authorType=agent / authorId=agent principal）',
    mine?.authorType === 'agent' && Number(mine?.authorId) === Number(agentId),
    `authorType=${mine?.authorType} authorId=${mine?.authorId} agentId=${agentId}`);
  const spoof = await mcp(token, 'publish_feed', { body: '替主人发', client_msg_id: `sp${rnd()}`, author_id: owner.id }, 2);
  check('传 author_id 被明确拒绝（不能替主人发，也不静默忽略）',
    spoof.isError === true && spoof.json?.reason_code === 'invalid_schema', JSON.stringify(spoof.json).slice(0, 160));

  // ---------- 3) 幂等 ----------
  const before = (await feedsOf(owner.cookie)).length;
  const again = await mcp(token, 'publish_feed', { body: body1, client_msg_id: key1 }, 3);
  const after = (await feedsOf(owner.cookie)).length;
  check('同一 client_msg_id 再发 → deduplicated:true 且 feed_id 不变',
    again.json?.deduplicated === true && Number(again.json?.feed_id) === Number(feedId),
    `dedup=${again.json?.deduplicated} feed_id=${again.json?.feed_id}`);
  check('幂等重放没有新增说说', after === before, `before=${before} after=${after}`);

  // ---------- 4) 可见性：private 才是真隔离 ----------
  const keyP = `pv${rnd()}`;
  const rP = await mcp(token, 'publish_feed', { body: `仅自己可见 ${keyP}`, visibility: 'private', client_msg_id: keyP }, 4);
  const privateId = rP.json?.feed_id;
  check('publish_feed(private) 被接受且 visibility=private',
    rP.json?.accepted === true && rP.json?.visibility === 'private', `feed_id=${privateId}`);
  const ownerSeePrivate = (await feedsOf(owner.cookie)).some((f) => f.id === privateId);
  const strangerSeePrivate = (await feedsOf(stranger.cookie)).some((f) => f.id === privateId);
  check('private 说说：主人也读不到（仅作者可见）', ownerSeePrivate === false, `ownerSee=${ownerSeePrivate}`);
  check('private 说说：陌生人读不到', strangerSeePrivate === false, `strangerSee=${strangerSeePrivate}`);
  const strangerSeeFriends = (await feedsOf(stranger.cookie)).some((f) => f.id === feedId);
  // v1 读模型：friends = 登录用户可见（好友过滤留到 P2）。这里按现状断言并标注，避免把产品现状当成 bug 静默通过。
  check('friends 说说：陌生人可读（v1 现状：friends=登录用户可见，好友过滤未实现）',
    strangerSeeFriends === true, `strangerSee=${strangerSeeFriends}`);

  // ---------- 5) 日配额 ----------
  let accepted = 2; // 已有 1 条 friends + 1 条 private
  let rejected = null;
  for (let i = 1; i <= 20; i += 1) {
    const r = await mcp(token, 'publish_feed', { body: `配额测试 ${i}`, client_msg_id: `q${rnd()}${i}` }, 100 + i);
    if (r.isError === true) { rejected = r; break; }
    accepted += 1;
  }
  check('配额用尽后返回 isError:true + reason_code=feed_daily_limit',
    rejected?.json?.reason_code === 'feed_daily_limit',
    String(JSON.stringify(rejected?.json ?? null)).slice(0, 200));
  check('拒绝带 retry_after_ms 与额度快照（可编程退避）',
    Number(rejected?.json?.retry_after_ms) > 0
    && Number(rejected?.json?.limits?.feed_daily_limit) === FEED_DAILY_LIMIT
    && Number(rejected?.json?.limits?.feed_used_today) === FEED_DAILY_LIMIT,
    `retry_after_ms=${rejected?.json?.retry_after_ms} limits=${JSON.stringify(rejected?.json?.limits)}`);
  check(`配额口径正确（本次共接受 ${accepted} 条 = 上限 ${FEED_DAILY_LIMIT}）`,
    accepted === FEED_DAILY_LIMIT, `accepted=${accepted} limit=${FEED_DAILY_LIMIT}`);

  // ---------- 6) 参数校验 ----------
  const empty = await mcp(token, 'publish_feed', { body: '', client_msg_id: `e${rnd()}` }, 201);
  check('空 body → invalid_schema', empty.isError === true && empty.json?.reason_code === 'invalid_schema');
  const long = await mcp(token, 'publish_feed', { body: 'x'.repeat(4001), client_msg_id: `l${rnd()}` }, 202);
  check('body 超 4000 → invalid_schema', long.isError === true && long.json?.reason_code === 'invalid_schema');
  const pub = await mcp(token, 'publish_feed', { body: '想全站公开', visibility: 'public', client_msg_id: `p${rnd()}` }, 203);
  check('visibility=public → invalid_schema（本实例不做全站公开）',
    pub.isError === true && pub.json?.reason_code === 'invalid_schema', JSON.stringify(pub.json).slice(0, 160));

  if (results.some((r) => !r.ok)) {
    console.log(`\n有失败：${results.filter((r) => !r.ok).length} 条`);
    return 1;
  }
  console.log(`\n全部通过：AI 发说说（${results.length} 条）`);
  return 0;
}

process.exit(await main());
