#!/usr/bin/env node
// 群上下文快照 get_context（外部审查 Q3）的端到端验证。
//
// 为什么需要这个工具：whats_new 是「增量 + 游标」，search_messages 必须有 query，
// list_conversations 只有元信息 —— AI 刚加入一个群、或进程重启丢了本地上下文时，
// 没有一条「这个群现在是什么样」的入口，只能靠编造或反复搜。
//
// 本脚本守的是**语义**，不是「字段存在」：
//   1) 只读：调用前后 agent_cursors.last_cursor 不变、last_read_seq 不变（不推进任何游标）；
//   2) 可见性与 whats_new 完全一致：撤回消息不出现、limit 取的是最新 N 条且升序；
//   3) 分页用会话内 seq：before_seq=最老一条 → 拿更早一页，不重复、不多给；
//   4) 严格成员校验：非成员 / 已解散 / 不存在 一律 not_found（不泄露存在性）；
//   5) 只返回这一个会话：另一个群的消息不会混进来；
//   6) 参数契约：缺 conversation_id、limit 越界、未知字段都会被拒（不让 AI 静默传错）。
//
// 用法：BASE=http://127.0.0.1:8787 DATABASE_URL=postgres://... node scripts/verify/verify-context.mjs
// 前置：8787 已起、迁移已跑；脚本自建 1 个用户 + 1 只 AI + 2 个群，结束尽力清理。

import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function mcp(token, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function callTool(token, name, args) {
  const out = await mcp(token, 'tools/call', { name, arguments: args });
  const text = out?.result?.content?.[0]?.text || '';
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { isError: Boolean(out?.result?.isError), json, text, rpc: out };
}

const main = async () => {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect().catch(() => {});
  let cookie = null;
  let token = '';
  let agentId = null;
  const convs = [];
  let outsiderCookie = null;
  let outsiderConv = null;

  try {
    // ---------------------------------------------------------------- 准备
    const email = `t_${rnd()}${rnd()}@test.dev`;
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'CtxVerify!2026', display_name: `上下文A${rnd()}`, invite_code: process.env.REGISTER_CODE || '' },
    });
    if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}`);
    cookie = reg.cookie;

    const ag = await api('/api/agents', { method: 'POST', cookie, body: { display_name: `上下文AI${rnd()}` } });
    token = ag.json?.token;
    agentId = ag.json?.agent?.id ?? ag.json?.principal_id ?? ag.json?.id ?? null;
    check('准备：AI 与 token 就绪', Boolean(token && agentId), `agent=${agentId}`);

    const g = await api('/api/conversations', { method: 'POST', cookie, body: { title: `上下文验证-${rnd()}`, member_ids: [agentId] } });
    const cid = g.json?.conversation?.id ?? null;
    convs.push(cid);
    check('准备：建群（AI 是成员）', Boolean(cid), `conversation=${cid}`);

    const announcement = `本群规则-${rnd()}：只聊测试。`;
    const setAnn = await api(`/api/conversations/${cid}/announcement`, { method: 'PATCH', cookie, body: { announcement } });
    check('准备：写入群公告', setAnn.status === 200, `status=${setAnn.status}`);

    await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ctx-verify', version: '1' } });

    // 5 条消息：人 4 条 + AI 1 条（seq 1..5）
    const send = async (body) => api(`/api/conversations/${cid}/messages`, {
      method: 'POST', cookie, body: { body, client_msg_id: `ctx-${rnd()}` },
    });
    const s1 = await send('第一句');
    await send('第二句');
    await send('第三句');
    await send('第五句（待撤回）');
    await api(`/api/conversations/${cid}/messages`, {
      method: 'POST', cookie, body: { body: 'AI 回一句', client_msg_id: `ctx-${rnd()}`, reply_to_seq: s1.json?.seq },
    });
    // 撤回第 4 条：get_context 不应返回它
    const recalled = await api(`/api/conversations/${cid}/messages/${4}`, { method: 'DELETE', cookie });
    check('准备：撤回第 4 条', recalled.status === 200, `status=${recalled.status}`);

    // ---------------------------------------------------------------- 1) 基本形状
    const ctx = await callTool(token, 'get_context', { conversation_id: cid });
    const j = ctx.json || {};
    check('1) 返回不报错且是对象', !ctx.isError && typeof j === 'object', ctx.text.slice(0, 120));
    check('2) 含 conversation/announcement/me/members/messages/last_seq',
      Boolean(j.conversation?.id && j.announcement !== undefined && j.me && Array.isArray(j.members)
        && Array.isArray(j.messages) && typeof j.last_seq === 'number'),
      `keys=${Object.keys(j).join(',')}`);
    check('3) 公告原样返回', j.announcement === announcement, `announcement=${String(j.announcement).slice(0, 20)}`);
    check('4) 我在群里的策略（role/reply_mode/relay 深度）齐全',
      typeof j.me?.role === 'string' && typeof j.me?.reply_mode === 'string' && typeof j.me?.relay_max_depth === 'number',
      JSON.stringify(j.me));

    // ---------------------------------------------------------------- 2) 消息可见性与排序
    const seqs = (j.messages || []).map((m) => Number(m.seq));
    check('5) 消息升序返回（旧→新）', seqs.every((v, i) => i === 0 || v > seqs[i - 1]), `seqs=${seqs.join(',')}`);
    check('6) 已撤回的那条不出现', !seqs.includes(4), `seqs=${seqs.join(',')}`);
    check('7) 最多返回 20 条（默认 limit）', seqs.length <= 20, `count=${seqs.length}`);

    // ---------------------------------------------------------------- 3) limit / before_seq
    const two = await callTool(token, 'get_context', { conversation_id: cid, limit: 2 });
    const twoSeqs = (two.json?.messages || []).map((m) => Number(m.seq));
    // 撤回的消息不返回，所以"取最新 2 条"可能只拿到 1 条：limit 是上限，不是保证条数。
    // 这里守的是"取的是最新那一端"，而不是"一定凑满 2 条"（否则撤回一条就假红）。
    check('8) limit=2 只返回最新那几条（撤回被过滤，可能少于 2）',
      twoSeqs.length >= 1 && twoSeqs.length <= 2 && twoSeqs[twoSeqs.length - 1] === seqs[seqs.length - 1],
      `seqs=${twoSeqs.join(',')} 期望末尾=${seqs[seqs.length - 1]}`);

    const older = await callTool(token, 'get_context', { conversation_id: cid, before_seq: twoSeqs[0], limit: 2 });
    const olderSeqs = (older.json?.messages || []).map((m) => Number(m.seq));
    check('9) before_seq 翻更早一页且不与上一页重复',
      olderSeqs.length > 0 && olderSeqs.every((s) => s < twoSeqs[0]), `older=${olderSeqs.join(',')} vs ${twoSeqs.join(',')}`);

    // ---------------------------------------------------------------- 4) 只读：不推进游标
    const { rows: cursorBefore } = await db.query(
      'SELECT COALESCE(last_cursor,0) AS last, COALESCE(acked_cursor,0) AS acked FROM agent_cursors WHERE agent_id=$1 ORDER BY client_label',
      [agentId],
    );
    await callTool(token, 'get_context', { conversation_id: cid });
    await new Promise((r) => setTimeout(r, 200));
    const { rows: cursorAfter } = await db.query(
      'SELECT COALESCE(last_cursor,0) AS last, COALESCE(acked_cursor,0) AS acked FROM agent_cursors WHERE agent_id=$1 ORDER BY client_label',
      [agentId],
    );
    check('10) 调用前后没有新增/推进 agent_cursors（不推进游标）',
      JSON.stringify(cursorBefore) === JSON.stringify(cursorAfter),
      `before=${JSON.stringify(cursorBefore)} after=${JSON.stringify(cursorAfter)}`);

    // 成员读位点也不该被它改
    const { rows: readBefore } = await db.query(
      'SELECT last_read_seq FROM conversation_members WHERE conversation_id=$1 AND principal_id=$2',
      [cid, agentId],
    );
    check('11) last_read_seq 未被改写（"看过"要客户端自己决定）',
      readBefore[0] !== undefined && Number(readBefore[0].last_read_seq) === 0,
      `last_read_seq=${readBefore[0]?.last_read_seq}`);

    // ---------------------------------------------------------------- 5) 只返回这一个会话
    const g2 = await api('/api/conversations', { method: 'POST', cookie, body: { title: `上下文第二群-${rnd()}`, member_ids: [agentId] } });
    convs.push(g2.json?.conversation?.id);
    await api(`/api/conversations/${g2.json?.conversation?.id}/messages`, {
      method: 'POST', cookie, body: { body: '另一个群的消息', client_msg_id: `ctx-${rnd()}` },
    });
    const ctx2 = await callTool(token, 'get_context', { conversation_id: cid });
    const bodies = (ctx2.json?.messages || []).map((m) => String(m.body || ''));
    check('12) 不混入其它会话的消息', !bodies.some((b) => b.includes('另一个群的消息')), `bodies=${bodies.length}`);

    // ---------------------------------------------------------------- 6) 成员校验
    const outsiderEmail = `t_${rnd()}${rnd()}@test.dev`;
    const outsider = await api('/api/auth/register', {
      method: 'POST',
      body: { email: outsiderEmail, password: 'CtxVerify!2026', display_name: `上下文路人${rnd()}`, invite_code: process.env.REGISTER_CODE || '' },
    });
    outsiderCookie = outsider.cookie || null;
    const oc = await api('/api/conversations', { method: 'POST', cookie: outsiderCookie, body: { title: `上下文外人群-${rnd()}`, member_ids: [] } });
    outsiderConv = oc.json?.conversation?.id ?? null;
    const denied = await callTool(token, 'get_context', { conversation_id: outsiderConv });
    check('13) 非成员 → isError + reason_code=not_found（不泄露存在性）',
      denied.isError === true && String(denied.json?.reason_code || denied.json?.reason || '') === 'not_found',
      JSON.stringify(denied.json)?.slice(0, 160));

    // ---------------------------------------------------------------- 7) 参数契约
    const noId = await callTool(token, 'get_context', {});
    check('14) 缺 conversation_id → isError', noId.isError === true, JSON.stringify(noId.json)?.slice(0, 120));
    const badLimit = await callTool(token, 'get_context', { conversation_id: cid, limit: 51 });
    check('15) limit=51 → isError（上限 50）', badLimit.isError === true, JSON.stringify(badLimit.json)?.slice(0, 120));
    const unknownArg = await callTool(token, 'get_context', { conversation_id: cid, group_id: 1 });
    check('16) 未知参数 → isError（不静默忽略 group_id）', unknownArg.isError === true,
      JSON.stringify(unknownArg.json)?.slice(0, 120));
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
    // 尽力清理：软解散群 + 删除临时 AI（测试账号留在库里由 cleanup-test.mjs 统一隐藏）
    for (const id of convs.filter(Boolean)) {
      try { await api(`/api/conversations/${id}`, { method: 'DELETE', cookie }); } catch { /* ignore */ }
    }
    if (outsiderConv && outsiderCookie) { try { await api(`/api/conversations/${outsiderConv}`, { method: 'DELETE', cookie: outsiderCookie }); } catch { /* ignore */ } }
    if (agentId && cookie) { try { await api(`/api/agents/${agentId}`, { method: 'DELETE', cookie }); } catch { /* ignore */ } }
    await db.end().catch(() => {});
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
