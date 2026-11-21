// agent_tokens.last_used_at 写入节流回归（P1）
//
// 缺陷：src/auth/service.mjs 以前每个 Bearer 请求都无条件
//   UPDATE agent_tokens SET last_used_at = now() WHERE id = $1
// MCP 是拉模式（客户端轮询 whats_new / ping），一次轮询就是一次写：
// agent_tokens 每行被高频 UPDATE，n_tup_upd 线性增长、n_tup_hot_upd 基本为 0
// （索引列/页空间不足时 HOT 不成立），白白制造 WAL 与 autovacuum 压力。
// last_used_at 只服务「成员面板最近 5 分钟」的展示口径，60 秒精度完全够用。
//
// 本脚本：demo 建一只 AI 拿 token → 对 /mcp 发 1 次 initialize + 30 次 ping
//   → 读 pg_stat_user_tables.agent_tokens 的 n_tup_upd 增量，断言 ≤ 2。
// 修复前应看到 ~31，修复后应看到 1（首次补写）。
//
// 注意：n_tup_upd 是**表级**累计计数。默认窗口只有几百毫秒；若同一时刻别的
// 客户端也在用 AI token，计数会被它们抬高 —— 这是脚本已知噪声，输出里会打印
// 绝对前后值与耗时，便于判断。
//
// 用法：node scripts/verify/verify-token-touch.mjs
//       BASE=http://127.0.0.1:8787 ADMIN_DATABASE_URL=postgres://... node ...
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const res = await fetch(`${BASE}${path}`, {
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

async function login() {
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' },
  });
  if (r.status !== 200 || !r.cookie) throw new Error(`demo 登录失败 ${r.status} ${r.text.slice(0, 160)}`);
  return r.cookie;
}

async function readTokenUpdates(client) {
  // 新会话/新语句能看到最新统计；pg_stat_user_tables 在事务提交后即可见。
  const { rows } = await client.query(
    `SELECT n_tup_upd::bigint AS upd, n_tup_hot_upd::bigint AS hot
       FROM pg_stat_user_tables
      WHERE schemaname = 'public' AND relname = 'agent_tokens'`,
  );
  if (!rows[0]) throw new Error('pg_stat_user_tables 里没有 agent_tokens（统计被重置？）');
  return { upd: Number(rows[0].upd), hot: Number(rows[0].hot) };
}

const client = new pg.Client({ connectionString: DB_URL });
let cookie = '';
let token = '';
try {
  await client.connect();
  cookie = await login();
  check('准备：demo 登录拿到会话', Boolean(cookie));

  const created = await api('/api/agents', {
    method: 'POST',
    cookie,
    body: { display_name: `触达${rnd()}` },
  });
  token = created.json?.token;
  check('准备：demo 建 AI 并拿到一次性 token', created.status === 200 && Boolean(token),
    `status=${created.status} agent_id=${created.json?.agent?.id ?? '-'}`);

  const before = await readTokenUpdates(client);

  const init = await api('/mcp', {
    method: 'POST',
    token,
    body: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'token-touch-test', version: '1.0.0' } },
    },
  });
  check('MCP initialize → 200', init.status === 200, `status=${init.status}`);

  const t0 = Date.now();
  let pingOk = 0;
  for (let i = 0; i < 30; i += 1) {
    const r = await api('/mcp', {
      method: 'POST',
      token,
      body: { jsonrpc: '2.0', id: 100 + i, method: 'ping' },
    });
    if (r.status === 200 && r.json?.result !== undefined) pingOk += 1;
  }
  const elapsed = Date.now() - t0;
  check('MCP ping 30 次全部成功', pingOk === 30, `${pingOk}/30，耗时 ${elapsed}ms`);

  await sleep(400); // 给最后一次请求一点时间；统计延迟见下面的轮询
  // Postgres 的累积统计（pg_stat_user_tables）不一定立刻可见：后端把 pending 计数
  // flush 到共享内存有分钟级以下的延迟，实测本机 5–10s 才出现。所以轮询到 20s：
  // 修复前 31 次更新会在某一刻一起出现并立刻判 FAIL；修复后一直是 0/1。
  const t1 = Date.now();
  let after = await readTokenUpdates(client);
  let dUpd = after.upd - before.upd;
  while (dUpd <= 2 && Date.now() - t1 < 20_000) {
    await sleep(500);
    await client.query('SELECT pg_stat_clear_snapshot()').catch(() => {});
    after = await readTokenUpdates(client);
    dUpd = after.upd - before.upd;
  }
  const dHot = after.hot - before.hot;
  const waited = Date.now() - t1;

  console.log(`agent_tokens 统计：n_tup_upd ${before.upd} → ${after.upd}（+${dUpd}），`
    + `n_tup_hot_upd ${before.hot} → ${after.hot}（+${dHot}），等待统计 ${waited}ms`);
  check('1 次 initialize + 30 次 ping 只触发 ≤2 次 agent_tokens 更新（60s 节流生效）',
    dUpd <= 2, `增量=${dUpd}（修复前预期 31；表级计数，若并行有别的 token 在使用会偏高）`);
} catch (err) {
  check('脚本执行', false, err.message);
} finally {
  await client.end().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}
