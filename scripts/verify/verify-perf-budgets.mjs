// 性能预算 + N+1 回归（本轮审计：会话页成员查询改成 LATERAL 索引查找）
//
// 为什么要有这个脚本：
//   - 「慢」在功能测试里看不出来：结果一样、只是多扫了一张表。这里用两条互补的断言兜住：
//     1) 预算：5 个热点接口在本机 10 并发 × 30 次下的 p50/p95（宽松阈值，抓的是数量级回退，
//        不是微秒级抖动；机器上有别的测试在跑时也能过）；
//     2) 计划：会话页成员查询必须对每个成员走 principals_pkey / agents_pkey，
//        一旦有人把 LATERAL 改回普通 JOIN，规划器会退化成 Seq Scan(principals)（2905 行），
//        预算可能还看不出来，这条断言会直接红。
//   - 另有一条静态断言：listConversationsFor / getMessages 里的 DB 调用次数有上界，
//     防止有人往里加「每个会话再查一次」的 N+1（当前会话页 2 条 SQL：列表 + 成员）。
//
// 用法：
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-perf-budgets.mjs
//   DATABASE_URL=postgres://postgres@127.0.0.1:5434/aio BASE=... node ...   # 额外跑计划断言
// 无服务（BASE 不可达）→ SKIP 退出 0；无 DATABASE_URL → 跳过计划断言（打印 SKIP 行）。
// 只用 demo 账号读接口：不打印密码/token/消息正文，不写任何数据（测试数据无需清理）。
import http from 'node:http';
import { readFileSync } from 'node:fs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.DATABASE_URL || '';
const EMAIL = process.env.DEMO_EMAIL || 'demo@qqmini.dev';
const PASSWORD = process.env.DEMO_PASSWORD || 'demo-qqmini-2026';
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY || 10);
const REQUESTS = Number(process.env.PERF_REQUESTS || 30);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, why) {
  console.log(`SKIP  ${name}  — ${why}`);
}

const u = new URL(BASE);
const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(CONCURRENCY, 4) });

function get(path, cookie) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request({ hostname: u.hostname, port: u.port, path, method: 'GET', agent, headers: cookie ? { cookie } : {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ms: performance.now() - t0, status: res.statusCode }));
    });
    req.on('error', () => resolve({ ms: performance.now() - t0, status: 0 }));
    req.end();
  });
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] || 0; };

// ---------------------------------------------------------------- 探活
const health = await get('/healthz').catch(() => null);
if (!health || health.status !== 200) {
  console.log(`SKIP  服务不可达（${BASE}）—— 先起 8787 再跑本脚本`);
  process.exit(0);
}

// ---------------------------------------------------------------- 登录 + 目标
const loginRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const loginJson = await loginRes.json().catch(() => null);
const sid = (loginRes.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
if (loginRes.status !== 200 || !sid) {
  console.log(`SKIP  演示账号登录失败（status=${loginRes.status}）—— 不打印凭据`);
  process.exit(0);
}
const cookie = sid;
const meId = Number(loginJson?.me?.id || 0);
const convs = await fetch(BASE + '/api/conversations?offset=0&limit=50', { headers: { cookie } }).then((r) => (r.ok ? r.json() : null));
if (!Array.isArray(convs) || !convs.length) {
  console.log('SKIP  演示账号没有会话，无法测 messages/members');
  process.exit(0);
}
const conv = convs.find((c) => Number(c.lastSeq) > 0) || convs[0];
const accountNo = (convs.flatMap((c) => c.members || []).find((m) => m.accountNo && Number(m.id) !== meId) || {}).accountNo || 10000;

// ---------------------------------------------------------------- 预算测量
// 阈值刻意宽松：本机有其它测试/CI 并发时 p95 会抖到几十毫秒；这里抓的是「数量级回退」
// （例如成员查询从索引查找退回整表扫、或有人加了 N+1，p95 会从 ~20ms 跳到几百毫秒）。
const BUDGETS = [
  // /api/me 只是「1 条会话查询 + 映射」，p95 的尾巴来自本机 PG 建连（Windows loopback ~55ms/条）
  // 与其它测试的并发，不是查询本身；阈值给宽一点，避免把环境抖动当成回归。
  ['me', '/api/me', { p50: 40, p95: 200 }],
  ['conversations', '/api/conversations?offset=0&limit=50', { p50: 60, p95: 150 }],
  ['messages', `/api/conversations/${conv.id}/messages?limit=50`, { p50: 60, p95: 150 }],
  ['members', `/api/conversations/${conv.id}/members`, { p50: 60, p95: 150 }],
  // 数字查询有 10 次/分钟限流（429），这里用昵称模糊查询（同一张表的另一条索引路径）
  ['directory', '/api/directory?q=demo', { p50: 60, p95: 150 }],
];

async function measure(path) {
  for (let i = 0; i < 10; i += 1) await get(path, cookie); // 预热：命名语句准备 + 连接池
  const times = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= REQUESTS) return;
      const r = await get(path, cookie);
      if (r.status !== 200) errors += 1;
      times.push(r.ms);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, worker));
  return { p50: med(times), p95: pct(times, 95), max: Math.max(...times), errRate: errors / REQUESTS };
}

console.log(`\n=== 预算（${BASE}，${CONCURRENCY} 并发 × ${REQUESTS} 次） ===`);
// 先把连接池焐热：本机 PG 建连约 55ms/条（Windows loopback），池 max=10 时首批并发请求
// 会排队建连（实测首轮 p95 可达 600ms）。这不是查询问题，但会让预算测量失真：
// 先连发 3 轮 C 并发的小请求，把池撑到稳态，再开始计时。
for (let round = 0; round < 3; round += 1) {
  await Promise.all(Array.from({ length: Math.max(CONCURRENCY, 4) }, () => get('/api/me', cookie)));
}
for (const [name, path, budget] of BUDGETS) {
  const m = await measure(path);
  const ok = m.errRate === 0 && m.p50 <= budget.p50 && m.p95 <= budget.p95;
  check(
    `${name}：p50≤${budget.p50}ms / p95≤${budget.p95}ms / 0 错误`,
    ok,
    `p50=${m.p50.toFixed(1)}ms p95=${m.p95.toFixed(1)}ms max=${m.max.toFixed(1)}ms err=${(m.errRate * 100).toFixed(0)}%`,
  );
}

// ---------------------------------------------------------------- 计划断言（需要 DATABASE_URL）
if (!DB_URL) {
  skip('计划断言（成员查询不走 Seq Scan principals）', '未设置 DATABASE_URL');
} else {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const { READ_SQL } = await import('../../src/core/query.mjs');

  const { rows: idsRows } = await client.query(
    'SELECT conversation_id FROM conversation_members WHERE principal_id = $1 ORDER BY conversation_id LIMIT 50',
    [meId],
  );
  const ids = idsRows.map((r) => Number(r.conversation_id));

  const { rows: planRows } = await client.query(
    `EXPLAIN (FORMAT JSON) ${READ_SQL.listConversationMembers}`,
    [ids.length ? ids : [conv.id]],
  );
  const nodes = [];
  const walk = (n) => { nodes.push(n); for (const c of n.Plans || []) walk(c); };
  walk(planRows[0]['QUERY PLAN'][0].Plan);
  const rel = (name) => nodes.filter((n) => n['Relation Name'] === name);
  const principalsSeq = rel('principals').filter((n) => n['Node Type'] === 'Seq Scan');
  const agentsSeq = rel('agents').filter((n) => n['Node Type'] === 'Seq Scan');
  const pIdx = rel('principals').filter((n) => n['Index Name'] === 'principals_pkey');
  const aIdx = rel('agents').filter((n) => n['Index Name'] === 'agents_pkey');
  console.log(`\n=== 会话页成员查询计划（${ids.length} 个会话） ===`);
  console.log(`      principals 节点：${rel('principals').map((n) => `${n['Node Type']}${n['Index Name'] ? '(' + n['Index Name'] + ')' : ''}`).join(' + ') || '(无)'}`);
  console.log(`      agents 节点：${rel('agents').map((n) => `${n['Node Type']}${n['Index Name'] ? '(' + n['Index Name'] + ')' : ''}`).join(' + ') || '(无)'}`);
  check(
    '成员查询：principals 不再整表 Seq Scan（LATERAL 索引查找仍在）',
    principalsSeq.length === 0 && pIdx.length > 0,
    principalsSeq.length ? '出现 Seq Scan(principals)' : `principals_pkey × ${pIdx.length}`,
  );
  check(
    '成员查询：agents 不再整表 Seq Scan',
    agentsSeq.length === 0 && aIdx.length > 0,
    agentsSeq.length ? '出现 Seq Scan(agents)' : `agents_pkey × ${aIdx.length}`,
  );
  await client.end();
}

// ---------------------------------------------------------------- 静态 N+1 断言
// 会话页/消息页每次请求的 DB 调用次数有上界；函数体里出现「循环里再查一次」就算 N+1。
{
  const src = readFileSync(new URL('../../src/core/query.mjs', import.meta.url), 'utf8');
  const sliceFn = (name) => {
    const start = src.indexOf(`export async function ${name}(`);
    if (start < 0) return '';
    const next = src.indexOf('\nexport ', start + 10);
    return src.slice(start, next < 0 ? src.length : next);
  };
  const countDbCalls = (body) => (body.match(/\b(readQuery|pool\.query)\(/g) || []).length;
  const convBody = sliceFn('listConversationsFor');
  const msgBody = sliceFn('getMessages');
  const convCalls = countDbCalls(convBody);
  const msgCalls = countDbCalls(msgBody);
  check('listConversationsFor：DB 调用 ≤2（列表 + 成员，无每会话 N+1）', convCalls > 0 && convCalls <= 2, `实际 ${convCalls}`);
  // getMessages 源码里 3 个 DB 调用点 = 成员资格 1 + 分页两分支各 1（运行时只走其中一条）；
  // 超过 3 基本就是往消息循环里塞了查询（附件补全在 hydrateMessageParts 里批量做）。
  check('getMessages：DB 调用 ≤3（成员资格 + 两个分页分支，无逐条查询）', msgCalls > 0 && msgCalls <= 3, `实际 ${msgCalls}`);
  check('getMessages：函数体里没有「循环内查询」', !/for\s*\([^)]*\)\s*{[^}]*\b(readQuery|pool\.query)\(/s.test(msgBody), '');
}

agent.destroy();
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('; '));
  process.exitCode = 1;
}
