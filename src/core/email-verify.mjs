/**
 * 邮箱验证令牌的签发与核销（2026-11-19）。
 *
 * 口径：
 *   - 库里只存 sha256(明文)，明文只出现在邮件链接里一次；
 *   - 24 小时过期、单次使用、核销时把同账号其它未用令牌一并作废（旧链接会立刻失效）；
 *   - 重发有冷却：同账号 60 秒 1 封、24 小时 5 封（防「用它当发信机」）。
 *
 * 为什么冷却用 DB 计数而不是进程内 Map：单进程 [C1] 下两者等价，但重启会清零；
 * 「每天最多 5 封」这条对发信额度是硬约束，不能因为重启就重新满额。
 */
import crypto from 'node:crypto';
import { pool, withTx } from '../db.mjs';
import { config } from '../config.mjs';
import { emailVerifySettings, sendMail } from '../mail.mjs';

const TOKEN_TTL_HOURS = 24;
const RESEND_COOLDOWN_SEC = 60;
const MAX_SENDS_PER_DAY = 5;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? '***' : '';
  const name = s.slice(0, at);
  const domain = s.slice(at + 1);
  const keep = name.length <= 2 ? 1 : 2;
  return `${name.slice(0, keep)}${'*'.repeat(Math.max(1, Math.min(6, name.length - keep)))}@${domain}`;
}

/**
 * 签发一封验证信。
 * 返回 { ok:true, expiresAt } 或 { ok:false, reason:'disabled'|'cooldown'|'daily'|'send_failed' }
 * ——reason 是给上层映射 HTTP 状态用的，不含任何令牌/口令。
 */
export async function issueVerification({ principalId, email }) {
  const settings = emailVerifySettings();
  if (!settings.enabled) return { ok: false, reason: 'disabled' };

  const to = String(email || '').trim().toLowerCase();
  if (!to.includes('@')) return { ok: false, reason: 'no_email' };

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n24,
            count(*) FILTER (WHERE created_at > now() - ($2 || ' seconds')::interval)::int AS recent
       FROM email_verifications
      WHERE principal_id = $1 AND created_at > now() - interval '24 hours'`,
    [principalId, String(RESEND_COOLDOWN_SEC)],
  );
  const n24 = Number(rows[0]?.n24 || 0);
  const recent = Number(rows[0]?.recent || 0);
  if (recent > 0) return { ok: false, reason: 'cooldown' };
  if (n24 >= MAX_SENDS_PER_DAY) return { ok: false, reason: 'daily' };

  const token = crypto.randomBytes(32).toString('base64url');
  const ins = await pool.query(
    `INSERT INTO email_verifications (principal_id, token_hash, email, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)
     RETURNING expires_at`,
    [principalId, sha256(token), to, String(TOKEN_TTL_HOURS)],
  );

  const base = String(config.publicBaseUrl || '').replace(/\/+$/, '');
  const link = `${base}/api/auth/verify-email/confirm?token=${encodeURIComponent(token)}`;
  const text = [
    '欢迎加入 AIO。',
    '',
    '点下面的链接完成邮箱验证（24 小时内有效，只能用一次）：',
    link,
    '',
    '不是你本人注册的？忽略这封邮件即可，账号不会被激活出任何新能力。',
  ].join('\n');
  const html = `<p>欢迎加入 AIO。</p>
<p>点下面的链接完成邮箱验证（24 小时内有效，只能用一次）：</p>
<p><a href="${link}">${link}</a></p>
<p>不是你本人注册的？忽略这封邮件即可。</p>`;

  try {
    await sendMail({ to, subject: '验证你的 AIO 邮箱', text, html });
  } catch (err) {
    // 发不出去就把这枚令牌作废：否则用户手里没有链接，而库里留着一张「未用」的记录
    await pool.query('UPDATE email_verifications SET consumed_at = now() WHERE token_hash = $1', [sha256(token)]).catch(() => {});
    // 只记错误码/类型：nodemailer 的 message 里可能带收件地址（PII），日志不该留
    console.error('[mail] verify email send failed:', err.code || err.name || 'unknown');
    return { ok: false, reason: 'send_failed' };
  }

  return { ok: true, expiresAt: ins.rows[0]?.expires_at || null, sentTo: maskEmail(to) };
}

/** 核销令牌：成功即把账号标记为已验证。返回 { ok:true, principalId } 或 { ok:false, reason }。 */
export async function consumeVerification(token) {
  const t = String(token || '').trim();
  // base64url 32 字节 ≈ 43 字符；长度先夹一下，避免拿超长串去打哈希
  if (t.length < 20 || t.length > 200) return { ok: false, reason: 'invalid' };
  const hash = sha256(t);
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, principal_id, expires_at, consumed_at
         FROM email_verifications WHERE token_hash = $1 FOR UPDATE`,
      [hash],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.consumed_at) return { ok: false, reason: 'used' };
    if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

    await client.query('UPDATE email_verifications SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1', [row.id]);
    await client.query('UPDATE email_verifications SET consumed_at = now() WHERE principal_id = $1 AND consumed_at IS NULL', [row.principal_id]);
    await client.query(
      'UPDATE user_accounts SET email_verified_at = COALESCE(email_verified_at, now()) WHERE principal_id = $1',
      [row.principal_id],
    );
    return { ok: true, principalId: Number(row.principal_id) };
  });
}

export async function isEmailVerified(principalId) {
  const { rows } = await pool.query(
    'SELECT email_verified_at FROM user_accounts WHERE principal_id = $1',
    [principalId],
  );
  return Boolean(rows[0]?.email_verified_at);
}

/**
 * 注册后发信（best-effort）：任何失败都只记日志。
 * 注册本身绝不能因为「邮件发不出去」而变成 500——那会把所有人挡在门外。
 */
export async function maybeSendVerificationAfterRegister({ principalId, email, log }) {
  const settings = emailVerifySettings();
  if (!settings.enabled) return { ok: false, reason: 'disabled' };
  try {
    const out = await issueVerification({ principalId, email });
    if (!out.ok && out.reason !== 'disabled') {
      log?.warn?.({ reason: out.reason }, 'verify email not sent after register');
    }
    return out;
  } catch (err) {
    log?.warn?.({ err: err.message }, 'verify email failed after register');
    return { ok: false, reason: 'send_failed' };
  }
}
