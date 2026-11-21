// Web Push（浏览器/手机系统通知）
//
// 设计取舍：
// - 只推「离线成员」：在线的人在 WS 里已经看到消息了，再弹一条系统通知是打扰
// - 只推「会话名 + 发送者 + 前 40 字 + 会话 id」：锁屏上能认出来就够，正文全文不上通知
// - 同一账号同一会话 60 秒内最多一条（被 @ 的除外）：否则一个活跃群能把手机震到静音
//   —— 冷却表是进程内 Map（和限流一样，重启清零，[C1] 单进程可接受）
// - 推送失败不抛给调用方：通知是尽力而为，失败记 last_error/attempts，404/410 直接删订阅
// - 没配 VAPID 就是「不发」，不影响主服务启动（测试环境和本地开发常常不配）
import { setVapidDetails, sendNotification } from 'web-push';
import { pool } from './db.mjs';
import { config } from './config.mjs';

// principalId:conversationId -> 上次推送时间
const cooldown = new Map();
const PUSH_COOLDOWN_MS = Number(process.env.PUSH_COOLDOWN_MS || 60_000);
// [L7] 进程内 Map 不能只增不减：定期（或桶数超上限时）把已经滑出冷却窗的键删掉。
const COOLDOWN_SWEEP_MS = 10 * 60 * 1000;
const COOLDOWN_MAX_KEYS = 5000;
let cooldownSweptAt = 0;
const MAX_ENDPOINT_LEN = 1024;
const MAX_KEY_LEN = 512;
const BODY_PREVIEW_LEN = 40;

// [L6] endpoint 是用户给的任意 https 地址，web-push 会真的向它 POST。
// 推送失败时 last_error（推送服务的状态码/错误串）会经 /api/push/status 回给订阅者本人，
// 于是「填一个内网 https 地址」= 一个内网存活/端口探测 oracle（速度受 60s 冷却限制）。
// 这里拒掉私有/保留/内网短名；用黑名单而不是白名单：FCM/APNs/Mozilla/WNS 的域名会变，
// 白名单一过期就把通知全废掉（产品事故），黑名单只挡「根本不该是推送服务」的目标。
// 说明：URL 解析会把 0x7f.0.0.1 / 127.1 / 2130706433 这类写法规范化成点分十进制，
// 所以判定只需要看规范化之后的 hostname。
function isBlockedIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // 127.0.0.0/8
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16（link-local / 云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10（CGNAT，云上很常见）
  return false;
}

// 把 IPv6 字面量展开成 8 个 16 位整数；非法返回 null。
// 需要展开是因为 URL 会把 [::ffff:127.0.0.1] 规范化成 [::ffff:7f00:1]，
// 只看第一个 hextet 会漏掉「IPv4-mapped 回环」这类绕过。
function expandIpv6(host) {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const toNums = (list) => {
    const out = [];
    for (const seg of list) {
      if (!seg) continue;
      if (seg.includes('.')) {
        const p = seg.split('.').map(Number);
        if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((p[0] << 8) | p[1], (p[2] << 8) | p[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
        out.push(parseInt(seg, 16));
      }
    }
    return out;
  };
  const head = toNums(halves[0] ? halves[0].split(':') : []);
  const tail = halves.length === 2 ? toNums(halves[1] ? halves[1].split(':') : []) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 2) {
    if (missing < 1) return null;
    return [...head, ...new Array(missing).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

export function isBlockedEndpointHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) {
    const hextets = expandIpv6(h);
    if (!hextets) return true;                       // 解析不了的一律当危险（宁可少推一条）
    const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
    // IPv4-mapped（::ffff:a.b.c.d）：按内嵌的 IPv4 判定；公网 IPv4 也照常放行
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
      return isBlockedIpv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
    }
    // IPv4-compatible（::a.b.c.d，含 :: 与 ::1）：保留段，一律拒
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true;
    if ((h0 & 0xfe00) === 0xfc00) return true;       // fc00::/7（唯一本地地址）
    if ((h0 & 0xffc0) === 0xfe80) return true;       // fe80::/10（链路本地）
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isBlockedIpv4(h);
  // 不带点的主机名：内网短名（nas / jenkins / wiki），无法可靠解析，直接拒
  if (!h.includes('.')) return true;
  return false;
}

function sweepCooldown(now) {
  if (cooldown.size < COOLDOWN_MAX_KEYS && now - cooldownSweptAt < COOLDOWN_SWEEP_MS) return;
  cooldownSweptAt = now;
  for (const [key, at] of cooldown) {
    if (now - at >= PUSH_COOLDOWN_MS) cooldown.delete(key);
  }
  // 极端量级（>5000 个仍在冷却的键）下宁可多响一次，也不要把内存吃满
  if (cooldown.size >= COOLDOWN_MAX_KEYS) cooldown.clear();
}

export function pushEnabled() {
  return Boolean(config.vapid.publicKey && config.vapid.privateKey);
}

export function publicKey() {
  return config.vapid.publicKey || '';
}

/** 启动时调用一次：只在配置齐全时才 setVapidDetails（半配置视为配置错误，在 assertConfig 里已拦） */
export function initPush() {
  if (!pushEnabled()) return false;
  setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  return true;
}

/** 保存/更新订阅（同一 endpoint 重复订阅只更新密钥，不会推两遍） */
export async function saveSubscription(actor, { endpoint, p256dh, auth, userAgent } = {}) {
  const ep = String(endpoint || '').trim();
  if (!/^https:\/\//i.test(ep) || ep.length > MAX_ENDPOINT_LEN) {
    return { error: 'invalid_endpoint', message: '订阅地址必须是 https 且不超过 1024 字符' };
  }
  let parsed;
  try {
    parsed = new URL(ep);
  } catch {
    return { error: 'invalid_endpoint', message: '订阅地址不是合法的 URL' };
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return { error: 'invalid_endpoint', message: '订阅地址必须是 https 域名' };
  }
  // [L6] 不许指向内网/本地/保留地址（否则 last_error 变成内网探测回显）
  if (isBlockedEndpointHost(parsed.hostname)) {
    return { error: 'invalid_endpoint', message: '订阅地址不能指向内网、本地或保留地址' };
  }
  const key = String(p256dh || '').trim();
  const secret = String(auth || '').trim();
  if (!key || key.length > MAX_KEY_LEN || !secret || secret.length > MAX_KEY_LEN) {
    return { error: 'invalid_keys', message: '订阅密钥不合法' };
  }
  // 单账号最多 10 台设备：防止有人拿脚本刷订阅表
  const { rows: count } = await pool.query(
    `SELECT count(*)::int AS n FROM push_subscriptions
      WHERE principal_id = $1 AND endpoint <> $2`,
    [actor.id, ep],
  );
  if (Number(count[0].n) >= 10) {
    return { error: 'too_many_devices', message: '最多绑定 10 台设备，请先在旧设备关闭通知' };
  }
  await pool.query(
    `INSERT INTO push_subscriptions (principal_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (principal_id, endpoint)
     DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                   user_agent = EXCLUDED.user_agent, last_seen_at = now()`,
    [actor.id, ep, key, secret, String(userAgent || '').slice(0, 200)],
  );
  return { ok: true };
}

export async function removeSubscription(actor, { endpoint } = {}) {
  const ep = String(endpoint || '').trim();
  if (!ep) return { error: 'invalid_endpoint', message: '缺少订阅地址' };
  await pool.query('DELETE FROM push_subscriptions WHERE principal_id = $1 AND endpoint = $2', [actor.id, ep]);
  return { ok: true };
}

/** 设置页用：我这台设备/所有设备的订阅状态（含上次推送时间，用户能自查） */
export async function listSubscriptions(actor) {
  const { rows } = await pool.query(
    `SELECT id, endpoint, created_at, last_seen_at, last_push_at, last_error, attempts
       FROM push_subscriptions WHERE principal_id = $1 ORDER BY last_seen_at DESC LIMIT 10`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    // endpoint 里带推送服务的设备令牌：只回主机名，不回完整地址
    host: (() => {
      try {
        return new URL(r.endpoint).host;
      } catch {
        return 'unknown';
      }
    })(),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    lastPushAt: r.last_push_at,
    lastError: r.last_error ? String(r.last_error).slice(0, 120) : null,
    attempts: Number(r.attempts),
  }));
}

function previewOf(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, BODY_PREVIEW_LEN) : '[新消息]';
}

/**
 * 给离线成员推通知。由 ws/hub.mjs 在 WS 投递之后调用（它已经算好谁是离线的）。
 * 返回 { attempted, sent, failed, skipped }：验证脚本靠「attempted 变了」断言真的尝试过。
 */
export async function notifyOffline({
  conversationId,
  senderId,
  senderName,
  body,
  mentions = [],
  offlineIds = [],
} = {}) {
  if (!pushEnabled()) return { attempted: 0, sent: 0, failed: 0, skipped: 'disabled' };
  const targets = [...new Set(offlineIds.map(Number))].filter((id) => id && id !== Number(senderId));
  if (!targets.length) return { attempted: 0, sent: 0, failed: 0, skipped: 'nobody_offline' };

  const { rows: subs } = await pool.query(
    `SELECT id, principal_id, endpoint, p256dh, auth
       FROM push_subscriptions WHERE principal_id = ANY($1::bigint[])`,
    [targets],
  );
  if (!subs.length) return { attempted: 0, sent: 0, failed: 0, skipped: 'no_subscription' };

  const { rows: conv } = await pool.query('SELECT title FROM conversations WHERE id = $1', [conversationId]);
  const title = (conv[0]?.title || '新消息').slice(0, 60);
  const mentioned = new Set(mentions.map(Number));
  const now = Date.now();
  sweepCooldown(now);

  const payloadOf = (principalId) =>
    JSON.stringify({
      title,
      body: `${senderName || '有人'}: ${previewOf(body)}`,
      conversationId: Number(conversationId),
      // 同会话的通知互相覆盖，避免锁屏堆一列
      tag: `conv-${conversationId}`,
      // 被 @ 了可以标出来（前端 SW 用它决定是否 additionalData，这里只给字段）
      mention: mentioned.has(Number(principalId)),
    });

  let attempted = 0;
  let sent = 0;
  let failed = 0;

  // 冷却按「人 + 会话」算一次，而不是按设备：一个账号两台设备应该同时响，不能只响一台
  const byPrincipal = new Map();
  for (const sub of subs) {
    const pid = Number(sub.principal_id);
    if (!byPrincipal.has(pid)) byPrincipal.set(pid, []);
    byPrincipal.get(pid).push(sub);
  }

  for (const [pid, list] of byPrincipal) {
    const key = `${pid}:${Number(conversationId)}`;
    // 被 @ 的那个人不受冷却限制（否则「叫了你却不响」最让人困惑）
    if (!mentioned.has(pid)) {
      const last = cooldown.get(key) || 0;
      if (now - last < PUSH_COOLDOWN_MS) continue;
    }
    cooldown.set(key, now);

    for (const sub of list) {
      attempted += 1;
      try {
        await sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadOf(pid),
          { TTL: 300, timeout: 5000, urgency: mentioned.has(pid) ? 'high' : 'normal' },
        );
        sent += 1;
        await pool.query(
          'UPDATE push_subscriptions SET last_push_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1',
          [sub.id],
        ).catch(() => {});
      } catch (err) {
        failed += 1;
        const gone = err?.statusCode === 404 || err?.statusCode === 410;
        await pool.query(
          'UPDATE push_subscriptions SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
          [sub.id, String(err?.message || err).slice(0, 200)],
        ).catch(() => {});
        if (gone) {
          // 订阅已失效（用户清了站点数据 / 卸载了 PWA）：留着只会每天失败
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
        }
      }
    }
  }
  return { attempted, sent, failed, skipped: null };
}

/** 只给测试/排障看：清掉进程内冷却表（不暴露成 HTTP 接口） */
export function resetCooldownForTests() {
  cooldown.clear();
}
