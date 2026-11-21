import { pool, withTx } from '../db.mjs';
import { hitRate, lockGroupAndCount } from './submit.mjs';
import { assertNotSuspended, isSuspended } from './suspend.mjs';
import { config } from '../config.mjs';

// ============================================================================
// 推荐群聊（群发现）+ 入群申请。
//
// 写路径没有走 submit()：submit 的命令表只覆盖「消息 + 既有成员关系」，
// 群公开性/入群审批是新的聚合动作。这里的折中与 src/core/social.mjs 一致——
// 「状态写 + 事件插入在同一个事务里」，事件是审计源（C2），不是可选的日志。
//
// 权限口径（产品）：
//   - 改公开设置 / 看申请 / 审批：群主 + 管理员
//   - 申请入群：任何登录用户；不能已是成员
//   - 发现目录：登录即可，不需要是成员
// ============================================================================

const JOIN_REQUESTS_PER_HOUR = 20;
const DESCRIPTION_MAX = 120;
const QUERY_MAX = 40;
const PAGE_MAX = 20;

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

// 20 次/小时的滚动窗口。为什么不直接用 submit 的 hitRate 表达小时预算：
// 它是 60 秒滑动窗口（social.mjs 里叫「每小时」的 dm-new 实际是每分钟）。
// 两层都留：hitRate 挡瞬时连点，小时窗挡长期刷屏；阈值相同，所以实际生效的是小时窗。
// （评审 M1 之后 submit 有了 hitRateHour；这里保持原实现不动，避免同时改两个模块的语义。
//   内存卫生：空桶即时删除，桶数超上限时整体清扫一次——评审 L7 的同类问题。）
const JOIN_HITS_MAX_KEYS = 5000;
const joinHits = new Map();
function joinAllowed(principalId) {
  const now = Date.now();
  const win = (joinHits.get(principalId) || []).filter((t) => now - t < 3_600_000);
  if (win.length >= JOIN_REQUESTS_PER_HOUR) {
    joinHits.set(principalId, win);
    return false;
  }
  win.push(now);
  joinHits.set(principalId, win);
  if (joinHits.size > JOIN_HITS_MAX_KEYS) {
    for (const [k, arr] of joinHits) {
      if (!arr.some((t) => now - t < 3_600_000)) joinHits.delete(k);
    }
  }
  return true;
}

async function roleIn(conversationId, principalId) {
  const { rows } = await pool.query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
    [conversationId, principalId],
  );
  return rows[0]?.role || null;
}

function isGroupAdmin(role) {
  return role === 'owner' || role === 'admin';
}

// ============================================================================
// 读：发现目录
// ============================================================================

/**
 * 公开推荐群目录（登录即可，不需要是成员）。
 *
 * 排序 (last_message_at, id) DESC，与 keyset 游标一致：只按 id 比较会在
 * 「老群刚有人说话」时把它的位置算错，所以游标虽只对外暴露 before_id，
 * 内部还要取出那行的 last_message_at 一起参与比较。
 */
export async function discoverGroups(actor, { q = '', beforeId = 0, limit = 20 } = {}) {
  const keyword = String(q ?? '').trim().slice(0, QUERY_MAX);
  const cap = Math.min(Math.max(Number(limit) || PAGE_MAX, 1), PAGE_MAX);
  const before = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0 ? Number(beforeId) : 0;
  // 关键词里的 % _ \ 是 LIKE 通配符：不转义就会变成「搜 % 等于全表」
  const pattern = keyword ? `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;

  let cursorTs = null;
  if (before) {
    const { rows } = await pool.query(
      'SELECT COALESCE(last_message_at, created_at) AS ts FROM conversations WHERE id = $1',
      [before],
    );
    cursorTs = rows[0]?.ts || null;
  }
  // 游标行不存在（被物理删/传错）时退化成「第一页」，而不是返回空列表
  const cursorId = before && cursorTs ? before : 0;

  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.description, c.join_mode, c.last_message_at, c.created_at,
            (SELECT count(*)::int FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count,
            EXISTS (SELECT 1 FROM conversation_members me
                     WHERE me.conversation_id = c.id AND me.principal_id = $1) AS joined
       FROM conversations c
      WHERE c.discoverable = true
        AND c.dissolved_at IS NULL
        AND c.type = 'group'
        AND ($2::text IS NULL OR c.title ILIKE $2 OR c.description ILIKE $2)
        AND ($4::bigint = 0
             OR (COALESCE(c.last_message_at, c.created_at), c.id) < ($5::timestamptz, $4::bigint))
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT $3`,
    [actor.id, pattern, cap + 1, cursorId, cursorTs],
  );

  const hasMore = rows.length > cap;
  const kept = rows.slice(0, cap);
  const groups = kept.map((r) => {
    const row = {
      id: Number(r.id),
      title: r.title || '未命名群',
      description: String(r.description || ''),
      member_count: Number(r.member_count),
      joined: Boolean(r.joined),
      last_message_at: r.last_message_at || r.created_at,
      join_mode: r.join_mode,
    };
    // camelCase 别名：产品契约字段是 snake_case（member_count/join_mode/last_message_at），
    // 但 web/src/api.ts#discoverGroups 已按 camelCase 取（memberCount/joinMode/lastMessageAt）。
    // 两边同时给，等前端统一成一种再删——先例是 MCP 摘要的 snake 别名（verify-mcp-feedback.mjs）。
    return {
      ...row,
      memberCount: row.member_count,
      joinMode: row.join_mode,
      lastMessageAt: row.last_message_at,
    };
  });
  const nextBeforeId = hasMore && kept.length ? Number(kept[kept.length - 1].id) : null;
  return {
    groups,
    has_more: hasMore,
    next_before_id: nextBeforeId,
    hasMore,
    nextBeforeId,
  };
}

/** 待处理的入群申请（群主/管理员）。非群主/管理员返回 null，路由据此 403。 */
export async function listJoinRequests(actor, conversationId) {
  const cid = Number(conversationId);
  if (!Number.isInteger(cid) || cid <= 0) return null;
  if (!isGroupAdmin(await roleIn(cid, actor.id))) return null;

  const { rows } = await pool.query(
    `SELECT r.principal_id, r.message, r.created_at, p.display_name, p.account_no
       FROM group_join_requests r
       JOIN principals p ON p.id = r.principal_id
      WHERE r.conversation_id = $1 AND r.status = 'pending'
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT 200`,
    [cid],
  );
  return rows.map((r) => ({
    principal_id: Number(r.principal_id),
    display_name: r.display_name,
    account_no: r.account_no == null ? null : Number(r.account_no),
    message: String(r.message || ''),
    created_at: r.created_at,
  }));
}

// ============================================================================
// 写：公开设置 / 申请 / 审批
// ============================================================================

/**
 * 改群的公开推荐设置（群主/管理员）。
 * 支持只传部分字段：undefined = 保持原值（PATCH 语义），显式非法值才 400。
 */
export async function updateGroupPublic(actor, { conversationId, discoverable, joinMode, description } = {}) {
  const cid = Number(conversationId);
  if (!Number.isInteger(cid) || cid <= 0) return bad('invalid_schema', 'conversation_id 非法');
  // [M2] 封禁先于一切：被封禁的人不能改群公开设置（以前只有 send_message 挡封禁）
  const suspended = assertNotSuspended(actor, '修改群设置');
  if (suspended) return bad(suspended.reason, suspended.message);
  if (!isGroupAdmin(await roleIn(cid, actor.id))) {
    return bad('forbidden', '只有群主或管理员可以修改群的推荐设置');
  }

  const { rows } = await pool.query(
    'SELECT discoverable, join_mode, description FROM conversations WHERE id = $1 AND dissolved_at IS NULL',
    [cid],
  );
  const cur = rows[0];
  if (!cur) return bad('not_found', '群不存在或已解散');

  if (discoverable === undefined && joinMode === undefined && description === undefined) {
    return bad('invalid_schema', '至少要修改一个字段（discoverable / join_mode / description）');
  }

  let nextDiscoverable = Boolean(cur.discoverable);
  let nextJoinMode = cur.join_mode;
  let nextDescription = String(cur.description || '');

  if (discoverable !== undefined) {
    if (typeof discoverable !== 'boolean') return bad('invalid_schema', 'discoverable 必须是布尔值');
    nextDiscoverable = discoverable;
  }
  if (joinMode !== undefined) {
    if (joinMode !== 'open' && joinMode !== 'approval') {
      return bad('invalid_schema', "join_mode 只能是 'open' 或 'approval'");
    }
    nextJoinMode = joinMode;
  }
  if (description !== undefined) {
    if (typeof description !== 'string') return bad('invalid_schema', 'description 必须是字符串');
    const text = description.replace(/\r\n/g, '\n').trim();
    // 按码点数字符：用 .length 会把 emoji 算成 2 个字，和「120 字」的产品口径对不上
    if ([...text].length > DESCRIPTION_MAX) {
      return bad('invalid_schema', `群介绍最多 ${DESCRIPTION_MAX} 字`);
    }
    nextDescription = text;
  }

  const changed = nextDiscoverable !== Boolean(cur.discoverable)
    || nextJoinMode !== cur.join_mode
    || nextDescription !== String(cur.description || '');
  // 重复 PATCH 同样的值不写事件：否则审计里全是「改了又改回」的噪声
  if (!changed) {
    return ok({ discoverable: nextDiscoverable, joinMode: nextJoinMode, description: nextDescription, changed: false });
  }

  await withTx(async (client) => {
    await client.query(
      'UPDATE conversations SET discoverable = $2, join_mode = $3, description = $4 WHERE id = $1',
      [cid, nextDiscoverable, nextJoinMode, nextDescription],
    );
    await client.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('conversation', $1, 'GroupPublicityChanged', $2, $3, $4::jsonb)`,
      [cid, actor.id, actor.type, JSON.stringify({
        discoverable: nextDiscoverable,
        join_mode: nextJoinMode,
        description: nextDescription,
      })],
    );
  });

  return ok({
    discoverable: nextDiscoverable,
    joinMode: nextJoinMode,
    description: nextDescription,
    changed: true,
  });
}

/**
 * 申请入群。open → 直接成为成员；approval → 落一条 pending 等群主审批。
 * 幂等：已是成员 → already_member；已有 pending → pending:true 且不重复写事件。
 *
 * 群不公开/不存在/已解散一律 not_found：不通过 403/404 的差异泄露「这个 id 是个私有群」。
 */
export async function requestJoin(actor, conversationId) {
  const cid = Number(conversationId);
  if (!Number.isInteger(cid) || cid <= 0) return bad('invalid_schema', 'conversation_id 非法');
  // [M2] 被封禁的人不能入群：入群 = 拿到这个群的历史读权限，比发言更该先拦
  const suspended = assertNotSuspended(actor, '申请入群');
  if (suspended) return bad(suspended.reason, suspended.message);

  const { rows } = await pool.query(
    `SELECT c.id, c.discoverable, c.join_mode, c.type, c.dissolved_at,
            EXISTS (SELECT 1 FROM conversation_members cm
                     WHERE cm.conversation_id = c.id AND cm.principal_id = $2) AS joined
       FROM conversations c
      WHERE c.id = $1`,
    [cid, actor.id],
  );
  const conv = rows[0];
  if (!conv || conv.type !== 'group' || conv.dissolved_at) return bad('not_found', '找不到这个公开群');
  // 成员调 join 按幂等成功处理（前端「加入」按钮重复点不该报错）
  if (conv.joined) return ok({ already_member: true, joined: true, pending: false, join_mode: conv.join_mode });
  if (!conv.discoverable) return bad('not_found', '找不到这个公开群');

  // 限流只对「真的要写东西」的动作计数：已成员/找不到的请求在上面已经返回
  if (!hitRate(`group-join-burst:${actor.id}`, JOIN_REQUESTS_PER_HOUR)) {
    return bad('rate_limited', '操作太频繁，请稍后再试');
  }
  if (!joinAllowed(actor.id)) {
    return bad('rate_limited', `申请入群太频繁（每小时最多 ${JOIN_REQUESTS_PER_HOUR} 次）`);
  }

  const limits = config.limits;

  if (conv.join_mode === 'open') {
    const out = await withTx(async (client) => {
      // 和 submit.add_member 同一套护栏：每人 50 群、单群 500 人。
      // 不在这里挡的话，公开群会变成绕过容量护栏的后门。
      // 容量判断必须先锁会话行（外部审查 Q10）：并发入群会一起读到「还差 1 个」然后都插进来。
      const cap = await lockGroupAndCount(client, cid, limits.maxGroupMembers);
      if (!cap.exists) return { reason: 'not_found' };
      if (cap.full) return { reason: 'group_full' };
      const mine = await client.query(
        'SELECT count(*)::int AS n FROM conversation_members WHERE principal_id = $1',
        [actor.id],
      );
      if (Number(mine.rows[0].n) >= limits.maxGroupsPerUser) return { reason: 'group_limit' };

      const ins = await client.query(
        `INSERT INTO conversation_members (conversation_id, principal_id, role, reply_mode)
         VALUES ($1, $2, 'member', 'low')
         ON CONFLICT DO NOTHING`,
        [cid, actor.id],
      );
      if (ins.rowCount === 0) return { already: true };
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation', $1, 'GroupJoined', $2, $3, $4::jsonb)`,
        [cid, actor.id, actor.type, JSON.stringify({ join_mode: 'open' })],
      );
      return { joined: true };
    });

    if (out.reason === 'group_limit') return bad('group_limit', `你已达 ${limits.maxGroupsPerUser} 个群上限`);
    if (out.reason === 'not_found') return bad('not_found', '找不到这个公开群');
    if (out.reason === 'group_full') return bad('group_full', `单群最多 ${limits.maxGroupMembers} 人`);
    if (out.already) return ok({ already_member: true, joined: true, pending: false, join_mode: 'open' });
    return ok({ already_member: false, joined: true, pending: false, join_mode: 'open' });
  }

  const out = await withTx(async (client) => {
    const mine = await client.query(
      'SELECT count(*)::int AS n FROM conversation_members WHERE principal_id = $1',
      [actor.id],
    );
    if (Number(mine.rows[0].n) >= limits.maxGroupsPerUser) return { reason: 'group_limit' };

    // 部分唯一索引 group_join_requests_pending_uniq 让并发两次申请只落一条；
    // 这里 ON CONFLICT 的目标必须带上 WHERE status='pending' 才能推断到那个索引。
    const ins = await client.query(
      `INSERT INTO group_join_requests (conversation_id, principal_id, status, message)
       VALUES ($1, $2, 'pending', '')
       ON CONFLICT (conversation_id, principal_id) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [cid, actor.id],
    );
    if (!ins.rows.length) return { duplicated: true };
    await client.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('conversation', $1, 'GroupJoinRequested', $2, $3, $4::jsonb)`,
      [cid, actor.id, actor.type, JSON.stringify({ join_mode: 'approval', request_id: Number(ins.rows[0].id) })],
    );
    return { duplicated: false, request_id: Number(ins.rows[0].id) };
  });

  if (out.reason === 'group_limit') return bad('group_limit', `你已达 ${limits.maxGroupsPerUser} 个群上限`);
  return ok({
    already_member: false,
    joined: false,
    pending: true,
    duplicated: Boolean(out.duplicated),
    ...(out.duplicated ? {} : { request_id: out.request_id }),
  });
}

/** 审批一条 pending 申请（群主/管理员）。accept → 加成员；reject → 只改状态，可再次申请。 */
export async function decideJoinRequest(actor, { conversationId, principalId, accept } = {}) {
  const cid = Number(conversationId);
  const pid = Number(principalId);
  if (!Number.isInteger(cid) || cid <= 0) return bad('invalid_schema', 'conversation_id 非法');
  if (!Number.isInteger(pid) || pid <= 0) return bad('invalid_schema', 'principal_id 非法');
  if (typeof accept !== 'boolean') return bad('invalid_schema', 'accept 必须是布尔值');
  // [M2] 被封禁的管理员不能继续审批（封了还能放人进群 = 封了等于没封）
  const suspended = assertNotSuspended(actor, '审批入群申请');
  if (suspended) return bad(suspended.reason, suspended.message);
  if (!isGroupAdmin(await roleIn(cid, actor.id))) {
    return bad('forbidden', '只有群主或管理员可以审批入群申请');
  }

  try {
    return await withTx(async (client) => {
      // FOR UPDATE：并发两次 accept 只有一次能拿到 pending，第二次是 404 而不是重复加人/重复写事件
      const { rows: pending } = await client.query(
        `SELECT id FROM group_join_requests
          WHERE conversation_id = $1 AND principal_id = $2 AND status = 'pending'
          FOR UPDATE`,
        [cid, pid],
      );
      if (!pending[0]) return bad('not_found', '没有待处理的申请');
      const requestId = Number(pending[0].id);

      if (accept) {
        // [L9] 复核申请人「现在」的状态：封禁期间提交的申请不该在封禁后被无声放进来。
        // 和 requestJoin 的 M2 检查同一口径（principals.suspended_until）。
        const { rows: applicant } = await client.query(
          `SELECT p.suspended_until, a.status AS agent_status
             FROM principals p LEFT JOIN agents a ON a.principal_id = p.id
            WHERE p.id = $1`,
          [pid],
        );
        if (!applicant[0]) return bad('not_found', '申请人不存在');
        if (isSuspended({ suspendedUntil: applicant[0].suspended_until })) {
          return bad('forbidden', '申请人已被封禁，不能通过这条申请');
        }
        if (applicant[0].agent_status && applicant[0].agent_status !== 'active') {
          return bad('forbidden', '申请人的 AI 已被暂停，不能通过这条申请');
        }
        const limits = config.limits;
        const mine = await client.query(
          'SELECT count(*)::int AS n FROM conversation_members WHERE principal_id = $1',
          [pid],
        );
        if (Number(mine.rows[0].n) >= limits.maxGroupsPerUser) {
          return bad('group_limit', `对方已达 ${limits.maxGroupsPerUser} 个群上限`);
        }
        const size = await lockGroupAndCount(client, cid, limits.maxGroupMembers);
        if (!size.exists) return bad('not_found', '找不到这个公开群');
        if (size.full) return bad('group_full', `单群最多 ${limits.maxGroupMembers} 人`);
      }

      await client.query(
        `UPDATE group_join_requests
            SET status = $3, decided_at = now(), decided_by = $4
          WHERE id = $1 AND conversation_id = $2 AND status = 'pending'`,
        [requestId, cid, accept ? 'accepted' : 'rejected', actor.id],
      );
      if (accept) {
        // 申请期间可能已经通过别的入口进群：ON CONFLICT 保证「审批成功」不会被这条 INSERT 变成 500
        await client.query(
          `INSERT INTO conversation_members (conversation_id, principal_id, role, reply_mode)
           VALUES ($1, $2, 'member', 'low')
           ON CONFLICT DO NOTHING`,
          [cid, pid],
        );
      }
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation', $1, $2, $3, $4, $5::jsonb)`,
        [
          cid,
          accept ? 'GroupJoinAccepted' : 'GroupJoinRejected',
          actor.id,
          actor.type,
          JSON.stringify({ principal_id: pid, request_id: requestId }),
        ],
      );

      return ok({ status: accept ? 'accepted' : 'rejected', principal_id: pid, joined: accept });
    });
  } catch (err) {
    console.error('[groups] decide join request failed', err.message);
    return bad('internal', '审批失败，请稍后再试');
  }
}
