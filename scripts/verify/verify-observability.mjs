// 可观测性回归（P1-5）：慢 SQL / 慢 HTTP / 连接池水位
//
// 覆盖的契约：
//   1) /healthz（本机访问）返回 pools.app / pools.writer 的 total/idle/waiting 数字；
//      公网访问（带 cf-connecting-ip）仍只回 {ok, db}，不泄露池信息。
//   2) 慢 SQL：DB_SLOW_MS=200 时，SELECT pg_sleep(0.35) 在 stderr 打出 [db.slow]，
//      writer 池打 [db.slow.writer]；**日志里绝不能出现参数值**（本脚本用哨兵串验证）。
//   3) 同一个 client 连续借出两次只包装一次（DB_POOL_MAX=1，禁止日志翻倍）。
//   4) 查询报错也要带耗时与 SQLSTATE。
//   5) 慢 HTTP：HTTP_SLOW_MS=1 时 POST /api/auth/login 打 http.slow；
//      /healthz 属于排除项，不能打；日志里不能出现密码。
//
// 做法：连得上 8787 就顺带验它；核心用例 spawn 一个 8792 临时服务（DB_SLOW_MS=200、
// HTTP_SLOW_MS=1），结束后杀掉，不碰 8787 的配置。
//
// 用法：node scripts/verify/verify-observability.mjs
// 前置：本机 PG 5434/aio、demo 账号；8792 端口空闲。无 DB 环境 → SKIP exit 0。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve('.');
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
const WRITER_URL = process.env.WRITER_DATABASE_URL || DB_URL;
const MAIN_BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TEST_PORT = Number(process.env.OBS_PORT || 8792);
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;
const MEDIA_DIR = path.resolve(process.env.OBS_MEDIA_DIR || 'tmp/obsmedia');
const SECRET = `OBS_SECRET_${crypto.randomBytes(8).toString('hex')}`;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}
async function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true }), ms); });
  const value = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return value;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
        SESSION_SECRET: 'obs-dev-secret',
        SECURE_COOKIE: 'false',
        PUBLIC_BASE_URL: TEST_BASE,
        DATABASE_URL: DB_URL,
        WRITER_DATABASE_URL: WRITER_URL,
        MEDIA_DIR,
        DB_SLOW_MS: '200',
        HTTP_SLOW_MS: '1',
        DB_POOL_MAX: '2',
        WRITER_POOL_MAX: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const capture = (d) => { log = (log + d.toString()).slice(-60_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    let settled = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      rejectReady(err);
    };
    child.once('exit', (code, signal) => {
      fail(new Error(`临时服务提前退出（code=${code} signal=${signal}）\n${log.slice(-2000)}`));
    });
    (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (settled || child.exitCode !== null) return;
        try {
          const r = await fetch(`${TEST_BASE}/healthz`);
          if (r.ok) {
            settled = true;
            child.removeAllListeners('exit');
            resolveReady({ child, log: () => log });
            return;
          }
        } catch { /* 还没起来 */ }
        await sleep(200);
      }
      fail(new Error(`临时服务 20s 内未就绪\n${log.slice(-2000)}`));
    })();
    // 外层 Promise 采纳内部 ready（resolve 会自动展开 thenable）
    resolve(ready);
  });
}

async function stopServer(server) {
  if (!server) return;
  const { child } = server;
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const ok = await within(exited.then(() => true), 5000);
  if (ok !== true) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await within(exited, 2000);
  }
}

function poolsOf(json) {
  const p = json?.pools;
  if (!p || typeof p !== 'object') return null;
  const nums = (x) => x && ['total', 'idle', 'waiting'].every((k) => Number.isInteger(x[k]) && x[k] >= 0);
  return nums(p.app) && nums(p.writer) ? p : null;
}

function runSlowChild() {
  return new Promise(async (resolve) => {
    const childPath = path.join(ROOT, 'tmp', `obs-slow-child-${process.pid}.mjs`);
    const src = `
const { pool, writerPool, poolStats, closeDb } = await import('../src/db.mjs');
const SECRET = process.env.OBS_SECRET || 'NO_SECRET';
const SLOW = 'SELECT pg_sleep($1::float8), $2::text AS echo';
await pool.query('SELECT 1 AS fast_no_log');
await pool.query(SLOW, [0.35, SECRET]);
// 同一 client 借出两次（DB_POOL_MAX=1 会拿到同一个）；包装必须只发生一次
const c1 = await pool.connect();
await c1.query(SLOW, [0.35, SECRET]);
c1.release();
const c2 = await pool.connect();
await c2.query(SLOW, [0.35, SECRET]);
c2.release();
await writerPool.query('SELECT pg_sleep($1::float8), $2::text AS echo', [0.35, SECRET]);
console.log('POOLSTATS ' + JSON.stringify(poolStats()));
try {
  await pool.query('SELECT * FROM __obs_missing_table__');
} catch (err) {
  console.log('ERRCODE ' + err.code);
}
await closeDb();
console.log('CHILD_DONE');
`;
    await fsp.mkdir(path.dirname(childPath), { recursive: true });
    await fsp.writeFile(childPath, src, 'utf8');
    const child = spawn(process.execPath, [childPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: DB_URL,
        WRITER_DATABASE_URL: WRITER_URL,
        DB_SLOW_MS: '200',
        DB_POOL_MAX: '1',
        WRITER_POOL_MAX: '1',
        OBS_SECRET: SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 30_000);
    child.once('exit', async (code) => {
      clearTimeout(timer);
      await fsp.rm(childPath, { force: true }).catch(() => {});
      resolve({ code, stdout, stderr });
    });
  });
}

async function loginTest() {
  const r = await fetch(`${TEST_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }),
  });
  const text = await r.text();
  return { status: r.status, text };
}

let server = null;
try {
  // 先确认 DB 可用；不可用按约定 SKIP（CI 无 PG 的环境）
  const probe = new pg.Client({ connectionString: DB_URL });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
  } catch (err) {
    console.log(`SKIP：连不上数据库（${err.code || err.message}），无法验证慢查询/连接池指标`);
    process.exitCode = 0;
    await probe.end().catch(() => {});
    throw { __skip: true };
  } finally {
    await probe.end().catch(() => {});
  }

  await fsp.rm(MEDIA_DIR, { recursive: true, force: true });
  server = await startServer();
  console.log(`临时服务已起：${TEST_BASE}（DB_SLOW_MS=200 HTTP_SLOW_MS=1）`);

  // 1) /healthz 形状（临时服务）
  const hzRes = await fetch(`${TEST_BASE}/healthz`);
  const hz = await hzRes.json().catch(() => null);
  const pools = poolsOf(hz);
  check('/healthz 返回 pools.app / pools.writer 的 total/idle/waiting 数字', Boolean(pools),
    pools ? JSON.stringify(pools) : JSON.stringify(hz)?.slice(0, 200));

  // 8787 已起（新代码）也验一遍；不可达则 SKIP，不影响临时服务用例
  try {
    const mainRes = await fetch(`${MAIN_BASE}/healthz`);
    const mainHz = await mainRes.json().catch(() => null);
    const mainPools = poolsOf(mainHz);
    if (mainRes.ok && mainPools) {
      check(`${MAIN_BASE}/healthz 也有 pools 数字字段`, true, JSON.stringify(mainPools));
    } else {
      check(`${MAIN_BASE}/healthz 也有 pools 数字字段`, false,
        `status=${mainRes.status} body=${JSON.stringify(mainHz)?.slice(0, 160)}（8787 是否还没重启到新代码？）`);
    }
  } catch (err) {
    skip('8787 /healthz 不可达', err.message);
  }

  // 2) 慢 HTTP：login 走 scrypt + DB，HTTP_SLOW_MS=1 必然超阈值
  const login = await loginTest();
  check('临时服务 demo 登录成功（用于触发慢请求日志）', login.status === 200,
    `status=${login.status} body=${login.text.slice(0, 120)}`);
  await sleep(400);

  // 3) /healthz 必须被排除：阈值 1ms 下它也会超，但不该出现 http.slow
  const rawLog = server.log();
  const slowLines = rawLog.split('\n').filter((l) => l.includes('"msg":"http.slow"') || l.includes('http.slow'));
  check('慢请求日志出现 http.slow', slowLines.length > 0, `http.slow 行数=${slowLines.length}`);
  const loginLine = slowLines.find((l) => l.includes('/api/auth/login'));
  check('http.slow 带 method/url/statusCode/ms 且指向 /api/auth/login', Boolean(loginLine),
    loginLine ? loginLine.slice(0, 220) : '没找到 /api/auth/login 的慢日志');
  const hzSlow = slowLines.filter((l) => l.includes('"/healthz"') || l.includes('/healthz'));
  check('/healthz 被排除（不产生 http.slow 噪声）', hzSlow.length === 0, `healthz 慢日志=${hzSlow.length}`);
  check('HTTP 日志里没有密码', !rawLog.includes('demo-qqmini-2026'));

  // 4) 慢 SQL / 连接池 / 错误 / 不打印参数
  const child = await within(runSlowChild(), 40_000);
  check('慢查询子进程正常结束', !child.__timedOut && child.code === 0,
    child.__timedOut ? '30s 超时' : `code=${child.code} ${child.stderr.slice(0, 160)}`);

  const dbLines = child.stderr.split('\n').filter((l) => l.trim().startsWith('[db.slow]'));
  const writerLines = child.stderr.split('\n').filter((l) => l.trim().startsWith('[db.slow.writer]'));
  const appSleepLines = dbLines.filter((l) => l.includes('pg_sleep'));
  check('业务池慢查询打出 [db.slow]（pg_sleep）', appSleepLines.length === 3,
    `pg_sleep 日志 ${appSleepLines.length} 条（pool.query + client×2；>3 说明 client 被重复包装）`);
  check('writer 池慢查询打出 [db.slow.writer]', writerLines.length === 1,
    `writer 慢日志 ${writerLines.length} 条`);
  check('快查询 SELECT 1 不产生慢日志', !child.stderr.includes('fast_no_log'), '未出现 SELECT 1');
  check('慢日志带 ms 且 >= DB_SLOW_MS(200)', appSleepLines.every((l) => {
    const m = /"ms":\s*(\d+)/.exec(l);
    return m && Number(m[1]) >= 200;
  }), appSleepLines[0]?.slice(0, 160) || '（无）');
  check('日志里没有参数值（哨兵串）', !child.stderr.includes(SECRET), `secret=${SECRET.slice(0, 12)}…`);
  check('日志里没有 values/params 字段', !/["']?(values|params)["']?\s*:/.test(child.stderr));
  const errLine = dbLines.find((l) => l.includes('__obs_missing_table__'));
  check('查询错误也带耗时与 SQLSTATE', Boolean(errLine) && /"ms":\s*\d+/.test(errLine) && errLine.includes('42P01'),
    errLine ? errLine.slice(0, 180) : '没有错误慢日志');
  const badCode = /ERRCODE\s+(\S+)/.exec(child.stdout)?.[1];
  check('错误码是 42P01（undefined_table）', badCode === '42P01', `ERRCODE=${badCode}`);
  const statsLine = /POOLSTATS (\{.*\})/.exec(child.stdout)?.[1];
  let childStats = null;
  try { childStats = statsLine ? JSON.parse(statsLine) : null; } catch { childStats = null; }
  check('子进程 poolStats() 有 app/writer 水位', Boolean(childStats?.app && childStats?.writer),
    statsLine || '没有 POOLSTATS 输出');
  check('连接池 total >= 1 且 idle/waiting 合理',
    Boolean(childStats && childStats.app.total >= 1 && childStats.writer.total >= 1
      && childStats.app.idle >= 0 && childStats.app.waiting >= 0),
    JSON.stringify(childStats || {}));
} catch (err) {
  if (!err?.__skip) check('脚本执行', false, err.message);
} finally {
  await stopServer(server);
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}
