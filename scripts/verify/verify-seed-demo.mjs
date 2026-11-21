#!/usr/bin/env node
// 演示数据（seed-demo）回归（2026-11-20 外部评审发现：建群被拒却打印 ok）。
//
// 为什么必须有这条：演示群是宣传视频 / 一键体验的前置。脚本「看起来成功」是最坏的失败模式——
// 没有报错、没有非零退出，演示账号登录进去一个会话都没有，只有真人点进去才发现。
//
// 覆盖（12 条）：
//   1. 全新库 + migrate 后跑 seed-demo：退出码 0、输出 ok:true、返回 conversationId；
//   2. 群里确实有 4 个成员（demo、buddy、两只 AI）；
//   3. 消息 ≥ 5 条，至少一条带 mentions、一条带 reply_to_seq（演示「@ 与引用」）；
//   4. 说说 ≥ 3 条；
//   5. 再跑一次：退出码 0、skipped:true，消息/成员/说说数量不变（幂等）；
//   6. **反向验证**：在一个没跑迁移的空库上跑 seed-demo → 必须非零退出、stderr 有原因、
//      且绝不能打印出 ok:true（这条就是当初那个 bug 的守卫）。
//
// 用法：ADMIN_DATABASE_URL=postgres://... node scripts/verify/verify-seed-demo.mjs
//   需要能 CREATE/DROP DATABASE 的账号（本地/CI 都是 postgres 超级用户）。
//   自己建 scratch 库，跑完删除；不会碰 DATABASE_URL 指向的库。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve('.');
const ADMIN_URL = process.env.ADMIN_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5434/postgres';
const SCRATCH = `aio_seed_verify_${process.pid}`;
const EMPTY = `${SCRATCH}_empty`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

function withDatabase(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function adminExec(sql) {
  const c = new pg.Client({ connectionString: withDatabase(ADMIN_URL, 'postgres') });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

/** 子进程跑 node 脚本，收 stdout/stderr（管道在本机与 CI 都可用；本会话已是全权限） */
function runNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function parseJson(out) {
  // seed-demo 会打印一个完整 JSON 对象；日志可能混入 closeDb 之类输出，取最后一个 { 开头的块
  const start = out.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(out.slice(start)); } catch { return null; }
}

const main = async () => {
  let created = false;
  let scratchDb = null;
  try {
    await adminExec(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await adminExec(`DROP DATABASE IF EXISTS ${EMPTY} WITH (FORCE)`);
    await adminExec(`CREATE DATABASE ${SCRATCH}`);
    await adminExec(`CREATE DATABASE ${EMPTY}`);
    created = true;
    const scratchUrl = withDatabase(ADMIN_URL, SCRATCH);
    check('准备：创建两个 scratch 库（有迁移 / 空库）', true, SCRATCH);

    const mig = await runNode(path.join(ROOT, 'scripts', 'migrate.mjs'), {
      DATABASE_URL: scratchUrl, ADMIN_DATABASE_URL: scratchUrl, WRITER_DATABASE_URL: scratchUrl,
    });
    check('准备：迁移全量跑通', mig.code === 0, `exit=${mig.code} ${mig.err.slice(-160)}`);

    const env = { DATABASE_URL: scratchUrl, WRITER_DATABASE_URL: scratchUrl, ADMIN_DATABASE_URL: scratchUrl };

    // ---------------------------------------------------------------- 1) 首次播种
    const first = await runNode(path.join(ROOT, 'scripts', 'seed-demo.mjs'), env);
    const firstJson = parseJson(first.out);
    check('1) 首次 seed-demo → 退出码 0', first.code === 0, `exit=${first.code} ${first.err.slice(-200)}`);
    check('2) 输出 ok:true 且带 conversationId', Boolean(firstJson?.ok && Number(firstJson?.conversationId) > 0),
      JSON.stringify(firstJson)?.slice(0, 160));
    const gid = Number(firstJson?.conversationId) || 0;

    scratchDb = new pg.Client({ connectionString: scratchUrl });
    await scratchDb.connect();
    const { rows: members } = await scratchDb.query(
      'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [gid],
    );
    check('3) 演示群里有 4 个成员（demo/buddy/两只 AI）', Number(members[0]?.n) === 4, `n=${members[0]?.n}`);

    const { rows: msgs } = await scratchDb.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE mentions IS NOT NULL AND array_length(mentions,1) > 0)::int AS with_mentions,
              count(*) FILTER (WHERE reply_to_seq IS NOT NULL)::int AS with_reply
         FROM messages_meta WHERE conversation_id = $1`, [gid],
    );
    check('4) 消息 ≥ 5 条', Number(msgs[0]?.n) >= 5, `n=${msgs[0]?.n}`);
    check('5) 至少一条带 mentions（演示 @）', Number(msgs[0]?.with_mentions) >= 1, `n=${msgs[0]?.with_mentions}`);
    check('6) 至少一条带 reply_to_seq（演示引用）', Number(msgs[0]?.with_reply) >= 1, `n=${msgs[0]?.with_reply}`);

    const { rows: feeds } = await scratchDb.query('SELECT count(*)::int AS n FROM feeds');
    check('7) 说说 ≥ 3 条', Number(feeds[0]?.n) >= 3, `n=${feeds[0]?.n}`);

    // ---------------------------------------------------------------- 2) 幂等
    const second = await runNode(path.join(ROOT, 'scripts', 'seed-demo.mjs'), env);
    const secondJson = parseJson(second.out);
    check('8) 二次 seed-demo → 退出码 0 且 skipped:true', second.code === 0 && secondJson?.skipped === true,
      `exit=${second.code} skipped=${secondJson?.skipped}`);
    const { rows: countAfter } = await scratchDb.query(
      `SELECT (SELECT count(*)::int FROM messages_meta WHERE conversation_id=$1) AS msgs,
              (SELECT count(*)::int FROM conversation_members WHERE conversation_id=$1) AS members,
              (SELECT count(*)::int FROM feeds) AS feeds`, [gid],
    );
    check('9) 二次播种不重复灌数据（消息/成员/说说都不变）',
      Number(countAfter[0].msgs) === Number(msgs[0].n)
      && Number(countAfter[0].members) === 4
      && Number(countAfter[0].feeds) === Number(feeds[0].n),
      JSON.stringify(countAfter[0]));

    // ---------------------------------------------------------------- 3) 反向验证：空库必须响
    const emptyUrl = withDatabase(ADMIN_URL, EMPTY);
    const broken = await runNode(path.join(ROOT, 'scripts', 'seed-demo.mjs'), {
      DATABASE_URL: emptyUrl, WRITER_DATABASE_URL: emptyUrl, ADMIN_DATABASE_URL: emptyUrl,
    });
    check('10) 空库（未迁移）上跑 seed-demo → 非零退出', broken.code !== 0, `exit=${broken.code}`);
    check('11) 失败信息带原因（不是静默 ok）', /seed failed/i.test(broken.err),
      broken.err.trim().split('\n').slice(-1)[0]?.slice(0, 140));
    check('12) 失败时绝不打印 ok:true', !parseJson(broken.out)?.ok, broken.out.slice(0, 120));
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
    try { await scratchDb?.end(); } catch { /* ignore */ }
    if (created) {
      try { await adminExec(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`); } catch { /* ignore */ }
      try { await adminExec(`DROP DATABASE IF EXISTS ${EMPTY} WITH (FORCE)`); } catch { /* ignore */ }
    }
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
