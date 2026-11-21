// 邀请制（B 方案）：邀请码 / 名额 / 兑换 / 审计。
//
// 设计口径（用户 2026-11-18 拍板）：
//   - 每个用户注册后自动拿到名额（默认 3），自己可以发码；站务另有不受名额限制的码
//   - 一个码默认 30 天过期、多用途（max_uses 由创建者选，1..100）
//   - 每人同时只有 1 个有效码；再创建会先把旧码「还没用掉的那部分」吊销
//   - 人和 AI 的 account_no 继续走 0000005 的顺序号，这里不动账号号
//   - 邀请人能看到被邀请人的昵称/账号号/加入时间（不暴露邮箱）
//
// 安全边界（为什么这么写）：
//   1) 库里只有 HMAC-SHA256(normalize(code))，明文只在创建响应 / CLI stdout 出现一次。
//      HMAC key 来自应用（INVITE_PEPPER|SESSION_SECRET）：只拿到库的人造不出可用码。
//   2) 兑换必须发生在「建 principal 的同一个事务」里：先在事务内锁额度/码行、再建号、失败整体回滚。
//      否则会出现两种烂账：码被消耗但人没建起来（名额白扣），或人建起来了码没扣（码可重放）。
//   3) 错误原因（expired/used/revoked/quota）只在内部区分，对外统一 invite_required：
//      区分等于给爆破者一个「这个码存在但过期了」的确认信号。
//   4) 换发码时「先吊销旧码」和「读额度」必须在同一事务里，且都要锁同一个 quota 行——
//      两个并发创建请求否则会各自插一张有效码，破坏「同时只有 1 个有效码」。

import crypto from 'node:crypto';
import { withTx, pool } from '../db.mjs';
import { config } from '../config.mjs';

// ---------------------------------------------------------------------------
// 码格式：AIO-XXXX-XXXX-XXXX
//
// 字母表是 Crockford base32 再去掉 0/O/1/I 这些手抄容易混的字符：
// 数字 2-9（8 个）+ 字母 A-Z 去掉 I/O（24 个）= 32 个符号。
// 正好 32=2^5，所以 randomBytes 的每个字节直接 &31 取 5 bit 是**无偏**的
// （256 是 32 的整数倍，不存在取模偏置）。
//
// 熵：12 个符号 = 60 bit ≈ 1.15e18 种。任务书里写的「80bit」在 3×4 的分组格式下
// 凑不出来（80bit 需要 16 个符号）；这里按用户定的展示格式走，60 bit 配合
// 「同一个 IP 5 次失败锁 15 分钟」已经远远超出爆破可行性。
// ---------------------------------------------------------------------------
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_BODY_LEN = 12;
const CODE_PREFIX_LEN = 4;
const CODE_DISPLAY = 'AIO';

/** 生成规范化码体（12 个符号，不含 AIO 前缀与连字符）。 */
export function generateCodeBody() {
  // 一次取 12 个字节，每个字节只取低 5 bit：256 = 8×32，所以 &31 无取模偏置
  const buf = crypto.randomBytes(CODE_BODY_LEN);
  let out = '';
  for (let i = 0; i < CODE_BODY_LEN; i += 1) out += ALPHABET[buf[i] & 31];
  return out;
}

/**
 * 把用户输入/粘贴的码收敛成规范形式（12 个符号）。
 * 接受 AIO-xxxx-xxxx-xxxx / aio xxxx xxxx xxxx / 直接 12 个字符。
 * 非法（长度不对、含字母表外字符）返回 null——不要把非法输入也哈希一遍，
 * 那会让「随手敲的字符串」也去查库。
 */
export function normalizeCode(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // 前缀 AIO 的三个字母都不在字母表里（I/O 被排除），所以剥掉它不会与码体歧义
  if (s.startsWith(CODE_DISPLAY) && s.length === CODE_DISPLAY.length + CODE_BODY_LEN) {
    s = s.slice(CODE_DISPLAY.length);
  }
  if (s.length !== CODE_BODY_LEN) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** 规范码体 → 展示用明文（只在创建响应与 CLI stdout 出现）。 */
export function formatCode(body) {
  return `${CODE_DISPLAY}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** 展示用前缀（够用户认出是哪张码，不足以重放）。 */
export function codePrefixOf(body) {
  return body.slice(0, CODE_PREFIX_LEN);
}

// ---------------------------------------------------------------------------
// 哈希
// ---------------------------------------------------------------------------
// key = INVITE_PEPPER | SESSION_SECRET（| 做分隔符）：
//   - 只有 SESSION_SECRET 时也能工作（不配 pepper 不算配置错误，只是少一层隔离）
//   - 用分隔符而不是裸拼接：否则 pepper="ab"+secret="c" 与 pepper="a"+secret="bc"
//     会算出同一个 key，轮换 pepper 时可能悄悄保留旧码的有效性
//   - 注意：INVITE_PEPPER 一旦上生产就别随便改，改了等于让所有已发出的码失效
function inviteKey() {
  return `${config.invitePepper || ''}|${config.sessionSecret || ''}`;
}

/** HMAC-SHA256(key=INVITE_PEPPER|SESSION_SECRET, msg=规范码体) → hex。库里只存这个。 */
export function hashCode(raw) {
  const body = normalizeCode(raw);
  if (!body) return null;
  return crypto.createHmac('sha256', inviteKey()).update(body).digest('hex');
}

/** 邮箱/IP 的可关联哈希（审计要能看出「同一邮箱/机器反复注册」，但不能反推）。 */
export function hashEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  if (!v) return null;
  return crypto.createHmac('sha256', inviteKey()).update(`email:${v}`).digest('hex');
}

export function hashIp(ip) {
  const v = String(ip || '').trim();
  if (!v) return null;
  return crypto.createHmac('sha256', inviteKey()).update(`ip:${v}`).digest('hex');
}

// ---------------------------------------------------------------------------
// 参数规范化（路由与 CLI 共用；DB 的 CHECK 是最后一道，不是唯一一道）
// ---------------------------------------------------------------------------
export function normalizeMaxUses(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

export function normalizeTtlDays(value) {
  const fallback = Number(config.inviteTtlDays) > 0 ? Number(config.inviteTtlDays) : 30;
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365) return null;
  return n;
}

function cleanNote(note) {
  return String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// 内部：审计 / 额度
// ---------------------------------------------------------------------------
async function writeAudit(client, { actorId, action, codeId = null, principalId = null, meta = {} }) {
  await client.query(
    'INSERT INTO invite_audit (actor_id, action, code_id, principal_id, meta) VALUES ($1,$2,$3,$4,$5)',
    [actorId ?? null, action, codeId ?? null, principalId ?? null, JSON.stringify(meta)],
  );
}

/**
 * 锁 quota 行并返回 {quota, used, depth}。行不存在时补一行默认额度（自愈：
 * 迁移回填之前就注册掉的账号、或手工建过的账号）。
 * 必须在事务里调用——FOR UPDATE 只为拿行锁，事务外没有任何意义。
 * depth 一起读回来：兑换时要在同一把锁下判定「邀请深度是否超限」，分开读会读到旧值。
 */
async function lockQuotaRow(client, principalId) {
  const sel = 'SELECT quota, used, depth FROM user_invite_quotas WHERE principal_id = $1 FOR UPDATE';
  const first = await client.query(sel, [principalId]);
  if (first.rows[0]) {
    return {
      quota: Number(first.rows[0].quota),
      used: Number(first.rows[0].used),
      depth: Number(first.rows[0].depth || 0),
    };
  }
  await client.query(
    `INSERT INTO user_invite_quotas (principal_id, quota, used, depth)
     VALUES ($1,$2,0,0) ON CONFLICT (principal_id) DO NOTHING`,
    [principalId, config.inviteQuotaDefault],
  );
  const again = await client.query(sel, [principalId]);
  if (!again.rows[0]) return { quota: config.inviteQuotaDefault, used: 0, depth: 0 };
  return {
    quota: Number(again.rows[0].quota),
    used: Number(again.rows[0].used),
    depth: Number(again.rows[0].depth || 0),
  };
}

async function insertInviteCode(client, { ownerUserId, maxUses, ttlDays, note }) {
  // 先查一次再插：code_hash 撞车（32^12 空间）实际上不会发生，但一旦发生，
  // 唯一约束会让**整个事务**进入 aborted 状态，回滚重试会把别的工作一起丢掉。
  // 用「插入前预查」把重试成本压到最低。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const body = generateCodeBody();
    const hash = hashCode(body);
    const dup = await client.query('SELECT 1 FROM invite_codes WHERE code_hash = $1', [hash]);
    if (dup.rows.length) continue;
    const { rows } = await client.query(
      `INSERT INTO invite_codes (owner_user_id, code_hash, code_prefix, max_uses, expires_at, note)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval, $6)
       RETURNING id, max_uses, used_count, expires_at, created_at, note`,
      [ownerUserId ?? null, hash, codePrefixOf(body), maxUses, String(ttlDays), note],
    );
    const row = rows[0];
    return {
      id: Number(row.id),
      code: formatCode(body), // 明文只在这一刻存在
      codePrefix: row.code_prefix ?? codePrefixOf(body),
      maxUses: Number(row.max_uses),
      usedCount: Number(row.used_count),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      note: row.note ?? '',
    };
  }
  throw new Error('invite_code_generation_failed');
}

function viewCode(row) {
  return {
    id: Number(row.id),
    codePrefix: row.code_prefix ?? '',
    maxUses: Number(row.max_uses),
    usedCount: Number(row.used_count),
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at,
    note: row.note ?? '',
  };
}

// ---------------------------------------------------------------------------
// 用户侧：创建
// ---------------------------------------------------------------------------
/**
 * 给自己创建一张邀请码。
 * @param {object} actor 登录用户（type 必须是 user）
 * @param {{maxUses?:number, expiresInDays?:number, note?:string}} opts
 * @returns {{ok:true, code:string, invite:object, revokedCodeIds:number[]} | {ok:false, error:string, ...}}
 *
 * 事务边界：
 *   锁 quota 行 → 算 remaining → 校验 maxUses ≤ remaining → 吊销旧的有效码 → 插新码 → 审计
 * 全程同一把行锁，所以「两个并发创建」不会同时留下两张有效码。
 */
export async function createInviteForUser(actor, opts = {}) {
  if (!actor || actor.type !== 'user' || !actor.id) return { ok: false, error: 'forbidden' };
  const maxUses = normalizeMaxUses(opts.maxUses ?? opts.max_uses);
  if (!maxUses) return { ok: false, error: 'invalid_max_uses' };
  const ttlDays = normalizeTtlDays(opts.expiresInDays ?? opts.expires_in_days);
  if (!ttlDays) return { ok: false, error: 'invalid_ttl' };
  const note = cleanNote(opts.note);

  return withTx(async (client) => {
    const { quota, used } = await lockQuotaRow(client, actor.id);
    const remaining = quota - used;
    if (remaining <= 0) return { ok: false, error: 'no_remaining_quota', quota, used, remaining: 0 };
    if (maxUses > remaining) {
      return { ok: false, error: 'max_uses_exceeds_quota', quota, used, remaining };
    }
    // 「每人同时 1 个有效码」：先吊销旧码还没用掉的部分。
    // 已用满（used_count >= max_uses）的码本来就没有剩余价值，留着不动（审计要看它发过谁）。
    const revoked = await client.query(
      `UPDATE invite_codes SET revoked_at = now()
        WHERE owner_user_id = $1 AND revoked_at IS NULL AND used_count < max_uses
        RETURNING id`,
      [actor.id],
    );
    const invite = await insertInviteCode(client, { ownerUserId: actor.id, maxUses, ttlDays, note });
    const revokedCodeIds = revoked.rows.map((r) => Number(r.id));
    await writeAudit(client, {
      actorId: actor.id,
      action: 'create',
      codeId: invite.id,
      meta: { maxUses, expiresInDays: ttlDays, remainingBefore: remaining, revokedCodeIds },
    });
    return { ok: true, code: invite.code, invite, revokedCodeIds, quota, used, remaining };
  });
}

// ---------------------------------------------------------------------------
// 用户侧：我的邀请
// ---------------------------------------------------------------------------
/**
 * 返回 { quota, used, remaining, active, invitees }。
 * active 只给 codePrefix（明文码不再可得）；invitees 只给昵称/账号号/加入时间，不给邮箱。
 */
export async function listMine(actor, { inviteeLimit = 100 } = {}) {
  if (!actor || actor.type !== 'user' || !actor.id) return { ok: false, error: 'forbidden' };
  const q = await pool.query('SELECT quota, used FROM user_invite_quotas WHERE principal_id = $1', [actor.id]);
  const quota = q.rows[0] ? Number(q.rows[0].quota) : Number(config.inviteQuotaDefault);
  const used = q.rows[0] ? Number(q.rows[0].used) : 0;

  const activeQ = await pool.query(
    `SELECT id, code_prefix, max_uses, used_count, expires_at, revoked_at, created_at, note
       FROM invite_codes
      WHERE owner_user_id = $1
        AND revoked_at IS NULL
        AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY id DESC
      LIMIT 1`,
    [actor.id],
  );

  const inviteesQ = await pool.query(
    `SELECT p.display_name, p.account_no, r.redeemed_at
       FROM invite_redemptions r
       JOIN principals p ON p.id = r.principal_id
      WHERE r.inviter_id = $1
      ORDER BY r.redeemed_at DESC, r.id DESC
      LIMIT $2`,
    [actor.id, Math.min(Math.max(Number(inviteeLimit) || 100, 1), 500)],
  );

  const recentQ = await pool.query(
    `SELECT id, code_prefix, max_uses, used_count, expires_at, revoked_at, created_at, note
       FROM invite_codes
      WHERE owner_user_id = $1
      ORDER BY id DESC
      LIMIT 10`,
    [actor.id],
  );

  return {
    ok: true,
    quota,
    used,
    remaining: Math.max(quota - used, 0),
    // 创建表单的默认值：别给一个「超过剩余名额」的默认值，否则点一下就报错
    defaultMaxUses: Math.max(Math.min(quota - used, 100), 0),
    ttlDays: Number(config.inviteTtlDays) || 30,
    active: activeQ.rows[0] ? viewCode(activeQ.rows[0]) : null,
    invitees: inviteesQ.rows.map((r) => ({
      displayName: r.display_name,
      accountNo: r.account_no == null ? null : Number(r.account_no),
      joinedAt: r.redeemed_at,
    })),
    recent: recentQ.rows.map(viewCode),
  };
}

// ---------------------------------------------------------------------------
// 用户侧：吊销
// ---------------------------------------------------------------------------
export async function revokeInvite(actor, codeId) {
  if (!actor || actor.type !== 'user' || !actor.id) return { ok: false, error: 'forbidden' };
  const id = Number(codeId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'not_found' };
  return withTx(async (client) => {
    const { rows } = await client.query(
      `UPDATE invite_codes SET revoked_at = now()
        WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL
        RETURNING id, used_count, max_uses`,
      [id, actor.id],
    );
    if (!rows[0]) return { ok: false, error: 'not_found' };
    await writeAudit(client, {
      actorId: actor.id,
      action: 'revoke',
      codeId: id,
      meta: { usedCount: Number(rows[0].used_count), maxUses: Number(rows[0].max_uses) },
    });
    return { ok: true, id };
  });
}

// ---------------------------------------------------------------------------
// 兑换（必须跑在「建账号」的同一个事务里）
// ---------------------------------------------------------------------------
/**
 * 校验并消耗一次邀请码。**必须在调用方的事务里执行**（传 tx），
 * 因为它要和 principals/user_accounts 的插入一起提交或一起回滚。
 *
 * 加锁顺序（统一为 advisory(ip) → quota → invite_codes，别改回来）：
 *   1) 先不加锁读一次码行，只为拿到 owner_user_id（不存在就直接 invalid，快路径）
 *   2) 按 ip_hash 取一把 advisory 事务锁：同一出口 IP 的兑换串行化，
 *      否则两个并发请求都会看到 count = 上限-1 然后一起放过去（IP 闸被穿透）
 *   3) 有 owner 就先锁他的 quota 行（同一个人被邀请/邀请别人时串行）
 *   4) 再 SELECT ... FOR UPDATE 锁码行并重新做全部校验
 *   为什么不能「先锁码行再锁 quota」：createInviteForUser 的锁序是 quota → 自己名下的码，
 *   两条路径反序就会在「A 正在创建码 + 别人正在兑换 A 的旧码」时互相等成死锁
 *   （PG 会踢掉一个，用户看到 500）。多一次不加锁的索引查询换掉这个死锁面，值。
 *   advisory 锁必须排在 quota 之前：所有兑换路径都走同一个顺序，才不会自己和自己环等。
 *
 * 两道防刷闸门（都在消耗任何东西之前判定，失败不扣名额、不扣码）：
 *   - 同一 ip_hash 最近 24 小时成功兑换数 ≥ INVITE_MAX_PER_IP_DAY
 *   - 邀请深度 = 邀请人 quota.depth + 1 > INVITE_MAX_DEPTH（站务码 depth=0，不受限）
 *
 * @param {{code:string, email?:string, ip?:string, tx:object}} args tx = pg client（已在事务中）
 * @returns {{ok:true, codeId:number, inviterId:number|null, depth:number,
 *            redemption:{emailHash:string|null, ipHash:string|null}}
 *          | {ok:false, reason:'invalid'|'expired'|'revoked'|'exhausted'|'quota'|'ip_limit'|'depth'}}
 */
export async function redeemInvite({ code, email, ip, tx }) {
  if (!tx) throw new Error('redeemInvite 必须传入事务 client（tx）');
  const hash = hashCode(code);
  if (!hash) return { ok: false, reason: 'invalid' };

  const peek = await tx.query('SELECT owner_user_id FROM invite_codes WHERE code_hash = $1', [hash]);
  if (!peek.rows[0]) return { ok: false, reason: 'invalid' };
  const peekOwner = peek.rows[0].owner_user_id == null ? null : Number(peek.rows[0].owner_user_id);

  // --- 闸门 1：同一 IP 24 小时成功兑换上限 -----------------------------------
  // 用 advisory 事务锁按 ip_hash 串行化：锁在事务结束时自动释放（ROLEBACK 也释放）。
  // hashtext 的碰撞只会让两个不同 IP 偶尔共用一把锁（多等几毫秒），不影响正确性。
  const ipHash = hashIp(ip);
  if (ipHash) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invite-ip:${ipHash}`]);
    const cnt = await tx.query(
      `SELECT count(*)::int AS n FROM invite_redemptions
        WHERE ip_hash = $1 AND redeemed_at > now() - interval '24 hours'`,
      [ipHash],
    );
    if (Number(cnt.rows[0].n) >= config.inviteMaxPerIpDay) return { ok: false, reason: 'ip_limit' };
  }

  // 先锁邀请人的名额（如果这张码是用户码）。锁住的顺序与创建路径一致。
  let quota = null;
  if (peekOwner) quota = await lockQuotaRow(tx, peekOwner);

  const { rows } = await tx.query(
    `SELECT id, owner_user_id, max_uses, used_count, expires_at, revoked_at
       FROM invite_codes WHERE code_hash = $1 FOR UPDATE`,
    [hash],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (Number(row.used_count) >= Number(row.max_uses)) return { ok: false, reason: 'exhausted' };

  const inviterId = row.owner_user_id == null ? null : Number(row.owner_user_id);
  // 站务码：被邀请人是第 0 层（站务直接发的号不占树的深度）
  let depth = 0;
  if (inviterId) {
    // 锁后的 owner 与预读的 owner 必须一致；不一致只可能是「码归 owner 变了」这种
    // 代码里不存在的情况，但仍然按锁后的 owner 重新锁一次额度，避免用错人的名额。
    const q = (inviterId === peekOwner && quota) ? quota : await lockQuotaRow(tx, inviterId);
    if (q.used >= q.quota) return { ok: false, reason: 'quota' };
    // --- 闸门 2：邀请深度（在锁住邀请人之后读 depth，并发下不会被读旧值穿透）---
    depth = Number(q.depth || 0) + 1;
    if (depth > config.inviteMaxDepth) return { ok: false, reason: 'depth' };
    await tx.query(
      'UPDATE user_invite_quotas SET used = used + 1, updated_at = now() WHERE principal_id = $1',
      [inviterId],
    );
  }
  await tx.query('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = $1', [row.id]);

  return {
    ok: true,
    codeId: Number(row.id),
    inviterId,
    depth,
    redemption: { emailHash: hashEmail(email), ipHash },
  };
}

/**
 * 落兑换记录。必须在建好 principal 之后、同一个事务里调用。
 * 唯一约束 (principal_id) 是最后一道防重放：同一个账号不可能被记两次。
 * ip_hash 是「同一出口 IP 24 小时内兑换几次」的计数键，必须与 redeemInvite 用同一份。
 */
export async function recordRedemption(tx, { codeId, inviterId, principalId, emailHash, ipHash, depth = 0 }) {
  await tx.query(
    `INSERT INTO invite_redemptions (code_id, inviter_id, principal_id, email_hash, ip_hash, depth)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [codeId, inviterId ?? null, principalId, emailHash ?? null, ipHash ?? null, Number(depth) || 0],
  );
}

/** 兑换成功后写审计（不记明文码、不记邮箱/IP 明文）。 */
export async function auditRedemption(txOrPool, { inviterId, codeId, principalId }) {
  const runner = txOrPool || pool;
  await runner.query(
    `INSERT INTO invite_audit (actor_id, action, code_id, principal_id, meta)
     VALUES ($1,'redeem',$2,$3,$4)`,
    [inviterId ?? null, codeId, principalId, JSON.stringify({ invited: true })],
  );
}

// ---------------------------------------------------------------------------
// 站务：不受名额限制的码（owner_user_id = NULL）
// ---------------------------------------------------------------------------
export async function adminCreate(actor, opts = {}) {
  if (!actor || actor.isAdmin !== true) return { ok: false, error: 'forbidden' };
  const count = Math.min(Math.max(Number(opts.count) || 1, 1), 20);
  const maxUses = normalizeMaxUses(opts.maxUses ?? opts.max_uses);
  if (!maxUses) return { ok: false, error: 'invalid_max_uses' };
  const ttlDays = normalizeTtlDays(opts.expiresInDays ?? opts.expires_in_days);
  if (!ttlDays) return { ok: false, error: 'invalid_ttl' };
  const note = cleanNote(opts.note);

  return withTx(async (client) => {
    const invites = [];
    for (let i = 0; i < count; i += 1) {
      const invite = await insertInviteCode(client, { ownerUserId: null, maxUses, ttlDays, note });
      await writeAudit(client, {
        actorId: actor.id,
        action: 'admin_create',
        codeId: invite.id,
        meta: { maxUses, expiresInDays: ttlDays, scope: 'admin' },
      });
      invites.push(invite);
    }
    return { ok: true, invites };
  });
}

export async function adminList(actor, { limit = 50 } = {}) {
  if (!actor || actor.isAdmin !== true) return { ok: false, error: 'forbidden' };
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT c.id, c.owner_user_id, c.code_prefix, c.max_uses, c.used_count, c.expires_at,
            c.revoked_at, c.created_at, c.note,
            p.display_name AS owner_name, p.account_no AS owner_account_no,
            (SELECT count(*) FROM invite_redemptions r WHERE r.code_id = c.id) AS redemptions
       FROM invite_codes c
       LEFT JOIN principals p ON p.id = c.owner_user_id
      ORDER BY c.id DESC
      LIMIT $1`,
    [n],
  );
  return {
    ok: true,
    invites: rows.map((r) => ({
      ...viewCode(r),
      owner: r.owner_user_id == null
        ? null
        : {
          id: Number(r.owner_user_id),
          displayName: r.owner_name,
          accountNo: r.owner_account_no == null ? null : Number(r.owner_account_no),
        },
      redemptions: Number(r.redemptions || 0),
    })),
  };
}

export async function adminRevoke(actor, codeId) {
  if (!actor || actor.isAdmin !== true) return { ok: false, error: 'forbidden' };
  const id = Number(codeId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'not_found' };
  return withTx(async (client) => {
    const { rows } = await client.query(
      `UPDATE invite_codes SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, owner_user_id, used_count, max_uses`,
      [id],
    );
    if (!rows[0]) return { ok: false, error: 'not_found' };
    await writeAudit(client, {
      actorId: actor.id,
      action: 'admin_revoke',
      codeId: id,
      principalId: rows[0].owner_user_id == null ? null : Number(rows[0].owner_user_id),
      meta: { usedCount: Number(rows[0].used_count), maxUses: Number(rows[0].max_uses) },
    });
    return { ok: true, id };
  });
}
