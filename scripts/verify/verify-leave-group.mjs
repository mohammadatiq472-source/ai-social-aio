#!/usr/bin/env node
// 人类退群（2026-11-19）的回归。
//
// 为什么要有这条：原来被拉进不想待的群**没有任何出口**（只有群主能解散、只有 Agent 有 leave_group）。
// 退群又是不可撤销动作，所以除了「能退」，还要钉住三件边界：
//   - 群主不能退（否则群变无主）；
//   - 退完真的看不到（列表 + 读消息 403 + 再退 404）；
//   - 事件流里留下 MemberRemoved(self:true)，别让「谁主动离开过」没法查。
//
// 用法：DATABASE_URL=... BASE=http://127.0.0.1:8787 node scripts/verify/verify-leave-group.mjs

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

async function register(name) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'LeaveGroup!2026', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`register ${r.status} ${String(r.text).slice(0, 120)}`);
  const c = r.headers.getSetCookie?.() || [];
  return { email, cookie: c.map((x) => x.split(';')[0]).join('; ') };
}

const main = async () => {
  const owner = await register('退群群主');
  const member = await register('退群成员');
  const outsider = await register('退群路人');

  const meOwner = await api('/api/me', { cookie: owner.cookie });
  const meMember = await api('/api/me', { cookie: member.cookie });
  const memberId = meMember.json?.id;

  // 建群拉人要求「已是好友」（不是好友会 400 not_friend）：群主用成员的账号号发请求，成员接受
  const req = await api('/api/friends/request', {
    method: 'POST', cookie: owner.cookie, body: { account_no: meMember.json?.accountNo },
  });
  const acc = await api('/api/friends/accept', {
    method: 'POST', cookie: member.cookie, body: { principal_id: meOwner.json?.id },
  });
  check('先把两个人加成好友（建群拉人的前置条件）',
    req.status === 200 && acc.status === 200, `request=${req.status} accept=${acc.status}`);

  const g = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: `退群验证群${rnd()}`, member_ids: [memberId] },
  });
  const gid = g.json?.conversation?.id;
  check('建群并把成员拉进来', Boolean(gid), `gid=${gid}`);

  // 发一条消息，退群后应读不到
  await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie: owner.cookie,
    body: { body: '退群前的消息', client_msg_id: `lg-${rnd()}` },
  });

  const listBefore = await api('/api/conversations', { cookie: member.cookie });
  check('成员一开始能看到这个群',
    (listBefore.json || []).some((c) => Number(c.id) === Number(gid)), '');

  // 群主不能退
  const ownerLeave = await api(`/api/conversations/${gid}/leave`, { method: 'POST', cookie: owner.cookie });
  check('群主退群 → 403（否则群变无主）', ownerLeave.status === 403,
    `status=${ownerLeave.status} msg=${String(ownerLeave.json?.message).slice(0, 40)}`);

  // 非成员退 → 404
  const outsiderLeave = await api(`/api/conversations/${gid}/leave`, { method: 'POST', cookie: outsider.cookie });
  check('非成员退群 → 404', outsiderLeave.status === 404, `status=${outsiderLeave.status}`);

  // 正常退群
  const left = await api(`/api/conversations/${gid}/leave`, { method: 'POST', cookie: member.cookie });
  check('成员退群 → 200 left', left.status === 200 && left.json?.ok === true, `status=${left.status}`);

  const listAfter = await api('/api/conversations', { cookie: member.cookie });
  check('退群后列表里没有这个群',
    !(listAfter.json || []).some((c) => Number(c.id) === Number(gid)), '');

  const readAfter = await api(`/api/conversations/${gid}/messages?limit=10`, { cookie: member.cookie });
  check('退群后读消息 → 403（不是还能看）', readAfter.status === 403, `status=${readAfter.status}`);

  const again = await api(`/api/conversations/${gid}/leave`, { method: 'POST', cookie: member.cookie });
  check('重复退群 → 404（不假装成功）', again.status === 404, `status=${again.status}`);

  // 群主仍然在群里
  const ownerList = await api('/api/conversations', { cookie: owner.cookie });
  check('群主仍能看到群（退的只是自己）',
    (ownerList.json || []).some((c) => Number(c.id) === Number(gid)), '');

  // 事件留痕
  if (DB_URL) {
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    try {
      const ev = await db.query(
        `SELECT payload, actor_id FROM events
          WHERE type='MemberRemoved' AND aggregate_id=$1 AND actor_id=$2 ORDER BY id DESC LIMIT 1`,
        [gid, memberId],
      );
      const row = ev.rows[0];
      check('写了 MemberRemoved 事件且 self=true（可追溯「主动离开」）',
        Boolean(row) && row.payload?.self === true, JSON.stringify(row?.payload || null));
    } finally {
      await db.end().catch(() => {});
    }
  } else {
    check('写了 MemberRemoved 事件（跳过：没有 DATABASE_URL）', true, 'SKIP');
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
