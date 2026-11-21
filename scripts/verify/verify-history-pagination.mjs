// 消息历史分页（外部评审前端 §4-1）+ 单条消息接口（§4-6）
//
// 背景：接口以前只有正向 since_seq，前端「拉头 100 + 补尾 100」——中间那段永远看不到。
// 修法：后端加 before_seq（seq DESC 取一窗再反转），前端滚到顶部按页翻；
//       另加单条接口给 compact 帧点补用，不再为一条正文拉 200 条。
//
// 覆盖：
//   1. 尾页：limit=50 拿到最新 50 条，seq 升序、无空洞
//   2. 翻页：before_seq = 当前最小 seq → 紧挨着的上一页（不是最老的一页）
//   3. 一直翻到空：所有页拼起来 = 全量消息，不重不漏（这是「中间那段不可见」的回归）
//   4. 单条：按 seq 取到同一条；不存在的 seq → 404
//   5. 非成员：翻页与单条都拿不到（不能靠猜 seq 读别人群）
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-history-pagination.mjs
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOTAL = 70; // 两个发送者各 35 条，避开单人 60 条/分钟限流
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
  return { status: res.status, json, cookie: sid || cookie };
}

async function signup(name) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: `t_${rnd()}@test.dev`, password: 'passw0rd!x', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

async function send(user, conv, body) {
  const r = await api(`/api/conversations/${conv}/messages`, {
    method: 'POST', cookie: user.cookie, body: { body, client_msg_id: crypto.randomUUID() },
  });
  if (r.status !== 200) throw new Error(`发消息失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const main = async () => {
  const A = await signup('分页A');
  const B = await signup('分页B');
  const C = await signup('分页C'); // 不在群里
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '分页验证群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;

  const tag = rnd();
  for (let i = 0; i < TOTAL; i += 1) {
    const user = i % 2 === 0 ? A : B;
    await send(user, gid, `分页消息 ${i} ${tag}`);
  }

  // 1) 尾页：前端是从「会话列表里的 lastSeq - 一窗」开始拉的（接口只有正向 since_seq）
  const convs = await api('/api/conversations', { cookie: A.cookie });
  const conv = (convs.json || []).find((c) => c.id === gid);
  const knownLast = Number(conv?.lastSeq || 0);
  const tail = await api(`/api/conversations/${gid}/messages?since_seq=${Math.max(0, knownLast - 50)}&limit=50`, { cookie: A.cookie });
  let list = tail.json?.messages || [];
  const lastSeq = tail.json?.lastSeq;
  check('尾页：拿到 50 条、最后一条就是会话最新', list.length === 50 && list[list.length - 1].seq === lastSeq, `n=${list.length} lastSeq=${lastSeq}`);
  check(
    '尾页：seq 严格升序（没有空洞/重复）',
    list.every((m, i) => i === 0 || m.seq === list[i - 1].seq + 1),
    `${list[0]?.seq}..${list[list.length - 1]?.seq}`,
  );

  // 2) 翻页：取「紧挨着当前最早一条」的上一页
  const before = list[0].seq;
  const older = await api(`/api/conversations/${gid}/messages?before_seq=${before}&limit=50`, { cookie: A.cookie });
  const olderList = older.json?.messages || [];
  check(
    '翻页：before_seq 返回上一页（紧邻游标，不是最老一页）',
    olderList.length === before - 1 && olderList[olderList.length - 1].seq === before - 1,
    `n=${olderList.length} 最后一条=${olderList[olderList.length - 1]?.seq} before=${before}`,
  );

  // 3) 一直翻到底，拼起来应当等于全量
  const seen = new Set(list.map((m) => m.seq));
  let cursor = olderList.length ? olderList[0].seq : 0;
  for (const m of olderList) seen.add(m.seq);
  let guard = 0;
  while (cursor > 1 && guard < 20) {
    guard += 1;
    const page = await api(`/api/conversations/${gid}/messages?before_seq=${cursor}&limit=50`, { cookie: A.cookie });
    const rows = page.json?.messages || [];
    if (!rows.length) break;
    for (const m of rows) seen.add(m.seq);
    cursor = rows[0].seq;
  }
  const seqs = [...seen].sort((a, b) => a - b);
  check(
    '翻到底：拼起来正好是全量 70 条，不重不漏',
    seqs.length === TOTAL && seqs[0] === 1 && seqs[seqs.length - 1] === lastSeq && seqs.every((s, i) => s === i + 1),
    `unique=${seqs.length} 范围=${seqs[0]}..${seqs[seqs.length - 1]}`,
  );

  // 4) 单条接口（compact 点补用）
  const mid = list[Math.floor(list.length / 2)];
  const one = await api(`/api/conversations/${gid}/messages/${mid.seq}`, { cookie: A.cookie });
  check(
    '单条接口：按 seq 取到同一条正文',
    one.status === 200 && one.json?.message?.seq === mid.seq && one.json.message.body === mid.body,
    `status=${one.status} seq=${one.json?.message?.seq}`,
  );
  const missing = await api(`/api/conversations/${gid}/messages/999999`, { cookie: A.cookie });
  check('单条接口：不存在的 seq → 404', missing.status === 404, `status=${missing.status}`);

  // 5) 非成员
  const cPage = await api(`/api/conversations/${gid}/messages?before_seq=10&limit=10`, { cookie: C.cookie });
  check('非成员翻页 → 403', cPage.status === 403, `status=${cPage.status}`);
  const cOne = await api(`/api/conversations/${gid}/messages/1`, { cookie: C.cookie });
  check('非成员按 seq 单条 → 拿不到（404/403）', cOne.status === 404 || cOne.status === 403, `status=${cOne.status}`);

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
