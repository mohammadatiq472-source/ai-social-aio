// 版本化迁移：按文件名顺序执行 sql/migrations/*.sql，已执行的记录在 schema_migrations。
// 用法：ADMIN_DATABASE_URL=postgres://... node scripts/migrate.mjs
// 兼容旧行为：没有 sql/migrations 目录时退回执行 sql/schema.sql。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'sql', 'migrations');
const LEGACY = path.join(ROOT, 'sql', 'schema.sql');

const url = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 ADMIN_DATABASE_URL 或 DATABASE_URL');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum   TEXT NOT NULL
    )
  `);

  const { rows: doneRows } = await client.query('SELECT name FROM public.schema_migrations');
  const done = new Set(doneRows.map((r) => r.name));

  if (!fs.existsSync(MIG_DIR)) {
    // 老路径：整份 schema.sql 幂等执行
    const sql = fs.readFileSync(LEGACY, 'utf8');
    await client.query(sql);
    console.log('（无 migrations 目录）已执行 sql/schema.sql');
  } else {
    const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
    if (!files.length) console.log('没有迁移文件');
    for (const file of files) {
      if (done.has(file)) {
        console.log(`跳过 ${file}（已执行）`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
      const crypto = await import('node:crypto');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
      process.stdout.write(`执行 ${file} … `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1,$2)', [file, checksum]);
        await client.query('COMMIT');
        // pg_dump 会 set search_path=''，迁移后必须复位，否则后续未限定表名会找不到
        await client.query('SET search_path = public');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`\n失败：${file}\n${err.message}`);
        process.exitCode = 1;
        throw err;
      }
    }
  }

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
  );
  const { rows: applied } = await client.query('SELECT name FROM public.schema_migrations ORDER BY name');
  console.log(`表 ${tables.length} 张：${tables.map((r) => r.table_name).join(', ')}`);
  console.log(`已应用迁移：${applied.map((r) => r.name).join(', ') || '（无）'}`);
} catch (err) {
  console.error('迁移失败：', err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
