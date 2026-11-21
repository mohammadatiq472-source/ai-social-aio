// 消息搜索回归（迁移 013 + GET /api/search/messages）
//
// 覆盖的契约：
//   1. 只搜「我可见的会话」：自己群里的词能搜到，别人群里的独有词搜不到
//   2. 中文可搜（2 字 / 3 字 / 多字），大小写不敏感（ILIKE）
//   3. conversation_id 过滤不能变成越权口子（拿别人的群 id 过滤 → 空结果）
//   4. 跨会话分页游标 before_event_id：不重不漏
//   5. 关键词里的 % _ 是字面量，不是 SQL 通配符（否则搜 % 会返回全表）
//   6. 撤回的消息不再出现在结果里
//   7. 命中片段：长消息只回命中附近的片段（首尾带 …），不是整段 4000 字
//   8. 前端跳转契约：拿到结果的 seq 后，用 messages?since_seq=seq-1 能取到那条
//   9. 空 q 返回空结果（200），未登录 401，限流 30 次/分钟 → 429
//
// 用法：BASE=https://chat.example.com node scripts/verify/verify-search.mjs
// 只依赖内置 fetch（Node 18+）；会在库里留下「搜索A/B/C」账号，用 scripts/cleanup-test.mjs 清理。
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, cookie: sid || cookie };
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

async function befriend(a, b) {
  const r1 = await api('/api/friends/request', { method: 'POST', cookie: a.cookie, body: { account_no: b.accountNo } });
  const r2 = await api('/api/friends/accept', { method: 'POST', cookie: b.cookie, body: { principal_id: a.id } });
  if (r1.status !== 200 || r2.status !== 200) throw new Error(`加好友失败 ${r1.status}/${r2.status}`);
}

async function newGroup(owner, title, members) {
  const r = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title, member_ids: members } });
  if (r.status !== 200) throw new Error(`建群失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.conversation.id;
}

async function say(user, conversationId, body) {
  const r = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    cookie: user.cookie,
    body: { body, client_msg_id: crypto.randomUUID() },
  });
  if (r.status !== 200) throw new Error(`发消息失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const search = (user, params) => {
  const qs = new URLSearchParams(params).toString();
  return api(`/api/search/messages?${qs}`, { cookie: user?.cookie });
};

const main = async () => {
  // ---------------------------------------------------------------- 准备
  const A = await signup('搜索A');
  const B = await signup('搜索B');
  const C = await signup('搜索C');
  await befriend(A, B);
  await befriend(B, C);

  const gid1 = await newGroup(A, '搜索验证群', [B.id]);      // A、B 在，C 不在
  const gid2 = await newGroup(B, '别人的群', [C.id]);         // B、C 在，A 不在

  const token1 = `srch${rnd()}`;          // 本群独有
  const token2 = `mid${rnd()}`;           // 长消息中间命中
  const token3 = `pct${rnd()}`;           // 含字面量 %
  const token4 = `gone${rnd()}`;          // 待撤回
  const token5 = `other${rnd()}`;         // 别人群独有

  await say(A, gid1, `甲组独有词 ${token1}`);
  const mCjk = await say(A, gid1, `中文关键词：超自然行动组 ${token1}`);
  await say(B, gid1, `回复 ${token1} 收到`);
  const mLong = await say(A, gid1, `${'前'.repeat(60)}${token2}${'后'.repeat(200)}`);
  await say(A, gid1, `流量 100% 正常 ${token3}`);
  const mGone = await say(A, gid1, `待撤回 ${token4}`);
  await say(B, gid2, `乙组独有词 ${token5}`);

  // 撤回自己 2 分钟内的消息（规则在 submit 里）
  const recall = await api(`/api/conversations/${gid1}/messages/${mGone.seq}`, { method: 'DELETE', cookie: A.cookie });
  check('准备：撤回消息成功', recall.status === 200, `status=${recall.status}`);

  // ---------------------------------------------------------------- 1. 可见性
  const own = await search(A, { q: token1 });
  check(
    '自己群里的词能搜到（3 条，全在 gid1）',
    own.status === 200 && own.json.results.length === 3 && own.json.results.every((r) => r.conversationId === gid1),
    `status=${own.status} n=${own.json?.results?.length} ids=${own.json?.results?.map((r) => r.conversationId).join(',')}`,
  );
  check(
    '结果字段齐全（seq/conversationTitle/senderName/body/createdAt）',
    own.json.results.every((r) => r.seq > 0 && r.conversationTitle === '搜索验证群' && r.senderName && r.body.includes(token1) && r.createdAt),
    JSON.stringify(own.json.results[0] || {}),
  );

  const other = await search(A, { q: token5 });
  check('别人群里的独有词搜不到', other.status === 200 && other.json.results.length === 0, `n=${other.json?.results?.length}`);

  // 反向确认：B 在 gid2 里能搜到（排除「索引没建好所以谁都搜不到」的假通过）
  const otherByB = await search(B, { q: token5 });
  check('同一条词对群内成员可见（B 能搜到）', otherByB.json?.results?.length === 1, `n=${otherByB.json?.results?.length}`);

  // ---------------------------------------------------------------- 2. 中文 / 大小写
  const cjk3 = await search(A, { q: '超自然行' });
  check('中文 3 字能搜到', cjk3.json?.results?.length >= 1 && cjk3.json.results[0].conversationId === gid1, `n=${cjk3.json?.results?.length}`);
  const cjk2 = await search(A, { q: '行动' });
  check('中文 2 字能搜到', cjk2.json?.results?.length >= 1, `n=${cjk2.json?.results?.length}`);
  const upper = await search(A, { q: token1.toUpperCase() });
  check('大小写不敏感', upper.json?.results?.length === 3, `n=${upper.json?.results?.length}`);

  // ---------------------------------------------------------------- 3. conversation_id 过滤
  const scopedOwn = await search(A, { q: token1, conversation_id: gid1 });
  check('conversation_id 指定本群：3 条', scopedOwn.json?.results?.length === 3, `n=${scopedOwn.json?.results?.length}`);
  const scopedOther = await search(A, { q: token1, conversation_id: gid2 });
  check('conversation_id 指定别人群：空（不能越权）', scopedOther.status === 200 && scopedOther.json.results.length === 0, `n=${scopedOther.json?.results?.length}`);

  // ---------------------------------------------------------------- 4. 分页游标
  const page1 = await search(A, { q: token1, limit: 2 });
  const page2 = await search(A, { q: token1, limit: 2, before_event_id: page1.json?.nextBeforeEventId ?? 0 });
  const ids1 = (page1.json?.results || []).map((r) => r.seq);
  const ids2 = (page2.json?.results || []).map((r) => r.seq);
  check(
    '分页：limit=2 第一页 2 条 + hasMore + 游标',
    page1.json?.results?.length === 2 && page1.json.hasMore === true && page1.json.nextBeforeEventId > 0,
    `n=${page1.json?.results?.length} hasMore=${page1.json?.hasMore}`,
  );
  check(
    '分页：第二页不重不漏（1 条，与第一页无交集）',
    page2.json?.results?.length === 1 && ids2.every((s) => !ids1.includes(s)),
    `p1=${ids1.join(',')} p2=${ids2.join(',')}`,
  );

  // ---------------------------------------------------------------- 5. 通配符转义
  const pct = await search(A, { q: '%' });
  check(
    '搜 %% 是字面量（只命中含 % 的那条，不是全表）',
    pct.json?.results?.length === 1 && pct.json.results[0].body.includes('%'),
    `n=${pct.json?.results?.length}`,
  );
  const underscore = await search(A, { q: '_' });
  check('搜 _ 也是字面量（没有下划线就空）', underscore.json?.results?.length === 0, `n=${underscore.json?.results?.length}`);

  // ---------------------------------------------------------------- 6. 撤回
  const gone = await search(A, { q: token4 });
  check('撤回的消息不出现在结果里', gone.json?.results?.length === 0, `n=${gone.json?.results?.length}`);

  // ---------------------------------------------------------------- 7. 命中片段
  const mid = await search(A, { q: token2 });
  const snippet = mid.json?.results?.[0]?.body || '';
  check(
    '长消息只回命中片段（含关键词、首尾省略号、长度 ≤100）',
    mid.json?.results?.length === 1 && snippet.includes(token2) && snippet.startsWith('…') && snippet.endsWith('…') && snippet.length <= 100,
    `len=${snippet.length} head=${snippet.slice(0, 8)} tail=${snippet.slice(-4)}`,
  );

  // ---------------------------------------------------------------- 8. 跳转契约
  const target = mid.json.results[0];
  const around = await api(`/api/conversations/${target.conversationId}/messages?since_seq=${target.seq - 1}&limit=5`, {
    cookie: A.cookie,
  });
  check(
    '跳转契约：since_seq=seq-1 能取到目标那条（前端 loadAround 依赖）',
    around.status === 200 && (around.json.messages || []).some((m) => m.seq === target.seq && m.body.includes(token2)),
    `status=${around.status}`,
  );

  // ---------------------------------------------------------------- 9. 边界
  const anon = await api('/api/search/messages?q=test');
  check('未登录 → 401', anon.status === 401, `status=${anon.status}`);
  const emptyQ = await search(A, { q: '   ' });
  check('空 q → 200 空结果（不打库）', emptyQ.status === 200 && emptyQ.json.results.length === 0, `status=${emptyQ.status}`);
  const longQ = await search(A, { q: 'x'.repeat(80) });
  check('超长 q（80 字）被截断后仍 200', longQ.status === 200, `status=${longQ.status}`);
  const bigLimit = await search(A, { q: token1, limit: 999 });
  check('limit=999 被夹到 ≤30', bigLimit.status === 200 && bigLimit.json.results.length <= 30, `n=${bigLimit.json?.results?.length}`);

  // 限流：C 单独用，避免污染前面的断言（30 次/分钟）
  let ok200 = 0;
  let got429 = false;
  for (let i = 0; i < 32; i += 1) {
    const r = await search(C, { q: token1 });
    if (r.status === 200) ok200 += 1;
    else if (r.status === 429) got429 = true;
  }
  check('限流：每分钟 30 次后返回 429', got429 && ok200 === 30, `200=${ok200} 429=${got429}`);

  // ---------------------------------------------------------------- 汇总
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
