// 压测数据：造一个 300 人的群（验证成员面板虚拟化），可一键清理
// 用法：
//   DATABASE_URL=... node tmp/seed-300.mjs          # 建
//   DATABASE_URL=... node tmp/seed-300.mjs --clean  # 删
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
const clean = process.argv.includes('--clean');
const N = Number(process.env.N || 300);
const client = new pg.Client({ connectionString: url });
await client.connect();

const demo = await client.query(
  "SELECT ua.principal_id AS id FROM user_accounts ua WHERE ua.email = 'demo@qqmini.dev'",
);
const demoId = Number(demo.rows[0]?.id);
if (!demoId) {
  console.error('找不到 demo@qqmini.dev');
  process.exit(1);
}

if (clean) {
  const conv = await client.query("SELECT id FROM conversations WHERE title = '压测 300 人（临时）'");
  for (const row of conv.rows) {
    await client.query('DELETE FROM conversation_members WHERE conversation_id = $1', [row.id]);
    await client.query('DELETE FROM conversations WHERE id = $1', [row.id]);
  }
  const del = await client.query("DELETE FROM principals WHERE username LIKE 'loadtest\\_%'");
  console.log('已清理：群', conv.rowCount, '临时成员', del.rowCount);
  await client.end();
  process.exit(0);
}

await client.query('BEGIN');
const ids = [];
for (let i = 1; i <= N; i += 1) {
  const uname = `loadtest_${String(i).padStart(4, '0')}`;
  const name = `压测成员 ${String(i).padStart(3, '0')}`;
  const r = await client.query(
    `INSERT INTO principals (type, username, display_name, avatar_hue)
     VALUES ('user', $1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [uname, name, (i * 13) % 360],
  );
  ids.push(Number(r.rows[0].id));
}

const conv = await client.query(
  `INSERT INTO conversations (type, title, owner_id, created_by, last_seq)
   VALUES ('group', '压测 300 人（临时）', $1, $1, 0) RETURNING id`,
  [demoId],
);
const convId = Number(conv.rows[0].id);
await client.query(
  `INSERT INTO conversation_members (conversation_id, principal_id, role) VALUES ($1,$2,'owner')`,
  [convId, demoId],
);
for (const id of ids) {
  await client.query(
    `INSERT INTO conversation_members (conversation_id, principal_id, role) VALUES ($1,$2,'member')
     ON CONFLICT DO NOTHING`,
    [convId, id],
  );
}
await client.query('COMMIT');
const count = await client.query('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id=$1', [convId]);
console.log('群 id =', convId, '成员数 =', count.rows[0].n);
await client.end();
