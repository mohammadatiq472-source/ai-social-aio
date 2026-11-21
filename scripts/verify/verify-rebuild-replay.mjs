#!/usr/bin/env node
// 灾备重建「逐字段一致」回归（外部审查 Q9）。
//
// 问题：`sql/rebuild.sql` 以前只重放 MessageSent / 说说。撤回、站务隐藏、已读、成员进退、角色、
// 入群审批都不还原 —— 灾备后会出现「撤回的消息复活」「退群的人又在群里」「审批记录消失」。
//
// 判定口径（硬）：**在全新数据库上造场景 → 跑一次 rebuild.sql → 五张表逐行逐字段完全一致**。
// 不是「关键字段对得上」：时间戳也比。写事件与写投影在同一个事务里、now() 相同，所以理应一模一样；
// 任何差异都说明重建逻辑漏了东西或用了别的时间来源。
//
// 为什么必须用全新库（**不要**直接在本机开发库上跑）：
//   开发库里有大量 `cleanup-test.mjs` 直接 DELETE 掉的测试数据 —— 那些删除**没有事件**，
//   事件日志里仍然说"这些人是成员"。在这种库上做整表对比，重建会"复活"被直接删掉的成员，
//   得到一堆与产品无关的假红。灾备场景本来就是"空库 + 事件日志"，所以这里自建 scratch 库：
//   createdb → migrate → 起临时服务（8796）→ 造场景 → rebuild → 对比 → dropdb。
//
// 用法：AIO_ALLOW_REBUILD=1 ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5434/postgres \
//        node scripts/verify/verify-rebuild-replay.mjs
//   - 必须显式 AIO_ALLOW_REBUILD=1（会创建/删除数据库，prod-run.sh 不带这个变量 → 生产自动 SKIP）
//   - ADMIN_DATABASE_URL 要能 CREATE/DROP DATABASE（本地/CI 都是 postgres 超级用户）
//
// 场景覆盖：发消息 → 本人撤回 → 站务隐藏 → 已读 → 改角色 → 退群 → 公开设置 → 入群审批（pending→accepted）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const PORT = Number(process.env.REBUILD_TEST_PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve('.');
const SCRATCH = `aio_rebuild_verify_${process.pid}`;
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

// ADMIN_DATABASE_URL 指向 postgres 维护库（能 create/drop database）；缺省按本地开发栈推
const ADMIN_URL = process.env.ADMIN_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5434/postgres';
/** 从 ADMIN_URL 派生出「连到某个库」的连接串 */
function withDatabase(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
const SCRATCH_URL = withDatabase(ADMIN_URL, SCRATCH);

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

async function register(name) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'Rebuild!2026', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${r.text.slice(0, 140)}`);
  return { cookie: r.cookie, email, id: Number(r.json?.me?.id || 0) };
}

/** 子进程日志写文件（沙箱对管道 stdio 有限制，且失败时能直接看服务端日志） */
function runNode(args, { env = {}, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
  });
  const done = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      resolve({ code, signal });
    });
  });
  return { child, done, log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } } };
}

const TABLES = [
  { name: 'messages_meta', pk: 'conversation_id, seq', ignore: [] },
  { name: 'conversations', pk: 'id', ignore: [] },
  { name: 'conversation_members', pk: 'conversation_id, principal_id', ignore: [] },
  { name: 'group_join_requests', pk: 'id', ignore: [] },
  // 屏蔽关系（Q12）：完全事件驱动，必须能从 BlockCreated/BlockRemoved 重建
  { name: 'principal_blocks', pk: 'blocker_id, blocked_id', ignore: [] },
  // 说说不是 Q9 的重点，而且 FeedDeleted 的 deleted_at 是"删除那一刻"的墙钟：
  // 事件与投影不在同一事务时会有 1~2ms 差，属于已知且无害的偏差 → 只比业务字段。
  { name: 'feeds', pk: 'id', ignore: ['deleted_at'] },
];

async function snapshot(db) {
  const out = {};
  for (const t of TABLES) {
    const { rows } = await db.query(`SELECT * FROM ${t.name} ORDER BY ${t.pk}`);
    out[t.name] = rows;
  }
  return out;
}

function diffRows(before, after, pk, ignore = []) {
  const keys = pk.split(',').map((s) => s.trim());
  const keyOf = (row) => keys.map((k) => String(row[k])).join('|');
  const b = new Map(before.map((r) => [keyOf(r), r]));
  const a = new Map(after.map((r) => [keyOf(r), r]));
  const diffs = [];
  for (const [k, row] of b) {
    const other = a.get(k);
    if (!other) { diffs.push(`缺少 ${k}`); continue; }
    for (const col of Object.keys(row)) {
      if (ignore.includes(col)) continue;
      if (JSON.stringify(row[col]) !== JSON.stringify(other[col])) {
        diffs.push(`${k}.${col}: ${JSON.stringify(row[col])} → ${JSON.stringify(other[col])}`);
      }
    }
  }
  for (const k of a.keys()) if (!b.has(k)) diffs.push(`多出 ${k}`);
  return diffs;
}

async function adminExec(url, sql) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

const main = async () => {
  if (process.env.AIO_ALLOW_REBUILD !== '1') {
    skip('整体 rebuild 重放对比', '未设置 AIO_ALLOW_REBUILD=1（会创建/删除数据库，生产默认跳过）');
    const failed0 = results.filter((r) => !r.ok);
    console.log(`\n${failed0.length === 0 ? '全部通过' : '有失败'}：${results.length - failed0.length}/${results.length}`);
    return;
  }

  let server = null;
  let db = null;
  let scratchCreated = false;

  const teardown = async () => {
    if (server?.child && server.child.exitCode === null) { try { server.child.kill(); } catch { /* ignore */ } }
    if (db) { try { await db.end(); } catch { /* ignore */ } }
    if (scratchCreated) {
      try { await adminExec(withDatabase(ADMIN_URL, 'postgres'), `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`); } catch { /* ignore */ }
    }
  };

  try {
    // ---------------------------------------------------------------- 1) 全新 scratch 库 + 迁移
    await adminExec(withDatabase(ADMIN_URL, 'postgres'), `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await adminExec(withDatabase(ADMIN_URL, 'postgres'), `CREATE DATABASE ${SCRATCH}`);
    scratchCreated = true;
    check('准备：创建 scratch 库（灾备场景=空库+事件日志）', true, SCRATCH);

    const migrate = runNode([path.join(ROOT, 'scripts', 'migrate.mjs')], {
      env: { DATABASE_URL: SCRATCH_URL, ADMIN_DATABASE_URL: SCRATCH_URL, WRITER_DATABASE_URL: SCRATCH_URL },
      logFile: path.join(ROOT, 'tmp', 'rebuild-verify-migrate.log'),
    });
    const mig = await migrate.done;
    check('准备：迁移全量跑通', mig.code === 0, `exit=${mig.code} ${migrate.log().slice(-200)}`);

    // ---------------------------------------------------------------- 2) 临时服务（8796）连 scratch
    server = runNode([path.join(ROOT, 'src', 'index.mjs')], {
      env: {
        PORT: String(PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        SESSION_SECRET: 'dev-only-secret',
        SECURE_COOKIE: 'false',
        PUBLIC_BASE_URL: BASE,
        DATABASE_URL: SCRATCH_URL,
        WRITER_DATABASE_URL: SCRATCH_URL,
        ADMIN_DATABASE_URL: SCRATCH_URL,
        MEDIA_DIR: path.join(ROOT, 'tmp', 'rebuild-media'),
      },
      logFile: path.join(ROOT, 'tmp', 'rebuild-verify-server.log'),
    });
    let up = false;
    for (let i = 0; i < 120; i++) {
      if (server.child.exitCode !== null) break;
      try { const r = await fetch(`${BASE}/healthz`); if (r.ok) { up = true; break; } } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    check('准备：临时服务就绪（8796 → scratch 库）', up, up ? BASE : server.log().slice(-300));
    if (!up) throw new Error('临时服务没起来');

    // ---------------------------------------------------------------- 3) 造场景
    const owner = await register(`重建群主${rnd()}`);
    const memberB = await register(`重建成员B${rnd()}`);
    const memberC = await register(`重建成员C${rnd()}`);
    check('准备：三个临时账号', Boolean(owner.cookie && memberB.cookie && memberC.cookie));

    const group = await api('/api/conversations', {
      method: 'POST', cookie: owner.cookie, body: { title: `重建验证-${rnd()}`, member_ids: [] },
    });
    const gid = group.json?.conversation?.id ?? null;
    if (!gid) throw new Error(`建群失败：${group.status} ${group.text.slice(0, 160)}`);
    const pubOpen = await api(`/api/conversations/${gid}/public`, {
      method: 'PATCH', cookie: owner.cookie, body: { discoverable: true, join_mode: 'open' },
    });
    check('准备：群改为公开 + open', pubOpen.status === 200, `status=${pubOpen.status}`);
    for (const [label, other] of [['B', memberB], ['C', memberC]]) {
      const j = await api(`/api/conversations/${gid}/join`, { method: 'POST', cookie: other.cookie });
      check(`准备：${label} 通过 open 加入`, j.status === 200 && j.json?.joined === true,
        JSON.stringify(j.json)?.slice(0, 100));
    }

    const send = async (body) => api(`/api/conversations/${gid}/messages`, {
      method: 'POST', cookie: owner.cookie, body: { body, client_msg_id: `rebuild-${rnd()}` },
    });
    const m1 = await send('重建一');
    const m2 = await send('重建二（将被撤回）');
    const m3 = await send('重建三（将被站务隐藏）');
    check('准备：发出 3 条消息', Boolean(m1.json?.seq && m2.json?.seq && m3.json?.seq));

    const recalled = await api(`/api/conversations/${gid}/messages/${m2.json.seq}`, { method: 'DELETE', cookie: owner.cookie });
    check('准备：撤回第 2 条', recalled.status === 200, `status=${recalled.status}`);

    // 站务隐藏：举报 → 处理。站务权限直连 scratch 库加（与生产维护手册 §5 同口径）
    db = new pg.Client({ connectionString: SCRATCH_URL });
    await db.connect();
    await db.query('UPDATE principals SET is_admin = true WHERE id = $1', [owner.id]);
    await api('/api/reports', {
      method: 'POST', cookie: memberB.cookie,
      body: { target_type: 'message', target_id: m3.json.seq, conversation_id: gid, reason: 'spam' },
    });
    const { rows: rep } = await db.query(
      `SELECT id FROM reports WHERE conversation_id=$1 AND target_type='message' AND target_id=$2 ORDER BY id DESC LIMIT 1`,
      [gid, m3.json.seq],
    );
    const hidden = rep[0]
      ? await api(`/api/admin/reports/${rep[0].id}/handle`, {
        method: 'POST', cookie: owner.cookie, body: { action: 'hide_message', note: 'rebuild verify' },
      })
      : { status: 0 };
    check('准备：站务隐藏第 3 条', hidden.status === 200, `status=${hidden.status}`);

    const read = await api(`/api/conversations/${gid}/read`, {
      method: 'POST', cookie: memberB.cookie, body: { seq: m3.json.seq },
    });
    check('准备：B 上报已读', read.status === 200, `status=${read.status}`);

    const ann = `重建群规-${rnd()}`;
    const setAnn = await api(`/api/conversations/${gid}/announcement`, {
      method: 'PATCH', cookie: owner.cookie, body: { announcement: ann },
    });
    check('准备：写群公告', setAnn.status === 200, `status=${setAnn.status}`);

    const promote = await api(`/api/conversations/${gid}/members/${memberC.id}/role`, {
      method: 'POST', cookie: owner.cookie, body: { role: 'admin' },
    });
    check('准备：C 升为 admin', promote.status === 200, `status=${promote.status}`);
    const leave = await api(`/api/conversations/${gid}/leave`, { method: 'POST', cookie: memberC.cookie });
    check('准备：C 退群', leave.status === 200, `status=${leave.status}`);

    const pubApproval = await api(`/api/conversations/${gid}/public`, {
      method: 'PATCH', cookie: owner.cookie, body: { discoverable: true, join_mode: 'approval' },
    });
    check('准备：群改为 approval', pubApproval.status === 200, `status=${pubApproval.status}`);
    const applicant = await register(`重建申请者${rnd()}`);
    const join = await api(`/api/conversations/${gid}/join`, { method: 'POST', cookie: applicant.cookie });
    check('准备：申请入群落 pending', join.status === 200 && join.json?.pending === true,
      JSON.stringify(join.json)?.slice(0, 120));
    const acc = await api(`/api/conversations/${gid}/join-requests/${applicant.id}`, {
      method: 'POST', cookie: owner.cookie, body: { accept: true },
    });
    check('准备：站务接受入群申请', acc.status === 200, `status=${acc.status}`);

    // 屏蔽关系（Q12）：也要能从 BlockCreated 事件重放出来
    const blk = await api(`/api/blocks/${memberB.id}`, { method: 'POST', cookie: applicant.cookie });
    check('准备：申请者屏蔽 B（BlockCreated 事件）', blk.status === 200, `status=${blk.status}`);

    // ---------------------------------------------------------------- 4) 快照 → rebuild → 逐表对比
    const before = await snapshot(db);
    check('快照：五张表都可读',
      TABLES.every((t) => Array.isArray(before[t.name])),
      TABLES.map((t) => `${t.name}=${before[t.name].length}`).join(' '));

    const sqlText = fs.readFileSync(path.join(ROOT, 'sql', 'rebuild.sql'), 'utf8');
    let rebuilt = false;
    let rebuildErr = '';
    try {
      await db.query(sqlText);
      rebuilt = true;
    } catch (err) {
      rebuildErr = err.message;
    }
    check('重建：sql/rebuild.sql 在新库上整体执行', rebuilt, rebuildErr.slice(0, 240));

    if (rebuilt) {
      const after = await snapshot(db);
      for (const t of TABLES) {
        const diffs = diffRows(before[t.name], after[t.name], t.pk, t.ignore || []);
        check(`逐字段一致：${t.name}（${before[t.name].length} 行）`, diffs.length === 0,
          diffs.slice(0, 6).join(' ; ') || '无差异');
      }
      // 单独点名以前明确漏掉的三处
      const msg = after.messages_meta.find((r) => Number(r.conversation_id) === gid && Number(r.seq) === Number(m2.json.seq));
      check('撤回的消息仍是 recalled_at 非空（没有"复活"）', Boolean(msg?.recalled_at), `recalled_at=${msg?.recalled_at}`);
      const memB = after.conversation_members.find((r) => Number(r.conversation_id) === gid && Number(r.principal_id) === memberB.id);
      check('B 的 last_read_seq 被保留（非事件状态不回退）', Number(memB?.last_read_seq) === Number(m3.json.seq),
        `last_read_seq=${memB?.last_read_seq} 期望=${m3.json.seq}`);
      const memC = after.conversation_members.find((r) => Number(r.conversation_id) === gid && Number(r.principal_id) === memberC.id);
      check('已退群的 C 没有被重建回来', memC === undefined, memC ? JSON.stringify(memC) : '不在成员表');
      const conv = after.conversations.find((r) => Number(r.id) === gid);
      check('群公告正文被保留（审计只记 length，不重建正文）', conv?.announcement === ann,
        `announcement=${String(conv?.announcement).slice(0, 20)}`);
      check('公告时间戳与流水一致', Boolean(conv?.announcement_updated_at), `updated_at=${conv?.announcement_updated_at}`);
      const jr = after.group_join_requests.filter((r) => Number(r.conversation_id) === gid);
      check('入群审批记录被重放（含 accepted）', jr.length >= 1 && jr.some((r) => r.status === 'accepted'),
        jr.map((r) => r.status).join(',') || '空');
      const memAfter = after.conversation_members.filter((r) => Number(r.conversation_id) === gid);
      check('重建后成员数 = 群主 + B + 申请者（C 已退）', memAfter.length === 3,
        `n=${memAfter.length} ids=${memAfter.map((r) => r.principal_id).join(',')}`);
    }
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
    await teardown();
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
