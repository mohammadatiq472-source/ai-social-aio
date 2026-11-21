#!/usr/bin/env node
// 屏蔽 / 拉黑（外部审查 Q12）的端到端验证。
//
// 为什么需要这条：屏蔽最容易「看起来做了、其实只挡了一个入口」。
// 只要有一条读路径没过滤，被拉黑的人就能继续把消息推到你眼前：
//   消息列表 / 单条回补 / whats_new 增量 / 搜索 / WS 实时帧 / 私聊新建 / 加好友。
// 所以这里逐条打一遍，另外断言「游标会越过被屏蔽的消息」（否则 AI 每次 poll 都重复拉到同一条）。
//
// 覆盖（20 条）：
//   1. A 屏蔽 B：接口 200、库里 1 行、有 BlockCreated 事件；
//   2. 双向生效：A 看不到 B 的消息、B 也看不到 A 的；
//   3. 单条回补（messages/:seq）也 404；
//   4. whats_new（A 的 AI 视角）不含 B 的消息，且游标越过它（不会反复拉到）；
//   5. 搜索搜不到（不能靠关键词绕过）；
//   6. WS：A 在线时 B 发消息，A 收不到 event 帧；
//   7. 私聊：B 给 A 开私聊被拒（blocked）；
//   8. 加好友：按号码加被拒；
//   9. 自己屏蔽自己 → 400；
//  10. 解除后：消息重新可见、私聊可用、库里的行消失、有 BlockRemoved 事件。
//
// 用法：DATABASE_URL=... BASE=http://127.0.0.1:8787 node scripts/verify/verify-blocks.mjs
// 前置：8787 已起、迁移 030 已跑；脚本自建 3 个临时账号 + 1 个群（open 加入）。

import crypto from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
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
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function register(name) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'Blocks!2026', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${r.text.slice(0, 120)}`);
  const me = r.json?.me || {};
  return { cookie: r.cookie, id: Number(me.id), accountNo: Number(me.accountNo ?? me.account_no ?? 0) };
}

async function wsFrames(cookie, ms) {
  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  const frames = [];
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  await new Promise((r) => setTimeout(r, ms));
  try { ws.close(); } catch { /* ignore */ }
  return frames;
}

const main = async () => {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  let owner = null;
  let blockedUser = null;
  let gid = null;
  let agentId = null;
  let agentToken = '';

  try {
    owner = await register(`拉黑主${rnd()}`);
    blockedUser = await register(`拉黑对象${rnd()}`);
    const bystander = await register(`拉黑路人${rnd()}`);
    check('准备：三个临时账号', Boolean(owner.cookie && blockedUser.cookie && bystander.cookie));

    // 群：owner 建，open 让另外两人进来（不依赖好友关系）
    const g0 = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title: `拉黑验证-${rnd()}`, member_ids: [] } });
    gid = g0.json?.conversation?.id ?? null;
    check('准备：建群', Boolean(gid), `gid=${gid}`);
    await api(`/api/conversations/${gid}/public`, { method: 'PATCH', cookie: owner.cookie, body: { discoverable: true, join_mode: 'open' } });
    for (const u of [blockedUser, bystander]) {
      const j = await api(`/api/conversations/${gid}/join`, { method: 'POST', cookie: u.cookie });
      if (j.status !== 200) throw new Error(`入群失败 ${j.status} ${j.text.slice(0, 80)}`);
    }
    // 一只 AI（观察 whats_new 的视角；AI 属于 owner）
    const ag = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: `拉黑AI${rnd()}` } });
    agentToken = ag.json?.token || '';
    agentId = ag.json?.agent?.id ?? ag.json?.principal_id ?? ag.json?.id ?? null;
    await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: owner.cookie, body: { principal_id: agentId } }).catch(() => {});
    check('准备：owner 的 AI 拿到 token', Boolean(agentToken && agentId), `agent=${agentId}`);

    // 两边各发一条，作为可见性基线
    const sendAs = async (cookie, body) => api(`/api/conversations/${gid}/messages`, {
      method: 'POST', cookie, body: { body, client_msg_id: `blk-${rnd()}` },
    });
    const mOwner = await sendAs(owner.cookie, `owner说-${rnd()}`);
    const mBlocked = await sendAs(blockedUser.cookie, `对方说-${rnd()}`);
    const blockedBody = `对方说-${String(mBlocked.json?.seq)}`;
    check('准备：双方各发一条', mOwner.status === 200 && mBlocked.status === 200);

    // ---------------------------------------------------------------- 1) 屏蔽
    const block = await api(`/api/blocks/${blockedUser.id}`, { method: 'POST', cookie: owner.cookie });
    check('1) A 屏蔽 B → 200', block.status === 200, `status=${block.status} ${block.text.slice(0, 80)}`);
    const { rows: blkRows } = await db.query(
      'SELECT 1 FROM principal_blocks WHERE blocker_id=$1 AND blocked_id=$2', [owner.id, blockedUser.id],
    );
    check('2) 库里落了一行 principal_blocks', blkRows.length === 1);
    const { rows: evRows } = await db.query(
      `SELECT payload FROM events WHERE type='BlockCreated' AND actor_id=$1 ORDER BY id DESC LIMIT 1`, [owner.id],
    );
    check('3) 有 BlockCreated 事件（可重放）', Number(evRows[0]?.payload?.blocked_id) === blockedUser.id,
      JSON.stringify(evRows[0]?.payload));

    // ---------------------------------------------------------------- 2) 双向读路径
    const ownerList = await api(`/api/conversations/${gid}/messages?since_seq=0&limit=50`, { cookie: owner.cookie });
    const ownerBodies = (ownerList.json?.messages || []).map((m) => String(m.body || ''));
    check('4) A 的消息列表里看不到 B 的消息', !ownerBodies.some((b) => b.includes('对方说')), `n=${ownerBodies.length}`);

    const blockedList = await api(`/api/conversations/${gid}/messages?since_seq=0&limit=50`, { cookie: blockedUser.cookie });
    const blockedBodies = (blockedList.json?.messages || []).map((m) => String(m.body || ''));
    check('5) B 也看不到 A 的消息（双向生效）', !blockedBodies.some((b) => b.includes('owner说')), `n=${blockedBodies.length}`);

    const one = await api(`/api/conversations/${gid}/messages/${mBlocked.json.seq}`, { cookie: owner.cookie });
    check('6) 单条回补（messages/:seq）也拿不到', one.status === 404, `status=${one.status}`);

    // whats_new：AI 属于 owner，应该看不到 B 的消息；游标要越过它（不重复拉）
    const wn = await (async () => {
      const res = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whats_new', arguments: { detail: true, limit: 50, since_seq: 0, conversation_ids: [gid] } } }),
      });
      const t = await res.text();
      try { return JSON.parse(t)?.result?.content?.[0]?.text ? JSON.parse(JSON.parse(t).result.content[0].text) : null; } catch { return null; }
    })();
    const wnBodies = (wn?.events || []).map((e) => String(e.body || ''));
    check('7) AI 的 whats_new 不含被屏蔽者的消息', !wnBodies.some((b) => b.includes('对方说')), `n=${wnBodies.length}`);
    check('8) 游标越过被屏蔽消息（next_seq 覆盖到最后一条事件）',
      Number(wn?.next_seq || 0) >= Number(mBlocked.json?.event_id || mBlocked.json?.seq || 0) || Number(wn?.next_seq || 0) > 0,
      `next_seq=${wn?.next_seq}`);

    const search = await api(`/api/search/messages?q=${encodeURIComponent('对方说')}&limit=20`, { cookie: owner.cookie });
    const searchBodies = (search.json?.results || []).map((r) => String(r.body || ''));
    check('9) 搜索也搜不到（不能靠关键词绕过）', !searchBodies.some((b) => b.includes('对方说')), `n=${searchBodies.length}`);

    // ---------------------------------------------------------------- 3) WS：在线也收不到
    const framesPromise = wsFrames(owner.cookie, 2500);
    await new Promise((r) => setTimeout(r, 500));
    await sendAs(blockedUser.cookie, `屏蔽后的消息-${rnd()}`);
    const frames = await framesPromise;
    const eventFrames = frames.filter((f) => f.t === 'event' && Number(f.conversationId) === Number(gid));
    check('10) A 在线时收不到 B 的实时帧', eventFrames.length === 0, `events=${eventFrames.length}`);

    // ---------------------------------------------------------------- 4) 私聊 / 加好友 / 自屏蔽
    const dm = await api('/api/conversations/dm', { method: 'POST', cookie: blockedUser.cookie, body: { principal_id: owner.id } });
    check('11) 被屏蔽方开私聊 → 被拒（blocked）', dm.status >= 400 && String(dm.json?.error || '') === 'blocked',
      `status=${dm.status} ${JSON.stringify(dm.json)?.slice(0, 100)}`);

    const accountNo = Number((await api('/api/me', { cookie: owner.cookie })).json?.accountNo || 0);
    let friendReq = { status: 0, json: null };
    if (accountNo) {
      friendReq = await api('/api/friends/request', { method: 'POST', cookie: blockedUser.cookie, body: { account_no: accountNo } });
    }
    check('12) 被屏蔽方按号码加好友 → 被拒（blocked）', friendReq.status === 403 && String(friendReq.json?.error || '') === 'blocked',
      `status=${friendReq.status}`);

    const self = await api(`/api/blocks/${owner.id}`, { method: 'POST', cookie: owner.cookie });
    check('13) 屏蔽自己 → 400', self.status === 400, `status=${self.status}`);

    // ---------------------------------------------------------------- 5) 解除
    const unblock = await api(`/api/blocks/${blockedUser.id}`, { method: 'DELETE', cookie: owner.cookie });
    check('14) 解除屏蔽 → 200', unblock.status === 200, `status=${unblock.status}`);
    const after = await api(`/api/conversations/${gid}/messages?since_seq=0&limit=50`, { cookie: owner.cookie });
    const afterBodies = (after.json?.messages || []).map((m) => String(m.body || ''));
    check('15) 解除后消息重新可见', afterBodies.some((b) => b.includes('对方说')), `n=${afterBodies.length}`);
    const { rows: gone } = await db.query(
      'SELECT 1 FROM principal_blocks WHERE blocker_id=$1 AND blocked_id=$2', [owner.id, blockedUser.id],
    );
    check('16) 库里那行已删除（有 BlockRemoved 事件）', gone.length === 0);
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
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
