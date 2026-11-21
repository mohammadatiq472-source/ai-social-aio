/**
 * 候补队列（实例开放 A 方案，2026-11-19）。
 *
 * 设计口径：开放 ≠ 自助注册。当前没有邮箱/手机验证，直接放开注册等于给脚本开闸，
 * 所以「开放」做成「谁都能申请，站务一键发码」——入口是敞开的，闸门在人手上。
 *
 * 隐私：邮箱明文落库（站务要能看到地址才能发码；与 user_accounts.email 同级），
 * 同时存 HMAC(email) 用于去重；IP 只存 HMAC，不可反推。
 */
import { pool, withTx } from '../db.mjs';
import { hashEmail, hashIp, adminCreate } from './invites.mjs';

const NOTE_MAX = 200;
const MAX_PER_IP_24H = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function maskEmailForAdmin(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const name = s.slice(0, at);
  const keep = name.length <= 2 ? 1 : 2;
  return `${name.slice(0, keep)}${'*'.repeat(Math.max(1, Math.min(6, name.length - keep)))}@${s.slice(at + 1)}`;
}

/**
 * 提交候补申请。
 * 返回 { ok:true, already:true|false, status } 或 { ok:false, error }
 * 幂等：同邮箱已有 pending → 返回 already，不再插一条（避免刷队列表）。
 */
export async function applyWaitlist({ email, note, ip }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return { ok: false, error: 'invalid_email' };
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  const eh = hashEmail(addr);
  const ih = hashIp(ip);

  const recent = await pool.query(
    `SELECT count(*)::int AS n FROM signup_waitlist
      WHERE ip_hash = $1 AND created_at > now() - interval '24 hours'`,
    [ih],
  );
  if (Number(recent.rows[0]?.n || 0) >= MAX_PER_IP_24H) return { ok: false, error: 'too_many' };

  const existed = await pool.query(
    `SELECT id, status FROM signup_waitlist WHERE email_hash = $1
      ORDER BY created_at DESC LIMIT 1`,
    [eh],
  );
  if (existed.rows[0]) {
    return { ok: true, already: true, status: existed.rows[0].status };
  }

  const ins = await pool.query(
    `INSERT INTO signup_waitlist (email, email_hash, note, ip_hash)
     VALUES ($1,$2,$3,$4) RETURNING id, status, created_at`,
    [addr, eh, text || null, ih],
  );
  return { ok: true, already: false, status: ins.rows[0].status, id: Number(ins.rows[0].id) };
}

/** 站务视角：按状态列出（默认 pending，最新的在前） */
export async function listWaitlist({ status = 'pending', limit = 100 } = {}) {
  const st = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
  const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const { rows } = await pool.query(
    `SELECT w.id, w.email, w.note, w.status, w.created_at, w.decided_at,
            c.code_prefix, c.max_uses, c.used_count
       FROM signup_waitlist w
       LEFT JOIN invite_codes c ON c.id = w.invite_code_id
      WHERE w.status = $1
      ORDER BY w.created_at DESC
      LIMIT $2`,
    [st, n],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    // 站务需要地址才能发码，但列表页默认只给掩码；明文仅在「详情/发码」时用
    emailMasked: maskEmailForAdmin(r.email),
    note: r.note || '',
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    codePrefix: r.code_prefix || null,
    maxUses: r.max_uses == null ? null : Number(r.max_uses),
    usedCount: r.used_count == null ? null : Number(r.used_count),
  }));
}

/**
 * 站务从候补队列发一张码（1 人用、7 天有效），返回**一次性明文**。
 * 明文只出现在这次响应里，不落库（库里只有 HMAC），这是与站务邀请 UI 同一套口径。
 */
export async function issueCodeForWaitlist({ id, actor, maxUses = 1, ttlDays = 7 }) {
  if (!actor?.isAdmin) return { ok: false, error: 'forbidden' };
  const wid = Number(id);
  if (!Number.isInteger(wid) || wid <= 0) return { ok: false, error: 'invalid_id' };

  return withTx(async (client) => {
    const { rows } = await client.query(
      'SELECT id, email, status FROM signup_waitlist WHERE id = $1 FOR UPDATE',
      [wid],
    );
    const row = rows[0];
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== 'pending') return { ok: false, error: 'already_decided' };
    return { ok: true, email: row.email, id: wid };
  }).then(async (pre) => {
    if (!pre.ok) return pre;
    // 建码在独立事务里（adminCreate 自己开事务，带审计）；失败则候补条目保持 pending
    const created = await adminCreate(actor, {
      count: 1,
      maxUses,
      expiresInDays: ttlDays,
      note: `候补发码 #${pre.id}`,
    });
    if (!created.ok) return { ok: false, error: created.error || 'code_failed' };
    const invite = created.invites[0];
    await pool.query(
      `UPDATE signup_waitlist
          SET status = 'approved', invite_code_id = $2, decided_by = $3, decided_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [pre.id, invite.id, actor.id],
    );
    return {
      ok: true,
      id: pre.id,
      email: pre.email,
      code: invite.code,
      codeId: invite.id,
      expiresAt: invite.expiresAt || null,
    };
  });
}

export async function rejectWaitlist({ id, actor }) {
  if (!actor?.isAdmin) return { ok: false, error: 'forbidden' };
  const { rows } = await pool.query(
    `UPDATE signup_waitlist
        SET status = 'rejected', decided_by = $2, decided_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [Number(id) || 0, actor.id],
  );
  if (!rows[0]) return { ok: false, error: 'not_found' };
  return { ok: true, id: Number(rows[0].id) };
}

export async function waitlistCounts() {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM signup_waitlist GROUP BY status`,
  );
  const out = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
