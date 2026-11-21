// 导入表情包目录 → 数据库（幂等）
// 用法：node scripts/import-pack.mjs web/public/packs/deepwhale-placeholder --scope official
// pack.json 格式见 docs/表情包子系统.md §6
import fs from 'node:fs';
import path from 'node:path';
import { pool, closeDb } from '../src/db.mjs';

const dir = process.argv[2];
const scopeArg = process.argv.find((a) => a.startsWith('--scope='))?.split('=')[1]
  || (process.argv.includes('--scope') ? process.argv[process.argv.indexOf('--scope') + 1] : 'official');

if (!dir) {
  console.error('用法: node scripts/import-pack.mjs <pack目录> [--scope official|public|private]');
  process.exit(1);
}
const manifestPath = path.join(dir, 'pack.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`找不到 ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const items = Array.isArray(manifest.items) ? manifest.items : [];
if (!manifest.slug || !items.length) {
  console.error('pack.json 缺 slug 或 items');
  process.exit(1);
}

// 静态 URL：统一 /packs/<slug>/<包内相对路径>，由 nginx 从 web/dist/packs 直接托管
const staticPrefix = (file) => {
  const rel = path.relative(path.resolve(dir), path.resolve(dir, file)).split(path.sep).join('/');
  return `/packs/${manifest.slug}/${rel}`;
};

let inserted = 0;
let updated = 0;

const packRes = await pool.query(
  `INSERT INTO sticker_packs (slug, title, owner_id, scope, license, cover_key, review_state)
   VALUES ($1,$2,NULL,$3,$4,$5,'approved')
   ON CONFLICT (slug) DO UPDATE
     SET title = EXCLUDED.title, scope = EXCLUDED.scope, license = EXCLUDED.license,
         cover_key = EXCLUDED.cover_key, review_state = 'approved', updated_at = now()
   RETURNING id`,
  [manifest.slug, manifest.title || manifest.slug, scopeArg, manifest.license || 'unknown', items[0]?.key || null],
);
const packId = Number(packRes.rows[0].id);

for (let i = 0; i < items.length; i++) {
  const it = items[i];
  if (!it.key || !it.file) {
    console.warn(`  跳过无效条目：${JSON.stringify(it).slice(0, 60)}`);
    continue;
  }
  const abs = path.resolve(dir, it.file);
  if (!fs.existsSync(abs)) {
    console.warn(`  跳过（文件不存在）：${it.file}`);
    continue;
  }
  const sp = staticPrefix(it.file);
  const r = await pool.query(
    `INSERT INTO sticker_items (pack_id, key, static_path, tags, emotion, caption, sort)
     VALUES ($1,$2,$3,$4::text[],$5,$6,$7)
     ON CONFLICT (pack_id, key) DO UPDATE
       SET static_path = EXCLUDED.static_path, tags = EXCLUDED.tags,
           emotion = EXCLUDED.emotion, caption = EXCLUDED.caption, sort = EXCLUDED.sort
     RETURNING (xmax = 0) AS is_insert`,
    [packId, it.key, sp, it.tags || [], it.emotion || null, it.caption || it.key, i],
  );
  if (r.rows[0]?.is_insert) inserted++; else updated++;
}

await pool.query('UPDATE sticker_packs SET item_count = (SELECT count(*) FROM sticker_items WHERE pack_id=$1) WHERE id=$1', [packId]);
const { rows } = await pool.query('SELECT slug, scope, license, item_count FROM sticker_packs WHERE id=$1', [packId]);
console.log(JSON.stringify({
  ok: true,
  pack: rows[0],
  inserted,
  updated,
  total: items.length,
}, null, 2));

await closeDb();
