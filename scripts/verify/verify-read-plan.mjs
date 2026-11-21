// 消息读路径的计划回归（审计 #4 命名预处理语句 / #5 视图双读）
//
// 为什么要有这个脚本：
//   1) 消息页以前查视图 `messages`（= messages_meta JOIN events），规划器把 LIMIT 压到
//      join 之后，实测走 messages_sender_created_idx 把整个会话的 242 行扫出来再排序取 50；
//      现在先按 (conversation_id, seq) 走 messages_pkey 物化窗口，再按 event_id 回表。
//      这种回退在功能测试里完全看不出来（结果一样、只是慢），只能靠 EXPLAIN 抓住。
//   2) 热点读查询加了稳定 name（连接级 prepared statement），省掉每条请求的 Parse+规划；
//      这里做「同连接命名 vs 未命名」的 20 次计时对比，命名版必须不慢于未命名（留 20% 噪声）。
//
// 覆盖：
//   1. getMessages(since) / getMessages(before) / getMessageBySeq：窗口子计划（CTE win）
//      必须是 messages_pkey + Index Cond，且全程不出现 messages_sender_created_idx
//   2. whatsNewFor：events 只出现一次（旧视图会让它出现两次）
//   3. 静态守卫：这些 SQL 不再引用视图 messages
//   4. 命名 vs 未命名：p50 计时 + 结果一致
//   5. whats_new 的 generic plan 守卫（第 6 次执行后不能退回 events_pkey 全扫）
//   6. readQuery 的 26000 自愈（DEALLOCATE ALL 后必须自动降级成功）
//
// 用法：DATABASE_URL=postgres://postgres@127.0.0.1:5434/aio node scripts/verify/verify-read-plan.mjs
// 无 DATABASE_URL 时 SKIP（退出 0）——纯静态/无库环境跑全量回归不该因此变红。
import pg from 'pg';

const { Client } = pg;
const DB_URL = process.env.DATABASE_URL || '';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function note(line) {
  console.log(`      ${line}`);
}

if (!DB_URL) {
  console.log('SKIP  未设置 DATABASE_URL（本脚本需要直连 PG 跑 EXPLAIN）');
  process.exit(0);
}

// 这个进程只借 src/db.mjs 的 pool 做「命名语句自愈」那一条：把池压到 1 条连接，
// 才能保证 pool.query 复用同一条连接（否则 pool 可能换连接、测不到 26000 路径）。
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '1';
const { READ_SQL } = await import('../../src/core/query.mjs');
const { closeDb } = await import('../../src/db.mjs');

// ---------------------------------------------------------------- 计划工具
function allNodes(plan) {
  const out = [];
  const walk = (n) => {
    out.push(n);
    for (const c of n.Plans || []) walk(c);
  };
  walk(plan);
  return out;
}

/** MATERIALIZED CTE 的子计划在 JSON 里带 "Subplan Name": "CTE win" */
function cteSubplan(plan, cteName) {
  return allNodes(plan).find((n) => String(n['Subplan Name'] || '') === `CTE ${cteName}`) || null;
}

function scanLine(n) {
  const rel = n['Relation Name'] || '-';
  const idx = n['Index Name'] ? ` idx=${n['Index Name']}` : '';
  const cond = n['Index Cond'] ? ` cond=${n['Index Cond']}` : '';
  return `${n['Node Type']}(${rel})${idx}${cond}`;
}

/**
 * 断言「窗口子计划走 messages_pkey + Index Cond + LIMIT」。
 *
 * 为什么要分两档：
 *   - 默认计划（planner 自己选）：小表（生产 90 条 / CI 空表）走 Seq Scan + Sort 是**合法**的，
 *     强求 messages_pkey 会让脚本只在本地大库绿、上生产就红。这里只守「绝不回到
 *     messages_sender_created_idx 整索引扫」这条真正的回退。
 *   - 强制计划（enable_seqscan=off）：必须能走 messages_pkey + Index Cond + 方向，
 *     证明查询形状本身没有丢掉索引条件（大库上 planner 就会这么选）。
 */
function assertWindowPlan(label, plan, { cteName = 'win', expectSeqOp = null, forced = false } = {}) {
  const sub = cteSubplan(plan, cteName);
  if (!sub) {
    check(`${label}：窗口物化子计划存在（CTE ${cteName}）`, false, '找不到 Subplan Name="CTE win"');
    return;
  }
  const nodes = allNodes(sub);
  const scans = nodes.filter((n) => n['Relation Name'] === 'messages_meta');
  const scanLines = scans.map(scanLine).join(' | ') || '(无)';
  note(`窗口子计划节点：${nodes.map((n) => n['Node Type']).join(' -> ')}`);
  note(`messages_meta 扫描：${scanLines}`);

  const idx = scans.find((n) => n['Index Name'] === 'messages_pkey');
  const hasLimit = nodes.some((n) => n['Node Type'] === 'Limit');
  const badIdx = allNodes(plan).filter((n) => n['Index Name'] === 'messages_sender_created_idx');
  check(
    `${label}：全程不走 messages_sender_created_idx`,
    badIdx.length === 0,
    badIdx.length ? `命中 ${badIdx.length} 次` : '',
  );
  check(`${label}：窗口内先 LIMIT 再回表（Limit 在子计划里）`, hasLimit, hasLimit ? '' : '子计划里没有 Limit');

  if (!forced) {
    // 默认计划只要求「没有回退」；小表 Seq Scan 不判红。
    check(
      `${label}：默认计划没有回到整索引扫（Seq Scan 在小表上允许）`,
      badIdx.length === 0,
      scans.length ? `messages_meta: ${scanLines}` : '',
    );
    return;
  }
  check(
    `${label}：强制索引时窗口按 messages_pkey 取`,
    Boolean(idx) && scans.length === 1,
    idx ? `Index Cond=${idx['Index Cond']}` : `实际=${scanLines}`,
  );
  check(
    `${label}：强制索引时带 Index Cond（conversation_id + seq）`,
    Boolean(idx) && /conversation_id/.test(String(idx['Index Cond'] || '')) && /seq/.test(String(idx['Index Cond'] || '')),
    idx ? String(idx['Index Cond']) : '无 Index Cond',
  );
  if (expectSeqOp) {
    check(
      `${label}：seq 比较方向正确（${expectSeqOp}）`,
      Boolean(idx) && new RegExp(`seq ${expectSeqOp}`).test(String(idx['Index Cond'] || '')),
      idx ? String(idx['Index Cond']) : '无 Index Cond',
    );
  }
}

// ---------------------------------------------------------------- 数据上下文
const client = new Client({ connectionString: DB_URL });
await client.connect();

const { rows: ctxRows } = await client.query(
  `SELECT m.conversation_id, max(m.seq) AS last_seq, count(*)::int AS n
     FROM messages_meta m GROUP BY 1 ORDER BY n DESC LIMIT 1`,
);
let cid;
let lastSeq;
if (ctxRows[0]) {
  cid = Number(ctxRows[0].conversation_id);
  lastSeq = Number(ctxRows[0].last_seq);
} else {
  const { rows } = await client.query('SELECT id FROM conversations ORDER BY id LIMIT 1');
  cid = rows[0] ? Number(rows[0].id) : 1;
  lastSeq = 0;
}
const midSeq = Math.max(1, Math.floor(lastSeq / 2));
console.log(`样本会话 conversation_id=${cid} last_seq=${lastSeq}（没有消息时用空会话，只校验计划形状）\n`);

async function explain(sql, values) {
  const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, values);
  // QUERY PLAN[0] 是 { Plan, Planning Time, ... }；断言只需要 Plan 这棵节点树
  return rows[0]['QUERY PLAN'][0].Plan;
}

/**
 * 关掉 Seq Scan / Bitmap Scan 后再 EXPLAIN：证明查询形状本身能命中 (conversation_id, seq) 索引。
 *
 * 为什么必须连 bitmap 一起关（2026-11-19）：小样本会话只有个位数行时，`enable_seqscan=off`
 * 之后 planner 会选 **Bitmap Heap Scan(messages_pkey)**——索引条件其实一样对，只是走了 bitmap 路径。
 * 断言只认 `Index Scan` + `Index Cond`，于是「本地几行的小库红、生产大库绿」，变成一条靠数据量
 * 决定颜色的假红/假绿。关掉 bitmap 后强制走普通 Index Scan，测的仍然是「查询形状有没有丢索引条件」。
 */
async function explainForced(sql, values) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    return await explain(sql, values);
  } finally {
    await client.query('ROLLBACK');
  }
}

// ---------------------------------------------------------------- 1. 窗口计划
const sincePlan = await explain(READ_SQL.messagesSince, [cid, 0, 50]);
const sinceForced = await explainForced(READ_SQL.messagesSince, [cid, 0, 50]);
console.log(`=== getMessages(since) 计划 ===`);
assertWindowPlan('since', sincePlan, { expectSeqOp: '>' });
assertWindowPlan('since/forced', sinceForced, { expectSeqOp: '>', forced: true });

const beforePlan = await explain(READ_SQL.messagesBefore, [cid, lastSeq, 50]);
const beforeForced = await explainForced(READ_SQL.messagesBefore, [cid, lastSeq, 50]);
console.log(`\n=== getMessages(before) 计划 ===`);
assertWindowPlan('before', beforePlan, { expectSeqOp: '<' });
assertWindowPlan('before/forced', beforeForced, { expectSeqOp: '<', forced: true });

const bySeqPlan = await explain(READ_SQL.messageBySeq, [cid, midSeq]);
const bySeqForced = await explainForced(READ_SQL.messageBySeq, [cid, midSeq]);
console.log(`\n=== getMessageBySeq 计划 ===`);
assertWindowPlan('bySeq', bySeqPlan, { expectSeqOp: '=' });
assertWindowPlan('bySeq/forced', bySeqForced, { expectSeqOp: '=', forced: true });

// ---------------------------------------------------------------- 2. whats_new 不再双读 events
const wnPlan = await explain(READ_SQL.whatsNewFor, [0, [cid], 50]);
console.log(`\n=== whatsNewFor 计划 ===`);
{
  const nodes = allNodes(wnPlan);
  const eventScans = nodes.filter((n) => n['Relation Name'] === 'events');
  note(`events 扫描：${eventScans.map(scanLine).join(' | ') || '(无)'}`);
  note(`messages_meta 扫描：${nodes.filter((n) => n['Relation Name'] === 'messages_meta').map(scanLine).join(' | ') || '(无)'}`);
  check(
    'whatsNewFor：events 只出现一次（视图双读已消除）',
    eventScans.length === 1,
    `实际 ${eventScans.length} 次：${eventScans.map((n) => n['Node Type']).join(' + ')}`,
  );
  check(
    'whatsNewFor：按 messages_meta 取 hidden/recalled 过滤（不是视图）',
    nodes.some((n) => n['Relation Name'] === 'messages_meta'),
    '',
  );
}

// ---------------------------------------------------------------- 3. 静态守卫：不引用视图
console.log('\n=== SQL 静态守卫 ===');
for (const [label, sql] of [
  ['getMessages(since)', READ_SQL.messagesSince],
  ['getMessages(before)', READ_SQL.messagesBefore],
  ['getMessageBySeq', READ_SQL.messageBySeq],
  ['whatsNewFor', READ_SQL.whatsNewFor],
  ['whatsNewDigestFor', READ_SQL.whatsNewDigestFor],
]) {
  // \b 保证 messages_meta 不算：'messages_meta' 里 messages 后面是下划线（词字符）
  const usesView = /\b(FROM|JOIN)\s+messages\b/i.test(sql);
  check(`${label}：不引用视图 messages`, !usesView, usesView ? 'SQL 里仍有 FROM/JOIN messages' : '');
}

// ---------------------------------------------------------------- 4. 命名 vs 未命名
console.log('\n=== 命名预处理语句 vs 未命名（同一连接，各 20 次） ===');

async function timeQuery(cfg) {
  const t0 = performance.now();
  await client.query(cfg);
  return performance.now() - t0;
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

async function bench(label, name, sql, values) {
  // 预热：命名版第一次会 Parse+准备，未命名版每次都会规划；都先跑一次，计时从稳态开始
  const namedCfg = { name, text: sql, values };
  const plainCfg = { text: sql, values };
  const warmNamed = await client.query(namedCfg);
  const warmPlain = await client.query(plainCfg);
  const sameRows = JSON.stringify(warmNamed.rows) === JSON.stringify(warmPlain.rows);

  const named = [];
  const plain = [];
  // 交错采样：两个版本交替跑，抵消机器负载漂移（另一个 teammate 可能同时在跑测试）
  for (let i = 0; i < 20; i += 1) {
    named.push(await timeQuery(namedCfg));
    plain.push(await timeQuery(plainCfg));
  }
  const nP50 = median(named);
  const pP50 = median(plain);
  note(`${label} 命名版  p50=${nP50.toFixed(3)}ms min=${Math.min(...named).toFixed(3)} max=${Math.max(...named).toFixed(3)}`);
  note(`${label} 未命名  p50=${pP50.toFixed(3)}ms min=${Math.min(...plain).toFixed(3)} max=${Math.max(...plain).toFixed(3)}`);
  note(`${label} 原始样本 命名=[${named.map((v) => v.toFixed(2)).join(', ')}]`);
  note(`${label} 原始样本 未命名=[${plain.map((v) => v.toFixed(2)).join(', ')}]`);
  check(`${label}：命名版 p50 不慢于未命名（允许 20% 噪声）`, nP50 <= pP50 * 1.2, `命名 ${nP50.toFixed(3)}ms vs 未命名 ${pP50.toFixed(3)}ms`);
  check(`${label}：命名/未命名返回一致`, sameRows, sameRows ? `${warmNamed.rows.length} 行` : '行内容不同');
}

await bench('消息页 getMessages(since)', 'aio_verify_msgs_since', READ_SQL.messagesSince, [cid, 0, 50]);
await bench('whats_new', 'aio_verify_whats_new', READ_SQL.whatsNewFor, [0, [cid], 50]);

// whats_new 的 generic plan 陷阱：命名语句第 6 次执行后 PG 可能改用 generic plan，
// 那时它不知道 $1/$2 的选择性（估 1 行），会按 events_pkey 的 id 顺序边扫边过滤——
// since=0 时等于把整张 events 扫一遍（实测 12274 bufs vs custom 8037）。
// SQL 里 `ORDER BY e.id + 0` 就是阻止这条路径；这里直接取「第 21 次执行后」的计划守住它。
console.log('\n=== whats_new generic plan（命名语句第 6 次执行后） ===');
{
  const { rows } = await client.query(`EXPLAIN (FORMAT JSON) EXECUTE aio_verify_whats_new(0, '{${cid}}', 50)`);
  const nodes = allNodes(rows[0]['QUERY PLAN'][0].Plan);
  const ev = nodes.filter((n) => n['Relation Name'] === 'events');
  note(`events 扫描：${ev.map(scanLine).join(' | ') || '(无)'}`);
  const badOrdered = ev.filter((n) => n['Index Name'] === 'events_pkey' && /^\(id >/.test(String(n['Index Cond'] || '')));
  check(
    'whats_new：generic plan 不按 events_pkey 顺序全扫',
    badOrdered.length === 0,
    badOrdered.length ? `Index Cond=${badOrdered[0]['Index Cond']}` : '',
  );
  check(
    'whats_new：generic plan 走游标索引 events_message_cursor_idx',
    nodes.some((n) => n['Index Name'] === 'events_message_cursor_idx'),
    '',
  );
}

// ---------------------------------------------------------------- 5. 命名语句自愈
// 真实事故形态：PG 重启 / 后端被换掉 / 有人在这条连接上 DEALLOCATE ALL 之后，服务端
// 已经没有这条 prepared statement，而 node-pg 客户端记账还在 → 只发 Bind → 26000。
// readQuery 的约定是「捕获 26000，去掉 name 重试一次」。这里用 DEALLOCATE ALL 复现：
//   1) 先证明这个场景真的会报 26000（否则测试是空转）
//   2) 再证明 readQuery 能拿到结果
console.log('\n=== 命名语句自愈（26000 → 未命名重试） ===');
{
  const { pool, readQuery } = await import('../../src/db.mjs');
  const NAME = 'aio_verify_selfheal';
  const TEXT = 'SELECT $1::int AS n';
  const c = await pool.connect();
  try {
    await c.query({ name: NAME, text: TEXT, values: [1] }); // 正常准备一次
    await c.query('DEALLOCATE ALL');                        // 服务端语句消失（模拟重启/换后端）
  } finally {
    c.release();
  }
  let code = null;
  try {
    await pool.query({ name: NAME, text: TEXT, values: [1] });
  } catch (err) {
    code = err.code;
  }
  check('复现：语句丢失后命名查询报 26000', code === '26000', `code=${code}`);
  let n = null;
  let errMsg = '';
  try {
    const r = await readQuery(NAME, TEXT, [7]);
    n = Number(r.rows[0]?.n);
  } catch (err) {
    errMsg = err.message;
  }
  check('readQuery：26000 后自动降级未命名并成功', n === 7, errMsg || `n=${n}`);
}

await client.end();
await closeDb();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('; '));
  process.exitCode = 1;
}
