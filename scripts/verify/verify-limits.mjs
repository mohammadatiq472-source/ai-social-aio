// 核心层护栏回归：群数上限 / 单群人数 / 媒体配额（用 env 把上限调小来测边界）
//
// 清理说明（P0-4 数据库加固后）：events 归 postgres，qqmini_app 只有 SELECT/INSERT，
// 所以本脚本最后「删测试事件」不能再依赖 app 连接。若提供 ADMIN_DATABASE_URL
// （postgres），用独立 pg Pool 清理 events；没提供或清理被 42501 拒绝时，
// 明确打印 SKIP 并保留测试账号（不静默、不假装成功）。
process.env.MAX_GROUPS_PER_USER = '2';
process.env.MAX_GROUP_MEMBERS = '3';
process.env.MEDIA_QUOTA_BYTES = String(5 * 1024 * 1024);

const { submit } = await import('../../src/core/submit.mjs');
const { saveAttachment } = await import('../../src/media.mjs');
const { pool, closeDb } = await import('../../src/db.mjs');
const { config } = await import('../../src/config.mjs');
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const pg = (await import('pg')).default;

const problems = [];
const createdConvs = [];
const createdAttachments = [];
const createdPrincipals = [];
const tag = `护栏回归-${Date.now() % 100000}`;

async function makeUser(name) {
  const r = await pool.query(
    `INSERT INTO principals (type, username, display_name, avatar_hue) VALUES ('user', $1, $2, 12) RETURNING id`,
    [`limit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name],
  );
  const id = Number(r.rows[0].id);
  createdPrincipals.push(id);
  return { id, type: 'user', displayName: name };
}

async function makeAgent(ownerId, name) {
  const p = await pool.query(
    `INSERT INTO principals (type, username, display_name, avatar_hue) VALUES ('agent', $1, $2, 265) RETURNING id`,
    [`ai_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name],
  );
  const id = Number(p.rows[0].id);
  createdPrincipals.push(id);
  await pool.query(
    `INSERT INTO agents (principal_id, owner_user_id, persona, status) VALUES ($1, $2, '护栏测试', 'active')`,
    [id, ownerId],
  );
  return id;
}

const actor = await makeUser('护栏用户A');
const a1 = await makeAgent(actor.id, '护栏AI1');
const a2 = await makeAgent(actor.id, '护栏AI2');
const a3 = await makeAgent(actor.id, '护栏AI3');

// 1) 群数上限：上限 2，前两个成功，第三个被拒
const g1 = await submit({ type: 'create_group', title: `${tag}-1`, member_ids: [] }, actor);
const g2 = await submit({ type: 'create_group', title: `${tag}-2`, member_ids: [] }, actor);
const g3 = await submit({ type: 'create_group', title: `${tag}-3`, member_ids: [] }, actor);
if (g1.accepted) createdConvs.push(g1.conversation_id);
if (g2.accepted) createdConvs.push(g2.conversation_id);
console.log('群数上限:', { g1: g1.accepted, g2: g2.accepted, g3: g3.accepted, reason: g3.reason, message: g3.message });
if (!g1.accepted || !g2.accepted) problems.push(`前两个群应当成功：${g1.reason} / ${g2.reason}`);
if (!(g3.accepted === false && g3.reason === 'group_limit')) problems.push(`第 3 个群没被拦住：${g3.reason}`);

// 2) 单群人数：上限 3。用一个全新的 C 用户（群数 0）建 3 人群，再加第 4 个应 group_full
const c = await makeUser('护栏用户C');
const c1 = await makeAgent(c.id, 'C的AI1');
const c2 = await makeAgent(c.id, 'C的AI2');
const c3 = await makeAgent(c.id, 'C的AI3');
const sizeGroup = await submit({ type: 'create_group', title: `${tag}-size`, member_ids: [c1, c2] }, c);
if (sizeGroup.accepted) createdConvs.push(sizeGroup.conversation_id);
const overflow = sizeGroup.accepted
  ? await submit({ type: 'add_member', conversation_id: sizeGroup.conversation_id, principal_id: c3 }, c)
  : { accepted: false, reason: 'create_failed' };
console.log('人数上限:', { sizeGroup: sizeGroup.accepted, reason: sizeGroup.reason, add: overflow.accepted, addReason: overflow.reason, message: overflow.message });
if (sizeGroup.accepted) {
  if (!(overflow.accepted === false && overflow.reason === 'group_full')) problems.push(`单群人数上限没生效：${overflow.reason}`);
}

// 3) 媒体配额：上限 5MB，传 6MB 应被拒
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(6 * 1024 * 1024, 0)]);
const saved = await saveAttachment(png, { uploaderId: actor.id, declaredMime: 'image/png' });
console.log('媒体配额:', { ok: saved.ok, reason: saved.reason, message: saved.message });
if (saved.ok || saved.reason !== 'quota_exceeded') problems.push('媒体配额没有拦住超限上传');
if (saved.ok && saved.attachment?.id) createdAttachments.push(saved.attachment.id);

// 清理
// events 只有 INSERT/SELECT（加固后），删除必须走 ADMIN_DATABASE_URL 的 postgres 连接。
// 没有 admin 连接时先检查当前 app 连接是否仍有 DELETE（本机 app=postgres 时可行）；
// 都没有就明确 SKIP，保留测试账号与事件（不静默失败）。
const adminUrl = process.env.ADMIN_DATABASE_URL || '';
let adminPool = null;
if (adminUrl) {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 1 });
}
let eventDeleter = null;
let eventDeleteWhy = '';
if (adminPool) {
  eventDeleter = adminPool;
  eventDeleteWhy = 'ADMIN_DATABASE_URL（postgres）';
} else {
  try {
    const cap = await pool.query("SELECT has_table_privilege(current_user, 'public.events', 'DELETE') AS ok");
    if (cap.rows[0]?.ok === true) {
      eventDeleter = pool;
      eventDeleteWhy = '当前 app 连接（本机 app=postgres）';
    } else {
      eventDeleteWhy = '当前 app 角色无 events DELETE';
    }
  } catch (err) {
    eventDeleteWhy = `检查 events DELETE 权限失败：${err.message}`;
  }
}

for (const id of createdConvs) {
  await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1', [id]);
  // 迁移 012 起 messages 是视图（JOIN events，不可 DELETE）；真实表是 messages_meta
  await pool.query('DELETE FROM messages_meta WHERE conversation_id = $1', [id]);
  await pool.query('DELETE FROM conversations WHERE id = $1', [id]);
}
for (const id of createdAttachments) {
  const r = await pool.query('SELECT storage_key FROM attachments WHERE id=$1', [id]);
  await pool.query('DELETE FROM attachments WHERE id=$1', [id]);
  if (r.rows[0]) { try { fs.unlinkSync(path.join(config.mediaDir, r.rows[0].storage_key)); } catch { /* ignore */ } }
}
// events.actor_id 有外键，测试事件要先删（这是测试数据，不属于审计链）
const skippedCleanup = [];
for (const id of createdPrincipals) {
  await pool.query('DELETE FROM conversation_members WHERE principal_id = $1', [id]);
  await pool.query('DELETE FROM agents WHERE principal_id = $1', [id]);
  await pool.query('DELETE FROM agent_tokens WHERE agent_id = $1', [id]);
  if (eventDeleter) {
    try {
      await eventDeleter.query('DELETE FROM events WHERE actor_id = $1', [id]);
    } catch (err) {
      skippedCleanup.push(id);
      console.log(`SKIP  清理 events(actor_id=${id})：${err.code || ''} ${err.message}`.trim());
    }
  } else {
    skippedCleanup.push(id);
  }
  await pool.query('DELETE FROM principals WHERE id = $1', [id]).catch((err) => {
    if (skippedCleanup.includes(id)) {
      console.log(`SKIP  清理 principal id=${id}（events 仍引用，且 ${eventDeleteWhy}）`);
    } else {
      console.log(`WARN  清理 principal id=${id} 失败：${err.message}`);
    }
  });
}
if (skippedCleanup.length) {
  console.log(`SKIP  本轮有 ${skippedCleanup.length} 个测试 principal 的 events 未清理：${eventDeleteWhy}`);
  console.log('      需要清理时用 ADMIN_DATABASE_URL=postgres 连接串重跑，或手工删除这些测试数据。');
}
await adminPool?.end().catch(() => {});

console.log(JSON.stringify({ problems }, null, 2));
console.log(problems.length ? 'LIMITS TEST FAILED' : 'LIMITS TEST PASSED');
await closeDb();
process.exit(problems.length ? 1 : 0);
