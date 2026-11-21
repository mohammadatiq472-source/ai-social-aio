// 目录搜索（昵称/用户名 OR）的 trigram 索引回归（P1）
//
// 缺陷：src/core/query.mjs#directoryFor 的 WHERE 是
//   (p.display_name ILIKE $2 OR p.username ILIKE $2)
// 008 只给 display_name 建了 principals_name_trgm，username 没有索引。
// OR 的两臂都必须能走索引才可能变成 BitmapOr；一臂没有 → 优化器退化成 Seq Scan，
// 于是「按昵称或用户名搜人」在 principals 变大后每次都全表扫。
//
// 迁移 023 补 principals_username_trgm（gin(username gin_trgm_ops)）。
// 本脚本：
//   1) 断言 schema_migrations 有 023_username_trgm.sql、索引存在且是 gin_trgm_ops；
//   2) 在只读事务里 SET LOCAL enable_seqscan=off，EXPLAIN 真实 OR 查询，
//      断言出现 Bitmap Index Scan on principals_username_trgm（且是 BitmapOr 的一臂）。
//      事务最后 ROLLBACK —— 不写库、不 ANALYZE、不改任何数据。
//
// 用法：node scripts/verify/verify-directory-trgm.mjs
//       ADMIN_DATABASE_URL=postgres://...（缺省本机 5434/aio）
import pg from 'pg';

const DB_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';

// 与 query.mjs#directoryFor 保持同一形状（$1=自己 id，$2='%q%'，byNumber 走另一支）
const EXPLAIN_QUERY = `
  SELECT p.id, p.type, p.display_name, p.username, p.account_no
    FROM principals p LEFT JOIN agents a ON a.principal_id = p.id
   WHERE p.id <> 42 AND p.hidden = false
     AND (p.display_name ILIKE '%zzzzzz%' OR p.username ILIKE '%zzzzzz%')
     AND p.discoverable = true
   ORDER BY (a.owner_user_id = 42) DESC, p.type, p.display_name
   LIMIT 50`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.Plans || []) walk(child, out);
  return out;
}

const client = new pg.Client({ connectionString: DB_URL });
try {
  await client.connect();

  const mig = await client.query(
    "SELECT name FROM public.schema_migrations WHERE name = '023_username_trgm.sql'",
  );
  check('迁移 023_username_trgm.sql 已应用', mig.rows.length === 1,
    mig.rows[0]?.name || '没找到（先跑 node scripts/migrate.mjs）');

  const idx = await client.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'principals' AND indexname = 'principals_username_trgm'`,
  );
  const def = idx.rows[0]?.indexdef || '';
  check('索引 principals_username_trgm 存在', idx.rows.length === 1, def || '不存在');
  check('索引定义是 gin (username gin_trgm_ops)', /using gin/i.test(def) && /username\s+gin_trgm_ops/i.test(def), def);

  // 只读事务：SET LOCAL 只作用于本事务，EXPLAIN 不执行查询，最后 ROLLBACK
  await client.query('BEGIN');
  let plan = null;
  try {
    await client.query('SET LOCAL enable_seqscan = off');
    const ex = await client.query(`EXPLAIN (FORMAT JSON) ${EXPLAIN_QUERY}`);
    plan = ex.rows[0]['QUERY PLAN'][0].Plan;
  } finally {
    await client.query('ROLLBACK');
  }

  const nodes = walk(plan);
  const types = nodes.map((n) => n['Node Type']);
  console.log('Plan 节点：' + types.join(' → '));
  const byIndex = nodes.filter((n) => n['Node Type'] === 'Bitmap Index Scan').map((n) => n['Index Name']);
  console.log('Bitmap Index Scan：' + (byIndex.join(', ') || '（无）'));
  check('OR 查询走 BitmapOr（两臂都是索引）', types.includes('BitmapOr'), types.join(' → '));
  check('username 一臂走 Bitmap Index Scan on principals_username_trgm',
    byIndex.includes('principals_username_trgm'), byIndex.join(', ') || '（无）');
  check('display_name 一臂仍走 principals_name_trgm',
    byIndex.includes('principals_name_trgm'), byIndex.join(', ') || '（无）');
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
