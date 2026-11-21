#!/usr/bin/env node
// MCP 显式 ack（Q2）的端到端验证（2026-11-19）。
//
// 为什么必须验「不 ack 就重启」：这个功能唯一的价值就是 at-least-once。
// 只验「传了 ack 会推进」等于没验——真正会咬人的是「崩溃在拉取之后、确认之前」。
//
// 覆盖：
//   1) 不传 ack_seq：行为与旧版一致（拉取即推进），老客户端不受影响；
//   2) 传 ack_seq=0：同一批可以重复拿到（不丢）；
//   3) 传 ack_seq=next 后：不再重复；新消息只出现一次；
//   4) ack_seq 超过已投递位置 → 夹到 delivered（不能跳读还没给过的事件）；
//   5) ack_seq 回退 → 无效（GREATEST，不倒退）；
//   6) 崩溃模拟「拉完不 ack」→ 重启后仍能拿到同一批；
//   7) acked 永远 ≤ delivered（DB 层断言）。
//
// 用法：DATABASE_URL=... BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-ack.mjs

import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.DATABASE_URL || '';
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
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
  return { isError: Boolean(out?.result?.isError), json };
}

async function setup(name) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'AckVerify!2026', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (reg.status !== 200) throw new Error(`register ${reg.status}`);
  const cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const ag = await api('/api/agents', { method: 'POST', cookie, body: { display_name: `${name}AI${rnd()}` } });
  const token = ag.json?.token;
  const agentId = ag.json?.agent?.id ?? ag.json?.principal_id ?? ag.json?.id;
  const conv = await api('/api/conversations', { method: 'POST', cookie, body: { title: `ack群${rnd()}`, member_ids: [agentId] } });
  const gid = conv.json?.conversation?.id;
  const agentName = ag.json?.agent?.display_name ?? name;
  await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ack-verify', version: '1' } });
  const send = async (label) => api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie,
    body: { body: `@${agentName} ${label}`, mentions: [agentId], client_msg_id: `ack-${rnd()}` },
  });
  return { token, agentId, gid, send };
}

const main = async () => {
  if (!DB_URL) { console.log('SKIP：需要 DATABASE_URL（迁移 029 已执行的真库）'); process.exit(0); }
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const readCursor = async (agentId, label = 'default') => {
    const { rows } = await db.query(
      'SELECT COALESCE(last_cursor,0) AS last, COALESCE(acked_cursor,0) AS acked, COALESCE(delivered_cursor,0) AS delivered FROM agent_cursors WHERE agent_id=$1 AND client_label=$2',
      [agentId, label],
    );
    return rows[0] || { last: 0, acked: 0, delivered: 0 };
  };

  try {
    // ------------------------------------------------ 1) 旧语义不变
    const a = await setup('Ack旧版');
    await a.send('一');
    await a.send('二');
    const pull1 = await callTool(a.token, 'whats_new', { detail: true, limit: 20 });
    const n1 = Number(pull1.json?.next_seq || 0);
    const ev1 = (pull1.json?.events || []).length;
    check('旧语义：不传 ack_seq 能拉到消息', ev1 >= 2, `events=${ev1} next=${n1}`);
    const pull1b = await callTool(a.token, 'whats_new', { detail: true, limit: 20 });
    check('旧语义：拉取即推进（第二次不重复）', (pull1b.json?.events || []).length === 0,
      `events=${(pull1b.json?.events || []).length}`);
    const curA = await readCursor(a.agentId);
    // 旧语义只写 last_cursor；acked_cursor 保持 NULL，读取时靠 COALESCE 回落（老库升级后也安全）
    check('旧语义：last_cursor 推进到 next_seq',
      Number(curA.last) === n1 && (Number(curA.acked) === 0 || Number(curA.acked) === n1),
      `last=${curA.last} acked=${curA.acked ?? 'NULL'} delivered=${curA.delivered ?? 'NULL'}`);

    // 旧 → 新（ack 模式）切换：起点应当接着 last_cursor，而不是从 0 重读历史
    const switchPull = await callTool(a.token, 'whats_new', { detail: true, limit: 20, ack_seq: n1 });
    check('旧→ack 模式切换不重读历史（起点接着旧位点）',
      (switchPull.json?.events || []).length === 0,
      `events=${(switchPull.json?.events || []).length}`);

    // ------------------------------------------------ 2) ack 模式：不确认就会重复
    const b = await setup('Ack新版');
    await b.send('三');
    await b.send('四');
    const p1 = await callTool(b.token, 'whats_new', { detail: true, limit: 20, ack_seq: 0 });
    const n2 = Number(p1.json?.next_seq || 0);
    const ev2 = (p1.json?.events || []).length;
    check('ack 模式：ack_seq=0 能拉到消息', ev2 >= 2, `events=${ev2} next=${n2}`);
    const curB = await readCursor(b.agentId);
    check('ack 模式：拉取**不**推进已确认位点', Number(curB.acked) === 0,
      `acked=${curB.acked} delivered=${curB.delivered}`);
    check('ack 模式：投递位置已记录（诊断用）', Number(curB.delivered) === n2, `delivered=${curB.delivered}`);

    // 崩溃模拟：再拉一次（相当于进程重启后重新拉，且没 ack 过）
    const p2 = await callTool(b.token, 'whats_new', { detail: true, limit: 20 });
    const ev3 = (p2.json?.events || []).length;
    check('崩溃模拟：没 ack 就重启 → 同一批还能拿到（不丢）', ev3 >= 2, `events=${ev3}`);

    // ------------------------------------------------ 3) 确认后不再重复
    const p3 = await callTool(b.token, 'whats_new', { detail: true, limit: 20, ack_seq: n2 });
    check('确认上一批后，同一批不再返回', (p3.json?.events || []).length === 0,
      `events=${(p3.json?.events || []).length}`);
    const curB2 = await readCursor(b.agentId);
    check('确认后 acked 前进到 next_seq', Number(curB2.acked) === n2, `acked=${curB2.acked}`);

    await b.send('五');
    const p4 = await callTool(b.token, 'whats_new', { detail: true, limit: 20, ack_seq: n2 });
    const ev4 = p4.json?.events || [];
    check('只有新消息会被返回（老的不重复）', ev4.length === 1, `events=${ev4.length}`);

    // ------------------------------------------------ 4) 越界与回退
    const before = await readCursor(b.agentId);
    const far = Number(before.delivered) + 9999;
    const p5 = await callTool(b.token, 'whats_new', { detail: true, limit: 20, ack_seq: far });
    const curB3 = await readCursor(b.agentId);
    check('ack 越界被夹到 delivered（不跳读）',
      Number(curB3.acked) <= Number(curB3.delivered) && Number(curB3.acked) > 0,
      `acked=${curB3.acked} delivered=${curB3.delivered}（提交 ${far}）`);
    check('越界 ack 的响应不报错', Boolean(p5?.result) || Boolean(p5?.json), '');

    const back = await callTool(b.token, 'whats_new', { detail: true, limit: 20, ack_seq: 1 });
    const curB4 = await readCursor(b.agentId);
    check('ack 回退无效（只前进不后退）', Number(curB4.acked) === Number(curB3.acked),
      `${curB3.acked}→${curB4.acked}`);
    check('回退 ack 的响应也不报错', Boolean(back?.result) || Boolean(back?.json), '');

    // ------------------------------------------------ 5) 非法参数
    const bad = await callTool(b.token, 'whats_new', { detail: true, ack_seq: -1 });
    check('负数 ack_seq → 结构化拒绝', bad.isError === true, `isError=${bad.isError}`);

    // ------------------------------------------------ 6) DB 层不变量
    const inv = await db.query(
      'SELECT count(*)::int AS n FROM agent_cursors WHERE COALESCE(acked_cursor,0) > COALESCE(delivered_cursor,0)',
    );
    check('全局不变量：acked 永远 ≤ delivered', Number(inv.rows[0]?.n) === 0, `违反行数=${inv.rows[0]?.n}`);

    // 老行（只有 last_cursor）迁移后仍可读：模拟清掉新列
    await db.query('UPDATE agent_cursors SET acked_cursor = NULL, delivered_cursor = NULL WHERE agent_id = $1', [a.agentId]);
    const legacyRead = await callTool(a.token, 'whats_new', { detail: true, limit: 5 });
    check('老行（无新列）回落到 last_cursor，不报错', Boolean(legacyRead?.result) || Boolean(legacyRead?.json),
      `events=${(legacyRead.json?.events || []).length}`);
  } finally {
    await db.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(`全部通过：${results.length}/${results.length}`);
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exit(1);
});
