import crypto from 'node:crypto';
import { pool } from '../db.mjs';
import { config } from '../config.mjs';
import { avatarOf } from '../core/query.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }; // 16MB/次，1.9G 内存机器上最多并发 2 个

// 异步版 scrypt：37ms/次的同步计算会卡住整个单进程事件循环（实测登录 p50 47ms，
// 期间别人的消息推送/WS 心跳全部排队）。异步版走 libuv 线程池，不占事件循环。
function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt-1$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algo, N, r, p, saltHex, hashHex] = String(encoded).split('$');
    if (algo !== 'scrypt-1') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scryptAsync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export async function createSession(principalId) {
  const sid = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await pool.query(
    'INSERT INTO sessions (token_hash, principal_id, expires_at) VALUES ($1,$2,$3)',
    [sha256(sid), principalId, expiresAt],
  );
  return { sid, expiresAt };
}

export function sessionCookie(sid, expiresAt) {
  const bits = [
    `${config.cookieName}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (config.secureCookie) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie() {
  const bits = [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.secureCookie) bits.push('Secure');
  return bits.join('; ');
}

// 人类会话 → actor；找不到/过期返回 null
export async function authenticateSession(sid) {
  if (!sid) return null;
  const { rows } = await pool.query(
    `SELECT s.principal_id, s.expires_at, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id,
            p.account_no, p.discoverable, p.is_admin, p.suspended_until, ua.email, ua.email_verified_at
       FROM sessions s
       JOIN principals p ON p.id = s.principal_id
       LEFT JOIN user_accounts ua ON ua.principal_id = p.id
      WHERE s.token_hash = $1`,
    [sha256(sid)],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return {
    id: Number(row.principal_id),
    type: 'user',
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    avatarUrl: avatarOf(row),
    email: row.email,
    accountNo: row.account_no == null ? null : Number(row.account_no),
    discoverable: row.discoverable !== false,
    // 站务标记：只有 true 才出现在审核页；封禁中的账号仍然能登录看历史，但发不了消息
    isAdmin: row.is_admin === true,
    suspendedUntil: row.suspended_until || null,
    // 邮箱验证：NULL = 从未验证过。没配 SMTP 的实例上恒为 NULL（功能关闭）。
    emailVerifiedAt: row.email_verified_at || null,
  };
}

// last_used_at 节流（P1）：这个列只用于「我的 AI / 成员面板」里「上次同步」的近 5 分钟展示，
// 不需要每次 Bearer 请求都写库。MCP 是拉模式，一次轮询就是一次写；无节流时 agent_tokens
// 每行被高频 UPDATE（实测 n_tup_upd 随轮询线性增长而 n_tup_hot_upd≈0），纯粹制造
// WAL / autovacuum 压力。60 秒写一次：展示精度本来就是分钟级，5 分钟窗口不受影响。
// 单进程 [C1] 下语义不变；SQL 侧再叠一道「60 秒内不重复写」的 WHERE，
// 保证进程重启（节流表清空）或未来多实例时同一个 token 也不会被重复更新。
const TOKEN_TOUCH_INTERVAL_MS = 60_000;
const TOKEN_TOUCH_MAX_ENTRIES = 5000;
const tokenTouchedAt = new Map();

function touchAgentToken(tokenId) {
  const now = Date.now();
  const prev = tokenTouchedAt.get(tokenId);
  if (prev && now - prev < TOKEN_TOUCH_INTERVAL_MS) return;
  if (tokenTouchedAt.size >= TOKEN_TOUCH_MAX_ENTRIES) {
    // 先按时间清过期项；若仍超限（极端突发），丢掉最早的一半——
    // 最坏后果只是某些 token 多写一次 UPDATE，不影响鉴权与展示口径。
    for (const [id, ts] of tokenTouchedAt) {
      if (now - ts >= TOKEN_TOUCH_INTERVAL_MS) tokenTouchedAt.delete(id);
    }
    if (tokenTouchedAt.size >= TOKEN_TOUCH_MAX_ENTRIES) {
      let drop = Math.ceil(tokenTouchedAt.size / 2);
      for (const id of tokenTouchedAt.keys()) {
        if (drop-- <= 0) break;
        tokenTouchedAt.delete(id);
      }
    }
  }
  tokenTouchedAt.set(tokenId, now);
  pool.query(
    `UPDATE agent_tokens SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
    [tokenId],
  ).catch(() => {});
}

// [C3] Agent Bearer → actor；token 不存在/被吊销/agent 被暂停/账号被封禁都返回 null。
// 细节版（authenticateAgentDetailed）额外回 reason + principal_id：MCP 层要按原因打日志，
// 但日志里只许出现 principal_id 与原因标识，绝不能出现 token、正文或消息内容（C6）。
export async function authenticateAgentDetailed(authorization) {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return { actor: null, reason: 'missing_token', principal_id: null };
  }
  const token = authorization.slice(7).trim();
  if (!token) return { actor: null, reason: 'missing_token', principal_id: null };
  const { rows } = await pool.query(
    `SELECT t.id AS token_id, t.label, t.agent_id, a.status, a.owner_user_id, a.daily_limit,
            p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id, p.suspended_until
       FROM agent_tokens t
       JOIN agents a ON a.principal_id = t.agent_id
       JOIN principals p ON p.id = t.agent_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return { actor: null, reason: 'invalid_token', principal_id: null };
  const principalId = Number(row.agent_id);
  if (row.status !== 'active') return { actor: null, reason: 'agent_paused', principal_id: principalId };
  // [M2] 站务封禁必须对 AI 生效：suspend_user 只写 principals.suspended_until，
  // 以前这里不取这个字段，于是「封了 AI」只是写了个没人读的列（假封禁）。
  // 口径与 agents.status='paused' 一致：一律当作未授权（401），不泄露封禁细节。
  if (row.suspended_until && new Date(row.suspended_until).getTime() > Date.now()) {
    return { actor: null, reason: 'suspended', principal_id: principalId };
  }
  // 顺带记录最后使用时间（失败不影响鉴权）；60 秒节流，原因见 touchAgentToken 的注释
  touchAgentToken(row.token_id);
  return {
    actor: {
      id: principalId,
      type: 'agent',
      displayName: row.display_name,
      avatarHue: row.avatar_hue,
      avatarUrl: avatarOf(row),
      ownerUserId: Number(row.owner_user_id),
      tokenId: Number(row.token_id),
      tokenLabel: row.label,
      dailyLimit: row.daily_limit,
      // 纵深防御：core/suspend.mjs 的入口检查也能直接作用于 AI actor
      suspendedUntil: row.suspended_until || null,
    },
    reason: null,
    principal_id: principalId,
  };
}

export async function authenticateAgent(authorization) {
  const out = await authenticateAgentDetailed(authorization);
  return out.actor;
}

// 登录失败计数：连续 5 次即锁定 15 分钟（locked_until 必须真的被写，否则是死代码）
export async function noteLoginFailure(key) {
  await pool.query(
    `INSERT INTO login_attempts (key, failures, locked_until, updated_at)
     VALUES ($1, 1, NULL, now())
     ON CONFLICT (key) DO UPDATE
       SET failures = login_attempts.failures + 1,
           locked_until = CASE
             WHEN login_attempts.failures + 1 >= 5 THEN now() + interval '15 minutes'
             ELSE login_attempts.locked_until
           END,
           updated_at = now()`,
    [key],
  ).catch(() => {});
}

export async function isLockedOut(key) {
  const { rows } = await pool.query('SELECT failures, locked_until FROM login_attempts WHERE key = $1', [key]);
  const row = rows[0];
  if (!row) return false;
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) return true;
  return false;
}

export async function clearLoginFailures(key) {
  await pool.query('DELETE FROM login_attempts WHERE key = $1', [key]).catch(() => {});
}
