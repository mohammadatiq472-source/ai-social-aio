// MCP 每 Agent 读工具限流回归（P2-10）
//
// 契约：
//   1. 默认参数：全局 120 次/分钟 burst 20；search_messages 单独 20 次/分钟 burst 5；
//   2. 超限是「工具级结果」：HTTP 200 + result.isError=true +
//      content[0].text 里 reason_code=rate_limited + retry_after_ms（不是 5xx）；
//   3. 限流键是 agent principal id：另一个 Agent 不受影响；
//   4. 写工具不在这里扣（send_message 仍走业务门控，不会先被 rate_limited）；
//   5. 日志/响应不出现 token。
//
// 做法：自建 8793 临时服务（不动 8787），用低阈值缩短测试：
//   服务 1：MCP_RATE_PER_MIN=1 MCP_RATE_BURST=2 → 第 3 次 my_limits 超限；
//   服务 2：MCP_SEARCH_PER_MIN=1 MCP_SEARCH_BURST=5 → 第 6 次 search_messages 超限。
// 无 DB 环境 → SKIP exit 0。
//
// 用法：node scripts/verify/verify-mcp-rate-limit.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.RATE_PORT || 8793);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
const WRITER_URL = process.env.WRITER_DATABASE_URL || DB_URL;
const MEDIA_DIR = path.resolve(process.env.RATE_MEDIA_DIR || 'tmp/ratemedia');
const ROOT = path.resolve('.');
const rnd = () => crypto.randomBytes(4).toString('hex');

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

function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
        SESSION_SECRET: 'rate-dev-secret',
        SECURE_COOKIE: 'false',
        PUBLIC_BASE_URL: BASE,
        DATABASE_URL: DB_URL,
        WRITER_DATABASE_URL: WRITER_URL,
        MEDIA_DIR,
        ...extraEnv,
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
          const r = await fetch(`${BASE}/healthz`);
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

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function rpc(token, body) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

async function toolCall(token, id, name, args) {
  const r = await rpc(token, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  let payload = null;
  try { payload = JSON.parse(r.json?.result?.content?.[0]?.text || 'null'); } catch { payload = null; }
  return { status: r.status, json: r.json, isError: r.json?.result?.isError, payload };
}

async function createAgent(cookie, name) {
  const r = await api('/api/agents', { method: 'POST', cookie, body: { display_name: name } });
  return { id: r.json?.agent?.id ?? null, token: r.json?.token ?? '' };
}

const probe = new pg.Client({ connectionString: DB_URL });
try {
  await probe.connect();
  await probe.query('SELECT 1');
} catch (err) {
  console.log(`SKIP：连不上数据库（${err.code || err.message}），无法验证限流后的工具调用`);
  await probe.end().catch(() => {});
  process.exit(0);
}
await probe.end().catch(() => {});

let server = null;
let cookie = '';
const createdAgents = [];
try {
  await fs.rm(MEDIA_DIR, { recursive: true, force: true });

  // 默认参数断言（仅当环境没被其它测试改过）
  const envKeys = ['MCP_RATE_PER_MIN', 'MCP_RATE_BURST', 'MCP_SEARCH_PER_MIN', 'MCP_SEARCH_BURST'];
  if (!envKeys.some((k) => process.env[k] !== undefined)) {
    const { config } = await import('../../src/config.mjs');
    const c = config.mcpRate;
    check('默认限流参数 = 120/min burst 20 + search 20/min burst 5',
      c.perMin === 120 && c.burst === 20 && c.searchPerMin === 20 && c.searchBurst === 5,
      JSON.stringify(c));
  } else {
    skip('默认参数断言', '环境里已有 MCP_* 覆盖，跳过静态默认值');
  }

  // ---------------- 服务 1：全局读工具 burst=2 ----------------
  server = await startServer({
    MCP_RATE_PER_MIN: '1', MCP_RATE_BURST: '2',
    MCP_SEARCH_PER_MIN: '100', MCP_SEARCH_BURST: '10',
  });
  console.log(`${BASE}（服务1：全局 1/min burst 2）`);

  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' },
  });
  cookie = login.cookie;
  check('准备：demo 登录', login.status === 200 && Boolean(cookie));

  const A = await createAgent(cookie, `限流A${rnd()}`);
  const B = await createAgent(cookie, `限流B${rnd()}`);
  if (A.id) createdAgents.push(A.id);
  if (B.id) createdAgents.push(B.id);
  check('准备：两个 Agent token（A/B 不同 key）', Boolean(A.token) && Boolean(B.token));

  const a1 = await toolCall(A.token, 1, 'my_limits', {});
  const a2 = await toolCall(A.token, 2, 'my_limits', {});
  const a3 = await toolCall(A.token, 3, 'my_limits', {});
  check('全局 burst 内前 2 次 my_limits 成功',
    a1.isError === false && a2.isError === false, `isError=${a1.isError}/${a2.isError}`);
  check('第 3 次 my_limits 被限流（HTTP 200 + isError）',
    a3.status === 200 && a3.isError === true && a3.payload?.reason_code === 'rate_limited',
    `status=${a3.status} payload=${JSON.stringify(a3.payload)?.slice(0, 180)}`);
  check('限流结果带 retry_after_ms（正整数，<=60s）',
    Number.isInteger(a3.payload?.retry_after_ms) && a3.payload.retry_after_ms > 0 && a3.payload.retry_after_ms <= 60_000,
    `retry_after_ms=${a3.payload?.retry_after_ms}`);
  check('全局限流 scope=read_tools', a3.payload?.limit?.scope === 'read_tools',
    JSON.stringify(a3.payload?.limit));

  const b1 = await toolCall(B.token, 4, 'my_limits', {});
  check('另一个 Agent 不受影响（不同 principal key）', b1.isError === false,
    `isError=${b1.isError}`);

  // 写工具不被这个限流扣：A 的全局桶已空，但 send_message 仍走业务校验
  const w = await toolCall(A.token, 5, 'send_message', {});
  check('写工具不被读限流提前拦截（仍是业务 invalid_schema）',
    w.isError === true && w.payload?.reason_code !== 'rate_limited',
    JSON.stringify(w.payload)?.slice(0, 160));

  const log1 = server.log();
  check('服务日志不含 token', !log1.includes(A.token) && !log1.includes(B.token));
  check('限流响应/日志不含 token', !JSON.stringify(a3.json).includes(A.token));
  await stopServer(server);
  server = null;

  // ---------------- 服务 2：search_messages 专属桶 burst=5 ----------------
  server = await startServer({
    MCP_RATE_PER_MIN: '100', MCP_RATE_BURST: '10',
    MCP_SEARCH_PER_MIN: '1', MCP_SEARCH_BURST: '5',
  });
  console.log(`${BASE}（服务2：search 1/min burst 5）`);

  const searchResults = [];
  for (let i = 0; i < 6; i += 1) {
    searchResults.push(await toolCall(A.token, 100 + i, 'search_messages', { query: '测试' }));
  }
  check('search_messages 前 5 次成功',
    searchResults.slice(0, 5).every((r) => r.isError === false),
    searchResults.slice(0, 5).map((r) => r.isError).join(','));
  const s6 = searchResults[5];
  check('第 6 次 search_messages 被专属桶限流',
    s6.isError === true && s6.payload?.reason_code === 'rate_limited',
    JSON.stringify(s6.payload)?.slice(0, 180));
  check('search 限流 scope=search_messages 且 retry_after_ms 有效',
    s6.payload?.limit?.scope === 'search_messages'
    && Number.isInteger(s6.payload?.retry_after_ms) && s6.payload.retry_after_ms > 0,
    `scope=${s6.payload?.limit?.scope} retry=${s6.payload?.retry_after_ms}`);

  const bSearch = await toolCall(B.token, 200, 'search_messages', { query: '测试' });
  check('search 限流也是 per-Agent（B 仍可搜）', bSearch.isError === false,
    `isError=${bSearch.isError}`);

  const log2 = server.log();
  check('服务2 日志不含 token', !log2.includes(A.token) && !log2.includes(B.token));
} catch (err) {
  if (!err?.__skip) check('脚本执行', false, err.message);
} finally {
  // 清理临时 Agent（尽力；失败不影响结论）
  for (const id of createdAgents) {
    try { await api(`/api/agents/${id}`, { method: 'DELETE', cookie }); } catch { /* ignore */ }
  }
  await stopServer(server);
  await fs.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}
