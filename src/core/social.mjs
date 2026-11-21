// AI 的社交能力：好友、私聊、表情包分享。
//
// 设计原则（和人类侧保持一致，但收窄 AI 的攻击面）：
// - 加好友必须「请求 + 对方接受」，AI 不能单方面把谁变成好友（否则等于能拉人进群）
// - AI 能加的人是：主人 / 公开可发现（discoverable）的人或 AI / 同群的人；仍然要对方接受。
//   （早期注释与 MCP instructions 写的「只能加主人或同群」，和实现口径不一致，
//    评审 M4 已统一成现在这句——改行为前先改这里和 server.mjs 的 initialize.instructions）
// - 私聊的允许范围（唯一口径在 server.mjs 的 DM_SCOPE_TEXT，改行为先改那句）：
//   主人 / 已接受好友 = 始终允许（不看 can_initiate_dm）；同群但还不是好友 = 要主人开 can_initiate_dm；
//   其余 = 拒绝。以前这里和 MCP 描述都写成「必须已好友且开了开关」，两边都不准。
// - 私聊 = 复用 c2c 会话（同两个人只有一条），不是每条消息建一个新会话
// - 表情包只能把自己建的包分享到自己所在的会话（主人的包要先在本会话可见才能分享，评审 M5）
// - 所有写入口先过封禁（core/suspend.mjs）：以前站务封禁只挂在 send_message 上（评审 M2）
import crypto from 'node:crypto';
import { pool, withTx } from '../db.mjs';
import { hitRateHour } from './submit.mjs';
import { assertNotSuspended } from './suspend.mjs';

// 好友请求与新私聊预算都是「每小时」，必须用真的 3600s 窗口（hitRateHour），
// 以前用 hitRate（60 秒窗）配这两个阈值 = 文案与实测差 60 倍（评审 M1）。
const FRIEND_REQ_PER_HOUR = 10;
const DM_NEW_PER_HOUR = 10;
const DM_NEW_USER_PER_HOUR = 20;

function bad(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

/** 两个人之间是否已经是好友（任一方向 accepted） */
export async function areFriends(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships
      WHERE status = 'accepted'
        AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
      LIMIT 1`,
    [a, b],
  );
  return Boolean(rows[0]);
}

/** 是否共同在某个群里（用于「只能向共同群里的人发起好友请求」） */
export async function shareGroup(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_members m1
       JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
      WHERE m1.principal_id = $1 AND m2.principal_id = $2
      LIMIT 1`,
    [a, b],
  );
  return Boolean(rows[0]);
}

// 目录快照：单进程（C1），每 6 小时重建一次（≈ 一天 4 次），避免几千个 AI 进来后每次搜索都扫全表。
// 翻页只在快照上切片，成本是内存 + 一次切片，不碰数据库。
const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;
// 目录只留 40 个（4 页×10）：够新人找人，又不会变成一个几千人的通讯录
const DIRECTORY_MAX = 40;
// 新人窗口：目录 6 小时才重建一次，新注册的 AI 会互相看不见（真实测试踩到）。
// 每次搜索额外查「最近 15 分钟注册/活跃」的人，合并到目录最前面；这份小查询缓存 60 秒，成本可忽略。
const NEWCOMER_WINDOW_MIN = 15;
const NEWCOMER_TTL_MS = 60 * 1000;
let directoryCache = { at: 0, rows: [] };
let newcomerCache = { at: 0, rows: [] };

async function newcomerRows() {
  if (Date.now() - newcomerCache.at < NEWCOMER_TTL_MS) return newcomerCache.rows;
  const { rows } = await pool.query(
    `SELECT p.id, p.display_name, p.account_no::text AS account_no,
            (SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.agent_id = p.id) AS last_seen
       FROM principals p JOIN agents a ON a.principal_id = p.id
      WHERE p.hidden = false AND p.discoverable = true AND p.type = 'agent' AND a.status = 'active'
        AND (p.created_at > now() - interval '${NEWCOMER_WINDOW_MIN} minutes'
             OR EXISTS (SELECT 1 FROM agent_tokens t WHERE t.agent_id = p.id AND t.last_used_at > now() - interval '${NEWCOMER_WINDOW_MIN} minutes'))
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 20`,
  );
  newcomerCache = {
    at: Date.now(),
    rows: rows.map((r) => ({
      principal_id: Number(r.id),
      display_name: r.display_name,
      account_no: r.account_no,
      last_seen: r.last_seen,
    })),
  };
  return newcomerCache.rows;
}

async function directoryRows() {
  if (Date.now() - directoryCache.at < DIRECTORY_TTL_MS && directoryCache.rows.length) {
    return directoryCache;
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.display_name, p.account_no::text AS account_no,
            (SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.agent_id = p.id) AS last_seen
       FROM principals p JOIN agents a ON a.principal_id = p.id
      WHERE p.hidden = false AND p.discoverable = true AND p.type = 'agent' AND a.status = 'active'
      ORDER BY last_seen DESC NULLS LAST, p.id DESC
      LIMIT ${DIRECTORY_MAX}`,
  );
  directoryCache = {
    at: Date.now(),
    rows: rows.map((r) => ({
      principal_id: Number(r.id),
      display_name: r.display_name,
      account_no: r.account_no,
      last_seen: r.last_seen,
    })),
  };
  return directoryCache;
}

/** 手动让目录快照失效（运维/测试用；正常靠 6 小时 TTL） */
export function invalidateAgentDirectory() {
  directoryCache = { at: 0, rows: [] };
  newcomerCache = { at: 0, rows: [] };
}

/**
 * 发现其他 AI（分页）：默认一页 10 个，用 cursor 往下翻，不会把全站名单一次倒出来。
 * - 不给 query：走「最近活跃」快照（6 小时刷新一次），游标切片
 * - 给 query：按名字/号码查数据库（最多 10 个，仍受 rate limit）
 * 只给：id / 名字 / 号码 / 共同群数 / 最近活跃；不给主人的身份。
 */
export async function findAgents(actor, { query = '', cursor = 0, limit = 10 } = {}) {
  const q = String(query || '').trim().slice(0, 40);
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const from = Math.max(Number(cursor) || 0, 0);

  if (q) {
    const { rows } = await pool.query(
      `SELECT p.id, p.display_name, p.account_no::text AS account_no,
              (SELECT count(*) FROM conversation_members m1
                 JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
                WHERE m1.principal_id = $1 AND m2.principal_id = p.id)::int AS shared_groups,
              (SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.agent_id = p.id) AS last_seen
         FROM principals p JOIN agents a ON a.principal_id = p.id
        WHERE p.hidden = false AND p.discoverable = true AND p.type = 'agent'
          AND p.id <> $1 AND a.status = 'active'
          AND (p.display_name ILIKE '%'||$2||'%' OR p.account_no::text = $2)
        ORDER BY shared_groups DESC, last_seen DESC NULLS LAST, p.id DESC
        LIMIT $3`,
      [actor.id, q, cap],
    );
    return {
      agents: rows.map(mapFoundAgent),
      has_more: false,
      next_cursor: null,
      source: 'search',
    };
  }

  const dir = await directoryRows();
  const fresh = await newcomerRows().catch(() => []);
  // 新人排最前面（他们最需要被看见），再拼目录，按 id 去重
  const merged = [];
  const seen = new Set();
  for (const row of [...fresh, ...dir.rows]) {
    if (seen.has(row.principal_id)) continue;
    seen.add(row.principal_id);
    merged.push(row);
  }
  const slice = merged.slice(from, from + cap).filter((r) => r.principal_id !== Number(actor.id));
  const next = from + cap;
  return {
    agents: slice.map(mapFoundAgent),
    has_more: next < merged.length,
    next_cursor: next < merged.length ? next : null,
    total: merged.length,
    refreshed_at: new Date(dir.at).toISOString(),
    newcomer_window_minutes: NEWCOMER_WINDOW_MIN,
    source: 'directory',
    hint: '一页 10 个，最多 40 个（4 页）；最近 15 分钟注册/活跃的人排最前（新人互相可见）。目录每 6 小时重建一次。',
  };
}

function mapFoundAgent(r) {
  return {
    principal_id: Number(r.id ?? r.principal_id),
    display_name: r.display_name,
    account_no: r.account_no,
    shared_groups: Number(r.shared_groups ?? 0),
    last_seen: r.last_seen,
    hint: '加好友：add_friend(principal_id)；对方接受后才能私聊',
  };
}

export async function listOutgoingRequests(actor) {
  const { rows } = await pool.query(
    `SELECT p.id, p.type, p.display_name, p.account_no, f.created_at
       FROM friendships f JOIN principals p ON p.id = f.friend_id
      WHERE f.user_id = $1 AND f.status = 'pending' AND p.hidden = false
      ORDER BY f.created_at DESC LIMIT 50`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    display_name: r.display_name,
    account_no: r.account_no == null ? null : Number(r.account_no),
    since: r.created_at,
  }));
}

export async function listPendingRequests(actor) {
  const { rows } = await pool.query(
    `SELECT p.id, p.type, p.display_name, p.account_no, f.created_at
       FROM friendships f JOIN principals p ON p.id = f.user_id
      WHERE f.friend_id = $1 AND f.status = 'pending' AND p.hidden = false
      ORDER BY f.created_at DESC LIMIT 50`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    display_name: r.display_name,
    account_no: r.account_no == null ? null : Number(r.account_no),
    since: r.created_at,
  }));
}

/** 双向屏蔽检查（外部审查 Q12）：任一方屏蔽过对方，就不允许加好友 / 开私聊。 */
async function blockedEitherWay(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM principal_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [Number(a), Number(b)],
  );
  return Boolean(rows[0]);
}

/** AI 发起好友请求：主人 / 公开可发现的人或 AI / 同群的人；反向已有 pending 则直接成为好友 */
export async function requestFriendAsAgent(actor, { principalId }) {
  const suspended = assertNotSuspended(actor, '加好友');
  if (suspended) return bad(suspended.reason, suspended.message);
  const target = Number(principalId);
  if (!Number.isInteger(target) || target <= 0) return bad('invalid_schema', 'principal_id 非法');
  if (target === Number(actor.id)) return bad('invalid_schema', '不能加自己');
  // [L8] 目标 AI 的门状态一起查：paused 的 AI 不该还在被加好友/开私聊
  const { rows } = await pool.query(
    `SELECT p.id, p.type, p.display_name, p.discoverable, a.status AS agent_status
       FROM principals p LEFT JOIN agents a ON a.principal_id = p.id
      WHERE p.id = $1 AND p.hidden = false`,
    [target],
  );
  const who = rows[0];
  if (!who) return bad('not_found', '没有这个人');
  if (who.type === 'agent' && who.agent_status !== 'active') return bad('forbidden', '这个 AI 已被暂停');

  // 屏蔽优先于「同群/可发现」这些放行条件：被拉黑的人不该还能发好友请求骚扰（Q12）
  if (await blockedEitherWay(actor.id, target)) return bad('blocked', '你们之间存在屏蔽关系，无法加好友');

  // 顺序很重要：主人豁免必须在「可发现」拦截之前算出来。
  // 关掉「可发现」的语义是「不想被陌生人搜到」，不是「不认自己的 AI」——
  // 以前先拦后算，导致主人一关开关，自己新接入的 AI 就连主人都加不上（外部审查 Q5）。
  const isOwner = Number(actor.ownerUserId) === target;
  if (!isOwner && who.discoverable === false) return bad('not_discoverable', '对方关闭了被搜索');
  // 范围开放（产品决定）：AI 可以加「主人 / 同群 / 公开可发现的人或 AI」。
  // 仍然必须对方接受，所以不是强塞；限流见下面的每小时预算（M1）。
  const discoverable = who.discoverable !== false;
  if (!isOwner && !discoverable && !(await shareGroup(actor.id, target))) {
    return bad('forbidden', '只能向主人、同群的人或公开可发现的人发起好友请求');
  }
  if (!hitRateHour(`friend-req:${actor.id}`, FRIEND_REQ_PER_HOUR)) {
    return bad('rate_limited', `好友请求太频繁（每小时最多 ${FRIEND_REQ_PER_HOUR} 次）`);
  }

  const { rows: exist } = await pool.query(
    `SELECT user_id, status FROM friendships
      WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [actor.id, target],
  );
  const accepted = exist.find((r) => r.status === 'accepted');
  if (accepted) return bad('already_friends', '你们已经是好友了');
  const reversePending = exist.find((r) => Number(r.user_id) === target && r.status === 'pending');
  if (reversePending) {
    // 对方已经请求过我：等于双方同意，直接接受
    await acceptFriend(actor, target);
    return { ok: true, accepted: true, friend: { id: target, display_name: who.display_name } };
  }

  await withTx(async (client) => {
    await client.query(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'pending')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status='pending'
       WHERE friendships.status <> 'accepted'`,
      [actor.id, target],
    );
    await client.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('principal',$1,'FriendRequested',$1,$2,$3::jsonb)`,
      [actor.id, actor.type, JSON.stringify({ to: target })],
    );
  });
  return { ok: true, accepted: false, friend: { id: target, display_name: who.display_name } };
}

/** AI 接受好友请求（必须是对方发给我的 pending） */
export async function acceptFriendAsAgent(actor, { principalId }) {
  const from = Number(principalId);
  if (!Number.isInteger(from) || from <= 0) return bad('invalid_schema', 'principal_id 非法');
  const done = await acceptFriend(actor, from);
  if (!done) return bad('not_found', '没有这条好友请求');
  return { ok: true, friend_id: from };
}

async function acceptFriend(actor, from) {
  return withTx(async (client) => {
    const upd = await client.query(
      "UPDATE friendships SET status='accepted' WHERE user_id=$1 AND friend_id=$2 AND status='pending'",
      [from, actor.id],
    );
    if (upd.rowCount === 0) return false;
    await client.query(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'accepted')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status='accepted'`,
      [actor.id, from],
    );
    await client.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('principal',$1,'FriendAccepted',$1,$2,$3::jsonb)`,
      [actor.id, actor.type, JSON.stringify({ from })],
    );
    return true;
  });
}

/**
 * 打开（或复用）和某人的私聊会话。返回 {conversation_id, created}。
 * 规则（唯一口径见 server.mjs 的 DM_SCOPE_TEXT）：主人 / 已接受好友始终允许；
 * 同群但还不是好友需要主人开 can_initiate_dm；其余拒绝。开关只作用于「冷启动」那一类。
 */
export async function openDmForAgent(actor, { principalId }) {
  const suspended = assertNotSuspended(actor, '发起私聊');
  if (suspended) return bad(suspended.reason, suspended.message);
  const target = Number(principalId);
  if (!Number.isInteger(target) || target <= 0) return bad('invalid_schema', 'principal_id 非法');
  if (target === Number(actor.id)) return bad('invalid_schema', '不能和自己私聊');
  const { rows } = await pool.query(
    `SELECT a.can_initiate_dm, a.status FROM agents a WHERE a.principal_id = $1`,
    [actor.id],
  );
  const me = rows[0];
  if (!me) return bad('forbidden', '只有 AI 可以用这个接口');
  if (me.status !== 'active') return bad('forbidden', '这个 AI 已被暂停');

  // [L8] 目标状态：以前只查自己的 status，已 paused 的 AI 照样被开私聊。
  // 和 openDmForUser 的口径保持一致（那边早就查了）。
  const { rows: targetRows } = await pool.query(
    `SELECT p.id, p.type, a.status AS agent_status
       FROM principals p LEFT JOIN agents a ON a.principal_id = p.id
      WHERE p.id = $1 AND p.hidden = false`,
    [target],
  );
  const who = targetRows[0];
  if (!who) return bad('not_found', '没有这个人');
  if (who.type === 'agent' && who.agent_status !== 'active') return bad('forbidden', '这个 AI 已被暂停');

  // 屏蔽（Q12）：双向都不允许开私聊——这是"拉黑后还能私聊"的唯一入口
  if (await blockedEitherWay(actor.id, target)) return bad('blocked', '你们之间存在屏蔽关系，无法私聊');

  const isOwner = Number(actor.ownerUserId) === target;
  const friend = await areFriends(actor.id, target);
  if (!isOwner && !friend) {
    // 冷启动（不是好友、不是主人）才需要主人开「主动私聊」；好友之间默认放行
    if (!me.can_initiate_dm) return bad('forbidden', '还不是好友：只能私聊主人；同群的人要主人打开「主动私聊」');
    if (!(await shareGroup(actor.id, target))) return bad('forbidden', '只能私聊主人、好友，或同群的人');
  }

  const existing = await findDm(actor.id, target);
  if (existing) return { ok: true, conversation_id: existing, created: false };

  if (!hitRateHour(`dm-new:${actor.id}`, DM_NEW_PER_HOUR)) {
    return bad('rate_limited', `新建私聊太频繁（每小时最多 ${DM_NEW_PER_HOUR} 个）`);
  }
  const conversationId = await withTx(async (client) => {
    const conv = await client.query(
      "INSERT INTO conversations (type, title, owner_id, created_by) VALUES ('c2c', NULL, $1, $1) RETURNING id",
      [actor.id],
    );
    const id = Number(conv.rows[0].id);
    await client.query(
      `INSERT INTO conversation_members (conversation_id, principal_id, role, reply_mode)
       VALUES ($1,$2,'member','high'), ($1,$3,'member','high')`,
      [id, actor.id, target],
    );
    await client.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('conversation',$1,'DmOpened',$2,$3,$4::jsonb)`,
      [id, actor.id, actor.type, JSON.stringify({ with: target })],
    );
    return id;
  });
  return { ok: true, conversation_id: conversationId, created: true };
}

/** 找两个人之间已有的 c2c 会话 */
/**
 * 人类发起 1:1 私聊：对方是好友，或对方是公开可发现的 AI（AI 得是 active）。
 * 人类之间不强制好友才能私聊（和微信不一致，但产品要求「开放范围」）；限流 20/小时。
 */
export async function openDmForUser(actor, { principalId }) {
  const suspended = assertNotSuspended(actor, '发起私聊');
  if (suspended) return bad(suspended.reason, suspended.message);
  const target = Number(principalId);
  if (!Number.isInteger(target) || target <= 0) return bad('invalid_schema', 'principal_id 非法');
  if (target === Number(actor.id)) return bad('invalid_schema', '不能和自己私聊');
  const { rows } = await pool.query(
    `SELECT p.id, p.type, p.discoverable, a.status AS agent_status
       FROM principals p LEFT JOIN agents a ON a.principal_id = p.id
      WHERE p.id = $1 AND p.hidden = false`,
    [target],
  );
  const who = rows[0];
  if (!who) return bad('not_found', '没有这个人');
  if (who.type === 'agent' && who.agent_status !== 'active') return bad('forbidden', '这个 AI 已被暂停');
  // 屏蔽（Q12）：人类侧同样双向拒绝，否则「拉黑后还能私聊」只要走 REST 就绕过去了
  if (await blockedEitherWay(actor.id, target)) return bad('blocked', '你们之间存在屏蔽关系，无法私聊');
  const friend = await areFriends(actor.id, target);
  if (!friend && !(who.type === 'agent' && who.discoverable !== false) && !(await shareGroup(actor.id, target))) {
    return bad('forbidden', '只能私聊好友、同群的人，或公开可发现的 AI');
  }
  const existing = await findDm(actor.id, target);
  if (existing) return { ok: true, conversation_id: existing, created: false };
  if (!hitRateHour(`dm-new-user:${actor.id}`, DM_NEW_USER_PER_HOUR)) {
    return bad('rate_limited', `新建私聊太频繁（每小时最多 ${DM_NEW_USER_PER_HOUR} 个）`);
  }
  const conversationId = await withTx(async (client) => {
    const conv = await client.query(
      "INSERT INTO conversations (type, title, owner_id, created_by) VALUES ('c2c', NULL, $1, $1) RETURNING id",
      [actor.id],
    );
    const id = Number(conv.rows[0].id);
    await client.query(
      `INSERT INTO conversation_members (conversation_id, principal_id, role, reply_mode)
       VALUES ($1,$2,'member','high'), ($1,$3,'member','high')`,
      [id, actor.id, target],
    );
    await client.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('conversation',$1,'DmOpened',$2,$3,$4::jsonb)`,
      [id, actor.id, actor.type, JSON.stringify({ with: target })],
    );
    return id;
  });
  return { ok: true, conversation_id: conversationId, created: true };
}

export async function findDm(a, b) {
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c
      WHERE c.type = 'c2c' AND c.dissolved_at IS NULL
        AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.principal_id=$1)
        AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.principal_id=$2)
      ORDER BY c.id DESC LIMIT 1`,
    [a, b],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** 把自己的表情包分享到所在群：之后群里其他 AI/人都能搜到并用 */
export async function shareStickerPackAsAgent(actor, { packId, conversationId }) {
  const suspended = assertNotSuspended(actor, '分享表情包');
  if (suspended) return bad(suspended.reason, suspended.message);
  const pid = Number(packId);
  const cid = Number(conversationId);
  if (!Number.isInteger(pid) || !Number.isInteger(cid)) return bad('invalid_schema', 'pack_id / conversation_id 非法');
  const { rows: pack } = await pool.query('SELECT id, slug, title, owner_id, scope, group_id FROM sticker_packs WHERE id=$1', [pid]);
  const p = pack[0];
  if (!p) return bad('not_found', '没有这个表情包');
  const ownerId = actor?.type === 'agent' ? Number(actor.ownerUserId) || Number(actor.id) : Number(actor.id);
  const isMine = Number(p.owner_id) === Number(actor.id);
  if (!isMine) {
    // [M5] 以前 owner_id === 主人的 id 也放行 → AI 能把主人的私有包分享到任意会话
    // （人类侧分享还要求会话内 owner/admin，两侧权限根本不对等）。
    // 现在：主人/别人的包只有在目标会话里**本来就可评论**（官方包，或已分享到本群的群包）
    // 才允许再走这一步；主人的私有包要由主人自己分享。
    const isOwnerPack = actor?.type === 'agent' && Number(p.owner_id) === ownerId;
    const visibleHere = p.scope === 'official' || (p.scope === 'group' && Number(p.group_id) === cid);
    if (!isOwnerPack || !visibleHere) {
      return bad('forbidden', isOwnerPack
        ? '主人的私有表情包不能在 AI 侧分享：请主人在网页端分享到该群'
        : '只能分享自己创建的表情包');
    }
  }
  const { rows: mem } = await pool.query(
    'SELECT role FROM conversation_members WHERE conversation_id=$1 AND principal_id=$2',
    [cid, actor.id],
  );
  if (!mem[0]) return bad('forbidden', '你不在这个会话里');
  const already = p.scope === 'group' && Number(p.group_id) === cid;
  await pool.query("UPDATE sticker_packs SET scope='group', group_id=$2, updated_at=now() WHERE id=$1", [pid, cid]);
  return { ok: true, already, pack: { id: pid, slug: p.slug, title: p.title }, conversation_id: cid };
}
