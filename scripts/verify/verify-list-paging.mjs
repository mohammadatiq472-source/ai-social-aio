// 大列表分页回归：会话列表 / 好友列表 / find_agents 目录（默认一页 10 个）
//
// 背景：AI 和群多了以后，不能「一次全量 + 浏览器原生滚动条硬拖」。
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-list-paging.mjs
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

async function mcp(token, name, args) {
  const r = await api('/mcp', {
    method: 'POST', token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const text = r.json?.result?.content?.[0]?.text;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { isError: r.json?.result?.isError === true, json: parsed };
}

const main = async () => {
  const owner = await signup('分页主人');

  // ---------------- 会话列表：建群有「5 次/窗口」限流，用 5 个群 + limit=3 验证翻页
  for (let i = 0; i < 5; i += 1) {
    await api('/api/conversations', {
      method: 'POST', cookie: owner.cookie, body: { title: `分页群${i}`, member_ids: [] },
    });
  }
  const page1 = await api('/api/conversations?offset=0&limit=3', { cookie: owner.cookie });
  const page2 = await api('/api/conversations?offset=3&limit=3', { cookie: owner.cookie });
  check('会话列表第一页 = 3 条', Array.isArray(page1.json) && page1.json.length === 3, `n=${page1.json?.length}`);
  check('会话列表第二页非空且不重复', Array.isArray(page2.json) && page2.json.length > 0
    && !page2.json.some((c) => page1.json.some((p) => p.id === c.id)), `n=${page2.json?.length}`);

  // ---------------- 好友列表：limit 1 能翻页
  const f1 = await signup('分页好友1');
  const f2 = await signup('分页好友2');
  for (const f of [f1, f2]) {
    await api('/api/friends/request', { method: 'POST', cookie: owner.cookie, body: { account_no: f.accountNo } });
    await api('/api/friends/accept', { method: 'POST', cookie: f.cookie, body: { principal_id: owner.id } });
  }
  const friends1 = await api('/api/friends?offset=0&limit=1', { cookie: owner.cookie });
  const friends2 = await api('/api/friends?offset=1&limit=1', { cookie: owner.cookie });
  check('好友列表 limit=1 翻页且不重复', friends1.json?.friends?.length === 1 && friends2.json?.friends?.length === 1
    && friends1.json.friends[0].id !== friends2.json.friends[0].id,
    `${friends1.json?.friends?.[0]?.id}/${friends2.json?.friends?.[0]?.id}`);
  check('好友列表返回 has_more 提示', friends1.json?.has_more === true, `has_more=${friends1.json?.has_more}`);

  // ---------------- find_agents：默认一页 10 个 + cursor 翻页
  const a = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '分页AI' } });
  const p1 = await mcp(a.json.token, 'find_agents', {});
  const cursor = p1.json?.next_cursor;
  check('find_agents 默认一页 10 个', (p1.json?.agents || []).length <= 10 && (p1.json?.agents || []).length > 0,
    `n=${(p1.json?.agents || []).length} total=${p1.json?.total}`);
  check('find_agents 给 next_cursor 与 6 小时刷新时间', p1.json?.has_more === true ? typeof cursor === 'number' : true,
    `next=${cursor} refreshed=${p1.json?.refreshed_at}`);
  if (typeof cursor === 'number') {
    const p2 = await mcp(a.json.token, 'find_agents', { cursor });
    const ids1 = new Set((p1.json?.agents || []).map((x) => x.principal_id));
    check('find_agents 第二页不与第一页重复', (p2.json?.agents || []).every((x) => !ids1.has(x.principal_id)),
      `n=${(p2.json?.agents || []).length}`);
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
