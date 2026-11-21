// MCP 协议层的两条外部评审修复（P2-2 / P2-5）
//
// P2-2：批量请求无上限 —— 小体积请求（ping）一个 body 能塞上千条，全部在单进程事件循环上
//       串行执行。修复：>50 条直接 400 + JSON-RPC error，正常批量（≤50）不受影响。
// P2-5：whats_new 摘要模式返回后游标已推进，正文只能靠 hint 文案里的 from_seq 找回；
//       文案一改 / agent 上下文被截断就永久丢消息。修复：把 from_seq 作为结果里的显式字段。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-hardening.mjs
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
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

/** 直接发原始 MCP body（批量/单条都能发） */
async function mcpRaw(token, payload) {
  return api('/mcp', { method: 'POST', token, body: payload });
}

async function mcpTool(token, name, args, id = 1) {
  const r = await mcpRaw(token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const text = r.json?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : { httpError: r.status, body: r.json };
}

const main = async () => {
  const A = await signup('加固A');
  const B = await signup('加固B');
  const ag = await api('/api/agents', { method: 'POST', cookie: A.cookie, body: { display_name: '加固AI' } });
  const token = ag.json.token;
  const agentId = ag.json.agent.id;

  // 建群 + 拉 agent 进群（whats_new 需要有会话）
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '加固验证群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;
  await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: A.cookie, body: { principal_id: agentId } });

  // ---------------------------------------------------------------- P2-2 批量上限
  const ping = () => ({ jsonrpc: '2.0', id: 1, method: 'ping' });

  const empty = await mcpRaw(token, []);
  check('空批量 → 400（既有语义没变）', empty.status === 400, `status=${empty.status}`);

  const exactly50 = await mcpRaw(token, Array.from({ length: 50 }, ping));
  check('50 条批量 → 200（上限内的合法客户端不受影响）', exactly50.status === 200, `status=${exactly50.status}`);

  const over = await mcpRaw(token, Array.from({ length: 51 }, ping));
  const errText = JSON.stringify(over.json || {});
  check(
    '51 条批量 → 400 + JSON-RPC error（写明上限）',
    over.status === 400 && errText.includes('50'),
    `status=${over.status} body=${errText.slice(0, 120)}`,
  );

  const huge = await mcpRaw(token, Array.from({ length: 800 }, ping));
  check('800 条 ping 批量 → 400（串行放大被砍掉）', huge.status === 400, `status=${huge.status}`);

  // ---------------------------------------------------------------- P2-5 from_seq 显式字段
  await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie: B.cookie,
    body: { body: `给 AI 的新消息 mark-${rnd()}`, client_msg_id: crypto.randomUUID() },
  });
  const digest = await mcpTool(token, 'whats_new', { since_seq: 0 });
  check(
    'whats_new 摘要：有显式 from_seq 字段（不再只能从 hint 文案里抠）',
    typeof digest.from_seq === 'number' && digest.from_seq === 0 && digest.total >= 1,
    `from_seq=${digest.from_seq} total=${digest.total} next_seq=${digest.next_seq}`,
  );
  check('摘要里仍带 hint（向后兼容）', typeof digest.hint === 'string', String(digest.hint).slice(0, 60));
  check(
    '摘要与明细的游标字段同名（next_seq/has_more，不再是 nextSeq）',
    typeof digest.next_seq === 'number' && typeof digest.has_more === 'boolean',
    `next_seq=${digest.next_seq} has_more=${digest.has_more}`,
  );

  // 用 from_seq 能找回正文（这是该字段存在的意义）
  const detail = await mcpTool(token, 'whats_new', { since_seq: 0, from_seq: digest.from_seq, detail: true, limit: 50 }, 2);
  check(
    '用 from_seq 调 detail 能拿到摘要里那批消息的正文',
    (detail.events || []).length >= 1 && JSON.stringify(detail.events).includes('mark-'),
    `events=${(detail.events || []).length}`,
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
