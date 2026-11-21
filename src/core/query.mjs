import crypto from 'node:crypto';
import { pool, writerPool, readQuery } from '../db.mjs';
import { hydrateParts, mediaUrl } from '../media.mjs';
import { config } from '../config.mjs';

// ============================================================================
/** 头像地址：本站附件 → 签名 /media 地址；外链原样；都没有 → null（前端回退几何头像） */
export function avatarOf(row) {
  if (!row) return null;
  if (row.avatar_url) return String(row.avatar_url);
  if (row.avatar_attachment_id) return mediaUrl(Number(row.avatar_attachment_id));
  return null;
}

// 读路径：所有查询都必须先过成员资格（conversation_members），
// 因为 [C3] 只防住了写，读隔离只能靠这里 + 后续的 RLS 增强。
// ============================================================================

/**
 * 「和我有屏蔽关系的人」= 我屏蔽的 ∪ 屏蔽我的（外部审查 Q12：单向写、双向生效）。
 *
 * 为什么不把条件写进 SQL：消息/搜索/增量三条读路径各自是**命名预处理语句**，
 * 加一个 EXISTS 子查询会改动 SQL 形状 → 10 条命名语句的计划与 `verify-read-plan` 全部跟着动。
 * 屏蔽是小规模、低基数的社交关系，在结果集最后一步过滤的代价可以忽略；
 * 代价是「一页可能少几条」（LIMIT 之后再过滤），已在 docs/架构与约束.md §18 写明。
 */
export async function blockRelationsOf(principalId) {
  const me = Number(principalId);
  if (!Number.isInteger(me) || me <= 0) return new Set();
  // 主人的屏蔽对「自己的 AI」同样生效：AI 是主人的代理，主人拉黑的人不该再由 AI 转达进来。
  // 反向不成立——AI 被别人拉黑，不影响主人自己是否看得到对方的消息。
  const { rows: own } = await pool.query(
    'SELECT owner_user_id FROM agents WHERE principal_id = $1',
    [me],
  ).catch(() => ({ rows: [] }));
  const selfIds = new Set([me]);
  for (const r of own) if (r.owner_user_id != null) selfIds.add(Number(r.owner_user_id));
  const { rows } = await pool.query(
    `SELECT blocker_id, blocked_id FROM principal_blocks
      WHERE blocker_id = ANY($1::bigint[]) OR blocked_id = ANY($1::bigint[])`,
    [[...selfIds]],
  );
  const out = new Set();
  for (const r of rows) {
    const blocker = Number(r.blocker_id);
    const blocked = Number(r.blocked_id);
    // 只把「对方」放进屏蔽集合；自己和自己的主人不算
    if (!selfIds.has(blocker)) out.add(blocker);
    if (!selfIds.has(blocked)) out.add(blocked);
  }
  return out;
}

export async function listConversationsFor(actor, { offset = 0, limit = 100 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);
  const { rows } = await readQuery('aio_conv_list', READ_SQL.listConversations, [actor.id, cap, skip]);
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const { rows: memberRows } = await readQuery('aio_conv_members', READ_SQL.listConversationMembers, [ids]);
  const byConv = new Map();
  for (const m of memberRows) {
    const key = Number(m.conversation_id);
    if (!byConv.has(key)) byConv.set(key, []);
    byConv.get(key).push({
      id: Number(m.id),
      type: m.type,
      displayName: m.display_name,
      avatarHue: m.avatar_hue,
      avatarUrl: avatarOf(m),
      role: m.role,
      replyMode: m.reply_mode,
      allowAiRelay: Boolean(m.allow_ai_relay),
      lastReadSeq: Number(m.last_read_seq),
      // AI 成员专属：主人昵称、状态、上次同步时间（UI 要显示"由谁创建 / 上次同步"）
      ownerName: m.owner_name || null,
      agentStatus: m.agent_status || null,
      lastSyncedAt: m.last_synced || null,
    });
  }
  return rows.map((r) => {
    const full = byConv.get(Number(r.id)) || [];
    // 小群（≤50 人）保持原样，老客户端和现有测试不用改；
    // 大群只给「前 20 个 AI + 计数」，成员面板走 /api/conversations/:id/members 懒加载。
    const small = full.length <= 50;
    const agents = full.filter((m) => m.type === 'agent');
    return {
      id: Number(r.id),
      type: r.type,
      title: r.title || '未命名群',
      lastSeq: Number(r.last_seq),
      lastReadSeq: Number(r.last_read_seq),
      unread: Math.max(0, Number(r.last_seq) - Number(r.last_read_seq)),
      role: r.role,
      replyMode: r.reply_mode,
      // 群公告/群规（纯文本，≤2000 字）：AI 与人都从会话列表读它，不需要额外请求。
      // 空字符串 = 这个群没写公告；updatedAt 为 null = 从没改过。
      announcement: r.announcement || '',
      announcementUpdatedAt: r.announcement_updated_at || null,
      lastMessagePreview: r.last_body || '',
      lastMessageAt: r.last_message_at || r.created_at,
      createdAt: r.created_at,
      memberCount: full.length,
      agentCount: agents.length,
      members: small ? full : agents.slice(0, 20),
      membersComplete: small,
    };
  });
}

/**
 * 单个会话的群公告/群规（MCP resources/read + prompts/get 用）。
 * 一定要过 conversation_members：URI 里的 conversation_id 是客户端可猜的，
 * 不过成员资格就等于把别的群的群规/群名读出去。
 * 非成员/已解散/不存在统一返回 null（调用方回 forbidden，不泄露存在性）。
 */
export async function conversationRulesFor(actor, conversationId) {
  const cid = Number(conversationId);
  if (!Number.isSafeInteger(cid) || cid <= 0) return null;
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.announcement, c.announcement_updated_at
       FROM conversations c
       JOIN conversation_members cm
         ON cm.conversation_id = c.id AND cm.principal_id = $2
      WHERE c.id = $1 AND c.dissolved_at IS NULL`,
    [cid, actor.id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    title: r.title || '未命名群',
    announcement: r.announcement || '',
    updatedAt: r.announcement_updated_at || null,
  };
}

/** 完整成员列表（成员面板、@ 补全用），要求调用者在群里 */
export async function getMembers(actor, conversationId) {
  const { rows: me } = await pool.query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
    [conversationId, actor.id],
  );
  if (!me[0]) return null;
  const { rows } = await pool.query(
    `SELECT cm.role, cm.reply_mode, cm.allow_ai_relay, cm.last_read_seq,
            p.id, p.type, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id,
            a.status AS agent_status, owner.display_name AS owner_name,
            (SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.agent_id = cm.principal_id) AS last_synced
       FROM conversation_members cm
       JOIN principals p ON p.id = cm.principal_id
       LEFT JOIN agents a ON a.principal_id = cm.principal_id
       LEFT JOIN principals owner ON owner.id = a.owner_user_id
      WHERE cm.conversation_id = $1
      ORDER BY p.type DESC, p.display_name
      LIMIT 2000`,
    [conversationId],
  );
  return rows.map((m) => ({
    id: Number(m.id),
    type: m.type,
    displayName: m.display_name,
    avatarHue: m.avatar_hue,
    avatarUrl: avatarOf(m),
    role: m.role,
    replyMode: m.reply_mode,
    allowAiRelay: Boolean(m.allow_ai_relay),
    lastReadSeq: Number(m.last_read_seq),
    ownerName: m.owner_name || null,
    agentStatus: m.agent_status || null,
    lastSyncedAt: m.last_synced || null,
  }));
}

// ----------------------------------------------------------------------------
// 读路径 SQL 原文集中在这里，两处消费：
//   1) src/db.mjs#readQuery(name, text, values)：稳定 name → 连接级预处理，省掉每条请求的规划；
//   2) scripts/verify/verify-read-plan.mjs：直接 import 这份原文跑 EXPLAIN 断言。
// 不把 SQL 复制进 verify：改查询时脚本自动跟上，不会出现「脚本还是绿的、线上已回退」。
//
// 消息页不再经过视图 messages（= messages_meta JOIN events）。原因：视图把 events 内联进
// 每个引用点，getMessages 的「取窗口 + 引用预览」会让 events 被读两遍，且规划器常把
// LIMIT 压到 join 之后 —— 实测走 messages_sender_created_idx 全索引扫 242 行才取 50 行。
// 现在先按 (conversation_id, seq) 走 messages_pkey 把窗口物化，再按 event_id 回表取
// body/parts：每页只回 50 次 events_pkey，引用预览也只多一次 messages_meta + 一次 events。
// 视图的列语义必须原样复刻：body = COALESCE(payload->>'body','')，parts = COALESCE(payload->'parts','[]')。
// ----------------------------------------------------------------------------
const MSG_WINDOW_COLS = `m.conversation_id, m.seq, m.event_id, m.sender_id, m.sender_type, m.kind,
         m.reply_to_seq, m.mentions, m.created_at, m.recalled_at`;
const MSG_SELECT = `w.seq, w.event_id, w.sender_id, w.sender_type, w.kind,
       COALESCE(e.payload->>'body', '') AS body, w.reply_to_seq, w.mentions, w.created_at, w.recalled_at,
       COALESCE(e.payload->'parts', '[]'::jsonb) AS parts,
       p.display_name AS sender_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id,
       re.payload->>'body' AS reply_body, r.sender_id AS reply_sender_id, rp.display_name AS reply_sender_name`;
// 引用预览：r 只取 messages_meta（seq/sender），正文从 re 的那一次 events 回表取。
// 注意 re.payload->>'body' 不套 COALESCE：没有引用行时旧视图给 NULL，套了会变成 ''（虽然
// replyPreview 对两者都回 null，但保持行形状一致能让回归脚本的逐字段 diff 有意义）。
const MSG_JOINS = `FROM win w
       JOIN events e ON e.id = w.event_id
       JOIN principals p ON p.id = w.sender_id
       LEFT JOIN messages_meta r ON r.conversation_id = w.conversation_id AND r.seq = w.reply_to_seq
       LEFT JOIN events re ON re.id = r.event_id
       LEFT JOIN principals rp ON rp.id = r.sender_id`;

const DIGEST_LIMIT = 5000;

export const READ_SQL = {
  listConversations: `SELECT c.id, c.type, c.title, c.last_seq, c.created_at, c.last_message_at, cm.role, cm.reply_mode, cm.last_read_seq,
            c.announcement, c.announcement_updated_at,
            (SELECT m.body FROM messages m
              WHERE m.conversation_id = c.id AND m.recalled_at IS NULL AND m.hidden_at IS NULL
              ORDER BY m.seq DESC LIMIT 1) AS last_body
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE cm.principal_id = $1 AND c.dissolved_at IS NULL
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      LIMIT $2 OFFSET $3`,
  // 成员列表：会话页一次要拉「当前页所有会话」的成员（≤50 会话 × N 人）。
  // 写成 LATERAL + LIMIT 1 是为了让规划器对每个成员走 principals_pkey / agents_pkey，
  // 而不是把 principals（2905 行）和 agents（842 行）整表扫一遍再 hash join ——
  // 实测 14 个成员时 3.1ms → 1.7ms（EXPLAIN: Seq Scan(principals) 0.75ms 消失）。
  // LIMIT 1 不改变行数：principals.id / agents.principal_id 都是唯一键，关联最多一行。
  // 注意：成员数远大于 principals 表时（例如一页 50 个 500 人群）nested loop 反而更慢；
  // 本库 345 会话 / 955 成员关系、单群上限 500 人，仍属于索引查找更划算的区间。
  listConversationMembers: `SELECT cm.conversation_id, cm.role, cm.reply_mode, cm.allow_ai_relay, cm.last_read_seq,
            p.id, p.type, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id,
            a.status AS agent_status, owner.display_name AS owner_name,
            (SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.agent_id = cm.principal_id) AS last_synced
       FROM conversation_members cm
       JOIN LATERAL (SELECT pp.id, pp.type, pp.display_name, pp.avatar_hue, pp.avatar_url, pp.avatar_attachment_id
                       FROM principals pp WHERE pp.id = cm.principal_id LIMIT 1) p ON true
       LEFT JOIN LATERAL (SELECT ag.status, ag.owner_user_id
                            FROM agents ag WHERE ag.principal_id = cm.principal_id LIMIT 1) a ON true
       LEFT JOIN LATERAL (SELECT ow.display_name FROM principals ow WHERE ow.id = a.owner_user_id LIMIT 1) owner ON true
      WHERE cm.conversation_id = ANY($1::bigint[])
      ORDER BY p.type DESC, p.display_name`,
  messagesSince: `WITH win AS MATERIALIZED (
  SELECT ${MSG_WINDOW_COLS}
    FROM messages_meta m
   WHERE m.conversation_id = $1 AND m.seq > $2 AND m.hidden_at IS NULL
   ORDER BY m.seq ASC
   LIMIT $3
)
SELECT ${MSG_SELECT}
  ${MSG_JOINS}
 ORDER BY w.seq ASC`,
  messagesBefore: `WITH win AS MATERIALIZED (
  SELECT ${MSG_WINDOW_COLS}
    FROM messages_meta m
   WHERE m.conversation_id = $1 AND m.seq < $2 AND m.hidden_at IS NULL
   ORDER BY m.seq DESC
   LIMIT $3
)
SELECT ${MSG_SELECT}
  ${MSG_JOINS}
 ORDER BY w.seq ASC`,
  messageBySeq: `WITH win AS MATERIALIZED (
  SELECT ${MSG_WINDOW_COLS}
    FROM messages_meta m
   WHERE m.conversation_id = $1 AND m.seq = $2 AND m.hidden_at IS NULL
   LIMIT 1
)
SELECT ${MSG_SELECT}
  ${MSG_JOINS}`,
  // `ORDER BY e.id + 0` 不是笔误：命名语句第 6 次执行后 PG 可能切 generic plan，
  // 那时它不知道 $1/$2 的选择性（估 1 行），于是按 events_pkey 的 id 顺序边扫边过滤、
  // 以为能提前停 —— 实测 since=0 时把 1.8 万条 events 全扫一遍（bufs 12274 vs 8037）。
  // 排序键写成表达式后 generic plan 也必须先取候选行再排序，于是稳定走
  // events_message_cursor_idx (aggregate_id, id)；语义不变（bigint 加 0，id 唯一）。
  whatsNewFor: `SELECT e.id AS event_id, e.aggregate_id AS conversation_id, e.seq,
            e.actor_id AS sender_id, e.actor_type AS sender_type,
            p.display_name AS sender_name, p.avatar_url, p.avatar_attachment_id,
            COALESCE(e.payload->>'body', '') AS body,
            m.mentions, m.reply_to_seq, m.created_at, m.relay_depth,
            COALESCE(e.payload->'parts', '[]'::jsonb) AS parts, m.kind
       FROM events e
       JOIN messages_meta m ON m.event_id = e.id
       JOIN principals p ON p.id = e.actor_id
      WHERE e.type = 'MessageSent' AND e.id > $1 AND e.aggregate_id = ANY($2::bigint[])
        AND m.hidden_at IS NULL
        AND m.recalled_at IS NULL
      ORDER BY e.id + 0 ASC
      LIMIT $3`,
  whatsNewDigestFor: `SELECT e.id AS event_id, e.aggregate_id AS conversation_id, e.seq,
            e.actor_id AS sender_id, e.actor_type AS sender_type,
            p.display_name AS sender_name, m.mentions, m.created_at,
            c.title
       FROM events e
       JOIN messages_meta m ON m.event_id = e.id
       JOIN principals p ON p.id = e.actor_id
       JOIN conversations c ON c.id = e.aggregate_id
      WHERE e.type = 'MessageSent' AND e.id > $1 AND e.aggregate_id = ANY($2::bigint[])
        AND m.hidden_at IS NULL
        AND m.recalled_at IS NULL
      ORDER BY e.id ASC
      LIMIT ${DIGEST_LIMIT}`,
  headFor: `SELECT cm.conversation_id, c.last_seq, cm.last_read_seq
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.principal_id = $1`,
};

/** 行 → 对外消息对象；parts 的签名 URL 由 hydrateMessageParts 批量补 */
function mapMessageRow(r) {
  return {
    seq: Number(r.seq),
    eventId: Number(r.event_id),
    senderId: Number(r.sender_id),
    senderType: r.sender_type,
    // 'text' | 'system'：系统消息在群里居中灰字展示（表情包分享等事件反馈）
    kind: r.kind || 'text',
    senderName: r.sender_name,
    avatarHue: r.avatar_hue,
    avatarUrl: avatarOf(r),
    body: r.recalled_at ? '' : r.body,
    parts: r.recalled_at ? [] : r.parts,
    recalledAt: r.recalled_at,
    replyToSeq: r.reply_to_seq == null ? null : Number(r.reply_to_seq),
    replyPreview: r.reply_body ? String(r.reply_body).slice(0, 40) : null,
    replySenderName: r.reply_sender_name || null,
    mentions: (r.mentions || []).map(Number),
    createdAt: r.created_at,
  };
}

/**
 * 批量补 parts 的附件元数据（一条消息最多 5 段，全部一次查完，避免 N+1）。
 *
 * 为什么改成委托 `media.mjs#hydrateParts`：以前这里有一份「自己实现」的合并逻辑，
 * 和 MCP 那条读路径各写一遍，扫描态（外部审查 Q6：pending 只有上传者可见）一改就会漂移成
 * 「REST 漏了、MCP 拦了」。签名 URL 的签发规则必须只有一份。
 *
 * `viewerId` = 这次请求的读者（人类或 Agent）；不传 = 非上传者视角（fail-closed）。
 */
async function hydrateMessageParts(rows, viewerId = null) {
  const lists = rows.map((r) => (Array.isArray(r.parts) ? r.parts : []));
  const needsHydrate = lists.some((l) => l.some((p) => p && (p.attachment_id || p.poster_attachment_id)));
  if (!needsHydrate) return;
  const hydrated = await hydrateParts(lists.flat(), viewerId);
  let i = 0;
  for (let k = 0; k < rows.length; k++) {
    const n = lists[k].length;
    if (!n) {
      rows[k].parts = [];
      continue;
    }
    rows[k].parts = hydrated.slice(i, i + n);
    i += n;
  }
}

/**
 * 拉消息。两种分页方向：
 *   - since_seq（默认 0）：向下增量（断线补齐 / 打开会话后拉新）
 *   - before_seq（>0）：向上翻历史（外部评审前端 §4-1）。按 seq DESC 取一窗再反转成升序，
 *     所以返回的永远是「紧挨着游标的上一页」，不是最老的一页。
 */
export async function getMessages(actor, conversationId, { sinceSeq = 0, beforeSeq = 0, limit = 50 } = {}) {
  // 成员资格与 last_seq 一次查完：JOIN conversations 让同一行既回答「我是不是成员」，
  // 也带回「这个会话到第几条」。非成员仍然没有行 → 返回 null，语义不变；少一次 DB 往返。
  const { rows: member } = await pool.query(
    `SELECT c.last_seq
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.conversation_id = $1 AND cm.principal_id = $2`,
    [conversationId, actor.id],
  );
  if (!member[0]) return null;

  const cap = Math.min(Number(limit) || 50, 200);
  const before = Number(beforeSeq) || 0;
  // 两个方向都先把窗口物化在 messages_meta 上（messages_pkey + Index Cond + hidden_at），
  // 再按 event_id 回表取正文；外层统一 ORDER BY seq ASC，所以 before 方向不再需要 JS reverse。
  const res = before > 0
    ? await readQuery('aio_msgs_before', READ_SQL.messagesBefore, [conversationId, before, cap])
    : await readQuery('aio_msgs_since', READ_SQL.messagesSince, [conversationId, Number(sinceSeq) || 0, cap]);
  // 屏蔽关系（Q12）：单向写、双向生效 —— 对方的消息我看不到，我的对方也看不到。
  // 在结果集最后一步过滤；代价是这一页可能少几条（见 blockRelationsOf 的注释）。
  const blocked = await blockRelationsOf(actor.id);
  const rows = blocked.size ? res.rows.filter((r) => !blocked.has(Number(r.sender_id))) : res.rows;
  await hydrateMessageParts(rows, actor.id);
  return {
    lastSeq: Number(member[0]?.last_seq || 0),
    messages: rows.map(mapMessageRow),
  };
}

/**
 * 群上下文快照（外部审查 Q3）：给「刚进群 / 进程重启丢了本地上下文」的 Agent 一个一次拿全的**只读**入口。
 *
 * 与 whats_new 的分工：whats_new 是「增量 + 游标」，get_context 是「这个群现在是什么样」，
 * 而且**绝不推进任何游标**（不写 agent_cursors，也不碰 last_read_seq）。
 *
 * 三条必须守住的口径：
 *   1) 严格成员校验：非成员 / 已解散 / 不存在一律返回 null（调用方回 not_found，不泄露存在性）。
 *   2) 消息可见性与 whats_new 完全一致：复用同一份 messagesBefore SQL + 同一个 hydrate
 *      （撤回/隐藏过滤 + 媒体扫描态按 viewer 分流），不另写一套查询——否则迟早两套规则打架。
 *   3) 只返回这一个会话：不跨会话拼任何东西，也不返回「我还能看哪些群」这类列表信息。
 *
 * 「最近 N 条」的实现：seq < last_seq+1 的倒序窗口（= 最新一页），再翻成升序。
 * before_seq 显式给了就取更早的一页（分页用 seq，不是全局 event_id）。
 */
export async function getContextFor(actor, conversationId, { beforeSeq = 0, limit = 20 } = {}) {
  const cid = Number(conversationId);
  if (!Number.isSafeInteger(cid) || cid <= 0) return null;

  // 一次查完「我在这个群的身份 + 群元信息 + 公告 + 接力配置」：少一次 DB 往返，也避免
  // 先查群后查成员时中间被踢出去（同一条 JOIN 里拿到的才是同一时刻的一致视图）。
  const { rows: head } = await pool.query(
    `SELECT c.id, c.type, c.title, c.announcement, c.announcement_updated_at, c.last_seq,
            c.agent_relay_max_depth AS relay_max_depth,
            cm.role, cm.reply_mode, cm.allow_ai_relay
       FROM conversations c
       JOIN conversation_members cm
         ON cm.conversation_id = c.id AND cm.principal_id = $2
      WHERE c.id = $1 AND c.dissolved_at IS NULL`,
    [cid, actor.id],
  );
  const h = head[0];
  if (!h) return null;

  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const lastSeq = Number(h.last_seq) || 0;
  const before = Number(beforeSeq) > 0 ? Number(beforeSeq) : lastSeq + 1;
  const res = await readQuery('aio_msgs_before', READ_SQL.messagesBefore, [cid, before, cap]);
  // 撤回的消息**不返回**：whats_new 的 SQL 一直是 `recalled_at IS NULL`（AI 从来看不到被撤回的事件），
  // 而 REST 消息列表会保留一条空 body 占位给网页显示"撤回了一条消息"。get_context 是给 AI 建上下文的，
  // 跟 whats_new 对齐更合理——否则 AI 会看到一条空正文消息，容易当成"消息损坏"去追问。
  const rows = res.rows.filter((r) => !r.recalled_at);
  await hydrateMessageParts(rows, actor.id);

  const members = (await getMembers(actor, cid)) || [];
  return {
    conversation: { id: cid, type: h.type, title: h.title || '未命名群' },
    announcement: h.announcement || '',
    announcementUpdatedAt: h.announcement_updated_at || null,
    me: {
      role: h.role,
      replyMode: h.reply_mode,
      allowAiRelay: Boolean(h.allow_ai_relay),
      relayMaxDepth: Number(h.relay_max_depth ?? 2),
    },
    members: members.map((m) => ({ id: m.id, type: m.type, displayName: m.displayName, role: m.role })),
    messages: rows.map((r) => ({ ...mapMessageRow(r), conversationId: cid })),
    lastSeq,
    // 用**过滤前**的条数判断：这一页取满了说明可能还有更早的（撤回被滤掉不代表到底了）
    hasMoreBefore: res.rows.length >= cap,
  };
}

/**
 * 单条消息：compact 帧回补专用（外部评审前端 §4-6）。
 * 以前为了取一条大消息的正文要 backfill 一整窗 200 条，大群连发图片时成本被放大 200 倍。
 */
export async function getMessageBySeq(actor, conversationId, seq) {
  const { rows: member } = await pool.query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
    [conversationId, actor.id],
  );
  if (!member[0]) return null;
  const { rows } = await readQuery('aio_msg_by_seq', READ_SQL.messageBySeq, [conversationId, Number(seq) || 0]);
  if (!rows[0]) return null;
  // 单条回补也不能绕过屏蔽（Q12）：否则客户端只要拿着 seq 就能把对方的消息捞回来
  const blocked = await blockRelationsOf(actor.id);
  if (blocked.has(Number(rows[0].sender_id))) return null;
  await hydrateMessageParts(rows, actor.id);
  return { message: mapMessageRow(rows[0]) };
}

/**
 * 消息搜索：只在「我加入的会话」里按关键词搜正文。
 *
 * 为什么直接查 events 而不用 messages 视图：
 *   视图列上的 ILIKE 命中不了迁移 013 建在 `payload->>'body'` 上的 trigram 表达式索引，
 *   会退化成全表扫 + join。这里先按表达式过滤 events，再 join messages_meta 拿 seq/撤回态。
 *
 * 为什么分页游标是 before_event_id 而不是 before_seq：
 *   seq 是**每个会话各自**的序号，跨会话做「上一条」没有全局意义；events.id 是全局单调
 *   （插入顺序），用它倒序分页才能保证翻页不重不漏。
 *
 * 权限：成员资格用 conversation_members 内连接完成 —— 不是成员的行根本不会出现在结果里，
 * 不靠调用方传对 conversation_id。
 */
export async function searchMessages(actor, { q, conversationId = null, beforeEventId = null, limit = 20 } = {}) {
  const keyword = String(q ?? '').trim().slice(0, 50);
  const empty = { query: keyword, results: [], hasMore: false, nextBeforeEventId: null };
  if (!keyword) return empty;

  const cap = Math.min(Math.max(Number(limit) || 20, 1), 30);
  const convId = Number.isInteger(Number(conversationId)) && Number(conversationId) > 0 ? Number(conversationId) : null;
  const before = Number.isFinite(Number(beforeEventId)) && Number(beforeEventId) > 0 ? Number(beforeEventId) : null;
  // 关键词里的 % _ \ 是 LIKE 的通配符/转义符：不转义就会变成「搜 % 等于全表」
  const pattern = `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  const { rows } = await pool.query(
    `SELECT m.conversation_id, c.title AS conversation_title,
            m.seq, m.event_id, m.sender_id, m.sender_type, m.kind, m.created_at,
            p.display_name AS sender_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id,
            substring(e.payload->>'body'
                      from greatest(1, strpos(lower(e.payload->>'body'), lower($3)) - 18)
                      for 90) AS snippet,
            greatest(1, strpos(lower(e.payload->>'body'), lower($3)) - 18) AS snippet_start,
            char_length(e.payload->>'body') AS body_len
       FROM events e
       JOIN messages_meta m ON m.event_id = e.id
       JOIN conversations c ON c.id = m.conversation_id
       JOIN principals p ON p.id = m.sender_id
      WHERE e.type = 'MessageSent'
        AND m.recalled_at IS NULL
        AND m.hidden_at IS NULL
        AND e.payload->>'body' ILIKE $2
        AND m.conversation_id IN (
              SELECT cm.conversation_id FROM conversation_members cm WHERE cm.principal_id = $1
            )
        AND ($4::bigint IS NULL OR m.conversation_id = $4::bigint)
        AND ($5::bigint IS NULL OR e.id < $5::bigint)
      ORDER BY e.id DESC
      LIMIT $6`,
    [actor.id, pattern, keyword, convId, before, cap + 1],
  );

  // 搜索也要按屏蔽过滤（Q12）：否则"搜关键词"成了绕过屏蔽读对方消息的后门。
  const blocked = await blockRelationsOf(actor.id);
  const visible = blocked.size ? rows.filter((r) => !blocked.has(Number(r.sender_id))) : rows;
  const hasMore = rows.length > cap;
  const kept = visible.slice(0, cap).map((r) => {
    const raw = String(r.snippet ?? '');
    const start = Number(r.snippet_start) || 1;
    const len = Number(r.body_len) || 0;
    return {
      conversationId: Number(r.conversation_id),
      conversationTitle: r.conversation_title || '未命名群',
      seq: Number(r.seq),
      eventId: Number(r.event_id),
      senderId: Number(r.sender_id),
      senderType: r.sender_type,
      senderName: r.sender_name,
      avatarHue: r.avatar_hue,
      avatarUrl: avatarOf(r),
      kind: r.kind || 'text',
      // 命中片段（前后各留 18/72 字上下文），超出部分用省略号，别把 4000 字整段发给列表页
      body: `${start > 1 ? '…' : ''}${raw}${start + 89 < len ? '…' : ''}`,
      createdAt: r.created_at,
    };
  });

  return {
    query: keyword,
    results: kept,
    hasMore,
    nextBeforeEventId: hasMore && kept.length ? kept[kept.length - 1].eventId : null,
  };
}

// [C10] 判断这只 AI 对某条消息是否"可以回"
// 档位：off 静音 / low 只回 @ / mid 回 @ + 主动插话 / high 回所有人类消息
// relay：目标消息是 AI 时，需要 allow_ai_relay 且深度 < 2
const LEVEL_ALIAS = { mention: 'low', free: 'high', off: 'off', low: 'low', mid: 'mid', high: 'high' };

function mayReply(memberRow, event, actorId) {
  const level = LEVEL_ALIAS[memberRow.reply_mode] || 'low';
  if (level === 'off') return false;
  // 自己发的消息一律 false：懒轮询客户端会把自己的发言当成"有人说话"而自嗨循环
  if (Number(event.senderId) === Number(actorId)) return false;
  // 系统消息（表情包分享这类事件反馈）不触发 AI 回话
  if (event.kind === 'system') return false;
  if (event.senderType === 'agent') {
    // 接力深度必须和写侧（checkAgentGating）用同一份群配置，否则读侧说"别回"、写侧却放行
    const maxDepth = Number(memberRow.relay_max_depth ?? 2);
    return Boolean(memberRow.allow_ai_relay) && Number(event.relayDepth || 0) < maxDepth;
  }
  const mentioned = (event.mentions || []).map(Number).includes(actorId);
  if (level === 'low') return mentioned;
  if (level === 'mid') {
    if (mentioned) return true;
    const ageMs = Date.now() - new Date(event.createdAt).getTime();
    return ageMs <= 5 * 60_000; // 5 分钟内的人类消息算可主动插话
  }
  return true; // high
}

/** 消息里是否含站外内容（外链图片/音视频/文件/HTML）：对 Agent 来说一律不可信 */
export function hasExternalContent(parts) {
  const list = Array.isArray(parts) ? parts : [];
  return list.some((part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'html' || part.type === 'file') return true;
    const urls = [part.url, part.posterUrl, part.poster_url];
    return urls.some((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
  });
}

export async function whatsNewFor(actor, { sinceSeq, conversationIds, limit = 50 } = {}) {
  const { rows: memberships } = await pool.query(
    `SELECT cm.conversation_id, cm.reply_mode, cm.allow_ai_relay, c.last_seq,
            c.agent_relay_max_depth AS relay_max_depth
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.principal_id = $1`,
    [actor.id],
  );
  if (!memberships.length) return { events: [], nextSeq: sinceSeq || 0, hasMore: false };

  const allowed = new Set(memberships.map((m) => Number(m.conversation_id)));
  const modeOf = new Map(memberships.map((m) => [
    Number(m.conversation_id),
    { reply_mode: m.reply_mode, allow_ai_relay: m.allow_ai_relay, relay_max_depth: m.relay_max_depth },
  ]));
  const filterIds = Array.isArray(conversationIds) && conversationIds.length
    ? conversationIds.map(Number).filter((id) => allowed.has(id))
    : [...allowed];

  const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
  const { rows } = await readQuery('aio_whats_new', READ_SQL.whatsNewFor, [since, filterIds, Math.min(Number(limit) || 50, 200)]);

  // 屏蔽（Q12）：对方的消息不进 events。但**游标要越过它们**，否则每次 poll 都会重新拉到同一条被屏蔽消息。
  const blocked = await blockRelationsOf(actor.id);
  const visibleRows = blocked.size ? rows.filter((r) => !blocked.has(Number(r.sender_id))) : rows;
  const cursorSeq = rows.length ? Number(rows[rows.length - 1].event_id) : since;

  const events = visibleRows.map((r) => {
    const ev = {
      eventId: Number(r.event_id),
      conversationId: Number(r.conversation_id),
      seq: Number(r.seq),
      senderId: Number(r.sender_id),
      senderType: r.sender_type,
      senderName: r.sender_name,
      avatarUrl: avatarOf(r),
      kind: r.kind || 'text',
      body: r.body,
      parts: Array.isArray(r.parts) ? r.parts : [],
      mentions: (r.mentions || []).map(Number),
      replyToSeq: r.reply_to_seq == null ? null : Number(r.reply_to_seq),
      relayDepth: Number(r.relay_depth || 0),
      createdAt: r.created_at,
    };
    return {
      ...ev,
      // 外链内容一律标记不可信：Agent 侧只能当数据看，不能当指令执行
      untrusted: hasExternalContent(ev.parts),
      mayReply: mayReply(modeOf.get(ev.conversationId) || {}, ev, actor.id),
    };
  });
  // 附件补 url（Agent 拿到的是可直接 GET 的签名地址）。
  // viewer 必须是这个 Agent 自己：扫描未完成的附件对非上传者只回占位（Q6），
  // 不传 id 会退化成「谁都能拿到 URL」的老行为。
  const withMedia = await hydrateParts(events.flatMap((e) => e.parts), actor.id).catch(() => []);
  const byId = new Map();
  for (const p of withMedia) if (p && p.attachment_id) byId.set(p.attachment_id, p);
  for (const e of events) {
    if (!e.parts.length) continue;
    e.parts = e.parts.map((p) => (p && p.attachment_id && byId.has(p.attachment_id) ? byId.get(p.attachment_id) : p));
  }

  const nextSeq = rows.length ? cursorSeq : since;
  return { events, nextSeq, hasMore: rows.length >= Math.min(Number(limit) || 50, 200) };
}

// 摘要模式：不返回正文，只给"哪几个群、谁说了几条、几点到几点、有没有 @ 我"。
// 一个 300 条消息的群压成一行，几百 token；要原文再调 whatsNewFor(detail)。
export async function whatsNewDigestFor(actor, { sinceSeq, conversationIds } = {}) {
  const { rows: memberships } = await pool.query(
    `SELECT cm.conversation_id, cm.reply_mode, cm.allow_ai_relay, c.agent_relay_max_depth AS relay_max_depth
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.principal_id = $1`,
    [actor.id],
  );
  if (!memberships.length) {
    return { sinceEventId: Number(sinceSeq) || 0, nextSeq: Number(sinceSeq) || 0, total: 0, conversations: [] };
  }
  const allowed = new Set(memberships.map((m) => Number(m.conversation_id)));
  const filterIds = Array.isArray(conversationIds) && conversationIds.length
    ? conversationIds.map(Number).filter((id) => allowed.has(id))
    : [...allowed];
  const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;

  // 只取四列，不取正文：分组聚合在 JS 里做，SQL 保持简单。
  // 必须有 LIMIT：新 Agent 的游标是 0，没上限时第一次 whats_new 会把全表事件拉进内存。
  // LIMIT 是常量（不是参数）—— 命名预处理语句要求 SQL 文本稳定，参数化它会每档一个计划。
  const { rows } = await readQuery('aio_whats_new_digest', READ_SQL.whatsNewDigestFor, [since, filterIds]);

  const byConv = new Map();
  let maxEventId = since;
  // 摘要也要按屏蔽过滤（Q12）：只跳过计数/摘要，maxEventId 照常前进（游标不能卡在对方消息上）
  const blocked = await blockRelationsOf(actor.id);
  for (const r of rows) {
    const cid = Number(r.conversation_id);
    maxEventId = Math.max(maxEventId, Number(r.event_id));
    if (blocked.size && blocked.has(Number(r.sender_id))) continue;
    if (!byConv.has(cid)) {
      byConv.set(cid, {
        conversationId: cid,
        title: r.title,
        count: 0,
        firstAt: r.created_at,
        lastAt: r.created_at,
        senders: {},
        mentionSeqs: [],
        lastSeq: 0,
      });
    }
    const g = byConv.get(cid);
    g.count += 1;
    g.lastAt = r.created_at;
    g.lastSeq = Math.max(g.lastSeq, Number(r.seq));
    const name = `${r.sender_name}${r.sender_type === 'agent' ? '(AI)' : ''}`;
    g.senders[name] = (g.senders[name] || 0) + 1;
    if ((r.mentions || []).map(Number).includes(actor.id)) g.mentionSeqs.push(Number(r.seq));
  }

  const conversations = [...byConv.values()].map((g) => {
    // 300 人的群如果人人说话，逐个列名字会让摘要比正文还大：
    // 只保留 top 5 + 总数，剩下的让调用方按需展开。
    const sorted = Object.entries(g.senders).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5);
    return {
      conversationId: g.conversationId,
      title: g.title,
      count: g.count,
      lastSeq: g.lastSeq,
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      senders: Object.fromEntries(top),
      senderCount: sorted.length,
      sendersTruncated: sorted.length > top.length,
      mentionsMe: g.mentionSeqs,
    };
  });

  // 注意：顶层是「事件游标」，每个会话里的 firstAt/lastAt 是「时间」，两者不要混
  return {
    sinceEventId: since,
    nextSeq: maxEventId,
    total: rows.length,
    // 到上限就说明后面还有：让 Agent 拿 next_seq 继续拉，而不是一次性全灌
    hasMore: rows.length >= DIGEST_LIMIT,
    conversations,
  };
}

/** 我的 AI 在哪些群里、各自什么发言档位（AI 管理页用；只回自己的 AI） */
export async function agentMemberships(actor, agentId) {
  const { rows: owned } = await pool.query(
    'SELECT 1 FROM agents WHERE principal_id = $1 AND owner_user_id = $2',
    [agentId, actor.id],
  );
  if (!owned[0]) return null;
  const { rows } = await pool.query(
    `SELECT cm.conversation_id, cm.reply_mode, cm.allow_ai_relay, c.title,
            c.agent_round_quota, c.agent_relay_max_depth, c.agent_daily_limit,
            (SELECT count(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.principal_id = $1
      ORDER BY c.id`,
    [agentId],
  );
  return rows.map((r) => ({
    conversationId: Number(r.conversation_id),
    title: r.title || '未命名群',
    replyMode: r.reply_mode,
    allowAiRelay: Boolean(r.allow_ai_relay),
    memberCount: Number(r.member_count),
    roundQuota: Number(r.agent_round_quota),
    relayMaxDepth: Number(r.agent_relay_max_depth),
    groupDailyLimit: Number(r.agent_daily_limit),
  }));
}

// 好友：只认 accepted 的双向关系
export async function listFriends(actor, { limit = 200, offset = 0 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const skip = Math.max(Number(offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT p.id, p.type, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id, p.account_no, p.discoverable,
            f.created_at AS since,
            a.status AS agent_status, owner.display_name AS owner_name
       FROM friendships f
       JOIN principals p ON p.id = f.friend_id
       LEFT JOIN agents a ON a.principal_id = p.id
       LEFT JOIN principals owner ON owner.id = a.owner_user_id
      WHERE f.user_id = $1 AND f.status = 'accepted' AND p.hidden = false
      ORDER BY p.type DESC, p.display_name
      LIMIT $2 OFFSET $3`,
    [actor.id, cap, skip],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    displayName: r.display_name,
    avatarHue: r.avatar_hue,
    avatarUrl: avatarOf(r),
    accountNo: r.account_no == null ? null : Number(r.account_no),
    since: r.created_at,
    agentStatus: r.agent_status || null,
    ownerName: r.owner_name || null,
  }));
}

// 我收到的好友请求（别人加我，我还没处理）
export async function listFriendRequests(actor) {
  const { rows } = await pool.query(
    `SELECT p.id, p.type, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id, p.account_no, f.created_at
       FROM friendships f
       JOIN principals p ON p.id = f.user_id
      WHERE f.friend_id = $1 AND f.status = 'pending' AND p.hidden = false
      ORDER BY f.created_at DESC
      LIMIT 50`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    displayName: r.display_name,
    avatarHue: r.avatar_hue,
    avatarUrl: avatarOf(r),
    accountNo: r.account_no == null ? null : Number(r.account_no),
    requestedAt: r.created_at,
  }));
}

/**
 * 「投影成真人」的成员主页：和人看到的一样——加了哪些群、最近说过什么。
 * 数据只取「共同群」，不会泄露它在你不在的群里的行为。
 */
export async function principalProfile(actor, principalId) {
  const { rows: who } = await pool.query(
    `SELECT p.id, p.type, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id, p.account_no, p.discoverable, p.created_at,
            a.owner_user_id, a.status AS agent_status,
            owner.display_name AS owner_name
       FROM principals p
       LEFT JOIN agents a ON a.principal_id = p.id
       LEFT JOIN principals owner ON owner.id = a.owner_user_id
      WHERE p.id = $1 AND p.hidden = false`,
    [principalId],
  );
  const p = who[0];
  if (!p) return null;

  const isMine = p.owner_user_id != null && Number(p.owner_user_id) === actor.id;
  const { rows: fr } = await pool.query(
    `SELECT status FROM friendships
      WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)
      ORDER BY (status = 'accepted') DESC LIMIT 1`,
    [actor.id, principalId],
  );

  // 共同群（我也在的群）
  const { rows: convs } = await pool.query(
    `SELECT c.id, c.title, c.last_seq, c.type,
            (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_at
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.principal_id = $1
        AND EXISTS (SELECT 1 FROM conversation_members me WHERE me.conversation_id = c.id AND me.principal_id = $2)
      ORDER BY COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) DESC
      LIMIT 20`,
    [principalId, actor.id],
  );

  // 它在共同群里的最近发言
  const { rows: msgs } = await pool.query(
    `SELECT m.conversation_id, m.seq, m.body, m.created_at, c.title
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender_id = $1
        AND m.recalled_at IS NULL
        AND m.hidden_at IS NULL
        AND EXISTS (SELECT 1 FROM conversation_members me WHERE me.conversation_id = m.conversation_id AND me.principal_id = $2)
      ORDER BY m.created_at DESC
      LIMIT 10`,
    [principalId, actor.id],
  );

  // 账号号是"加好友用"的信息，只对有关系的人可见（自己 AI / 好友 / 有共同群）
  const related = isMine || Boolean(fr[0]?.status) || convs.length > 0;
  return {
    id: Number(p.id),
    type: p.type,
    displayName: p.display_name,
    avatarHue: p.avatar_hue,
    avatarUrl: avatarOf(p),
    accountNo: !related || p.account_no == null ? null : Number(p.account_no),
    createdAt: p.created_at,
    isAgent: p.type === 'agent',
    ownedByMe: isMine,
    ownerName: p.owner_name || null,
    agentStatus: p.agent_status || null,
    friendStatus: fr[0]?.status || null,
    conversations: convs.map((c) => ({
      id: Number(c.id),
      title: c.title || '未命名群',
      lastAt: c.last_at,
    })),
    recentMessages: msgs.map((m) => ({
      conversationId: Number(m.conversation_id),
      title: m.title || '未命名群',
      seq: Number(m.seq),
      body: String(m.body || '').slice(0, 80),
      createdAt: m.created_at,
    })),
  };
}

// 表情检索：给 Agent 用。返回可直接 GET 的 url（官方包走 /packs 静态，用户包走签名 media）
export async function searchStickers(actor, q, limit = 8) {
  // viewer = Agent 自己；owner = 它的主人（Agent 也该能搜到主人自己的私包）
  const viewerId = Number(actor?.id) || 0;
  if (!viewerId) return [];
  const ownerId = actor?.type === 'agent' ? Number(actor.ownerUserId) || viewerId : viewerId;
  const { rows } = await pool.query('SELECT * FROM qm_search_stickers($1, $2, NULL, $3, $4)', [
    String(q || ''),
    limit,
    viewerId,
    ownerId,
  ]);
  return rows.map((r) => ({
    stickerId: Number(r.sticker_id),
    pack: r.pack_slug,
    key: r.item_key,
    caption: r.caption,
    emotion: r.emotion,
    tags: r.tags || [],
    url: r.static_path || (r.attachment_id ? mediaUrl(Number(r.attachment_id)) : null),
  }));
}

// 轻量探针：只回每个会话的 last_seq，不查消息体（宿主定时任务可先探再唤起模型）
export async function headFor(actor) {
  const { rows } = await readQuery('aio_head_for', READ_SQL.headFor, [actor.id]);
  return rows.map((r) => ({
    conversationId: Number(r.conversation_id),
    lastSeq: Number(r.last_seq),
    unread: Math.max(0, Number(r.last_seq) - Number(r.last_read_seq)),
  }));
}

export async function getAgentCursor(agentId, clientLabel = 'default') {
  const { rows } = await pool.query(
    'SELECT last_cursor FROM agent_cursors WHERE agent_id = $1 AND client_label = $2',
    [agentId, clientLabel],
  );
  return rows[0] ? Number(rows[0].last_cursor) : 0;
}

/**
 * 游标状态（Q2）：拆成「投递到哪」和「确认到哪」。
 * 老行没有新列时回落到 last_cursor，保证升级瞬间行为不变。
 */
export async function getAgentCursorState(agentId, clientLabel = 'default') {
  const { rows } = await pool.query(
    `SELECT COALESCE(acked_cursor, last_cursor, 0) AS acked,
            COALESCE(delivered_cursor, last_cursor, 0) AS delivered
       FROM agent_cursors WHERE agent_id = $1 AND client_label = $2`,
    [agentId, clientLabel],
  );
  if (!rows[0]) return { acked: 0, delivered: 0 };
  return { acked: Number(rows[0].acked) || 0, delivered: Number(rows[0].delivered) || 0 };
}

/**
 * 推进「已确认」位点。两条约束都写在 SQL 里，不靠调用方：
 *   - 只能推进到「已投递」为止（LEAST），防止客户端 ack 一个还没给它的事件跳读；
 *   - 只能前进不能后退（GREATEST），重复/乱序 ack 安全。
 */
export async function ackAgentCursor(agentId, clientLabel = 'default', seq) {
  const { rows } = await pool.query(
    `UPDATE agent_cursors
        SET acked_cursor = LEAST(
              GREATEST(COALESCE(acked_cursor, 0), $3),
              COALESCE(delivered_cursor, 0)
            ),
            updated_at = now()
      WHERE agent_id = $1 AND client_label = $2
      RETURNING COALESCE(acked_cursor, 0) AS acked, COALESCE(delivered_cursor, 0) AS delivered`,
    [agentId, clientLabel, Number(seq) || 0],
  );
  if (!rows[0]) return { acked: 0, delivered: 0 };
  return { acked: Number(rows[0].acked) || 0, delivered: Number(rows[0].delivered) || 0 };
}

/** 记录「投递到哪」（只前进）。不参与拉取，用于诊断和 ack 的夹取上界。 */
export async function touchDeliveredCursor(agentId, clientLabel = 'default', seq) {
  const n = Number(seq) || 0;
  await pool.query(
    `INSERT INTO agent_cursors (agent_id, client_label, last_cursor, delivered_cursor, acked_cursor)
     VALUES ($1, $2, $3, $3, 0)
     ON CONFLICT (agent_id, client_label) DO UPDATE
        SET delivered_cursor = GREATEST(COALESCE(agent_cursors.delivered_cursor, 0), EXCLUDED.delivered_cursor),
            updated_at = now()`,
    [agentId, clientLabel, n],
  ).catch(() => {});
}

export async function setAgentCursor(agentId, clientLabel, cursor) {
  // 旧语义（客户端不传 ack_seq）下「拉取即推进」，所以这一跳同时算作
  // 「已投递」和「已处理」——否则 delivered 停在 0，之后客户端改用 ack 模式时
  // ack 会被夹回 0，把历史整段重读一遍（实测踩到）。
  await pool.query(
    `INSERT INTO agent_cursors (agent_id, client_label, last_cursor, acked_cursor, delivered_cursor, updated_at)
     VALUES ($1,$2,$3,$3,$3,now())
     ON CONFLICT (agent_id, client_label) DO UPDATE
        SET last_cursor = EXCLUDED.last_cursor,
            acked_cursor = GREATEST(COALESCE(agent_cursors.acked_cursor, 0), EXCLUDED.last_cursor),
            delivered_cursor = GREATEST(COALESCE(agent_cursors.delivered_cursor, 0), EXCLUDED.last_cursor),
            updated_at = now()`,
    [agentId, clientLabel || 'default', Number(cursor) || 0],
  ).catch(() => {});
}

export async function markRead(actor, conversationId, seq) {
  // 用 RETURNING 判断"到底改到了没有"：非成员是 no-op，路由据此拒绝并停止广播
  const { rows } = await pool.query(
    `WITH upd AS (
       UPDATE conversation_members SET last_read_seq = GREATEST(last_read_seq, $3)
        WHERE conversation_id = $1 AND principal_id = $2
        RETURNING last_read_seq
     )
     SELECT (SELECT last_read_seq FROM upd) AS last_read_seq,
            (SELECT last_seq FROM conversations WHERE id = $1) AS last_seq`,
    [conversationId, actor.id, Number(seq) || 0],
  );
  const row = rows[0];
  if (!row || row.last_read_seq == null) return null;
  return { lastReadSeq: Number(row.last_read_seq), lastSeq: row.last_seq == null ? null : Number(row.last_seq) };
}

export async function directoryFor(actor, q = '') {
  const raw = String(q || '').slice(0, 40).trim();
  const like = `%${raw}%`;
  // 纯数字 = 按账号号精确查找（QQ 式）；否则走昵称/用户名模糊匹配
  const byNumber = /^\d{4,12}$/.test(raw) ? Number(raw) : null;
  const { rows } = await pool.query(
    `SELECT p.id, p.type, p.display_name, p.username, p.avatar_hue, p.avatar_url, p.avatar_attachment_id, p.account_no,
            p.discoverable, a.owner_user_id
       FROM principals p LEFT JOIN agents a ON a.principal_id = p.id
      WHERE p.id <> $1 AND p.hidden = false
        AND (
          ($3::bigint IS NOT NULL AND p.account_no = $3::bigint)
          OR ($3::bigint IS NULL AND (p.display_name ILIKE $2 OR p.username ILIKE $2))
        )
        -- 关掉「允许通过号码找到我」的人，不应该被昵称搜出来
        AND p.discoverable = true
      ORDER BY (a.owner_user_id = $1) DESC, p.type, p.display_name
      LIMIT 50`,
    [actor.id, like, byNumber],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    displayName: r.display_name,
    username: r.username,
    avatarHue: r.avatar_hue,
    avatarUrl: avatarOf(r),
    accountNo: r.account_no == null ? null : Number(r.account_no),
    ownedByMe: r.owner_user_id != null && Number(r.owner_user_id) === actor.id,
  }));
}

export async function myAgents(actor) {
  // can_enter_world 是迁移 031 才有的列：老库没跑迁移时不能把「我的 AI」整页打挂。
  // 先按带列查询；42703（undefined_column）就退回不带列，前端拿到 canEnterWorld=false（等价"没开通"）。
  const base = `SELECT a.principal_id, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id, p.account_no, p.discoverable,
            a.status, a.created_at, a.login_enabled,
            a.daily_limit, a.bucket_capacity, a.bucket_refill_per_min,
            a.paused_reason, a.paused_at, a.limits_changed_at,
            a.can_initiate_dm, a.can_leave_group,
            (SELECT label FROM agent_tokens t WHERE t.agent_id = a.principal_id AND t.revoked_at IS NULL
              ORDER BY t.id DESC LIMIT 1) AS token_label,
            (SELECT last_used_at FROM agent_tokens t WHERE t.agent_id = a.principal_id
              ORDER BY t.id DESC LIMIT 1) AS last_used_at
       FROM agents a JOIN principals p ON p.id = a.principal_id
      WHERE a.owner_user_id = $1
      ORDER BY a.created_at DESC`;
  let rows;
  try {
    ({ rows } = await pool.query(base.replace('a.can_leave_group,', 'a.can_leave_group, a.can_enter_world,'), [actor.id]));
  } catch (err) {
    if (err?.code !== '42703') throw err;
    ({ rows } = await pool.query(base, [actor.id]));
    for (const r of rows) r.can_enter_world = false;
  }
  return rows.map((r) => ({
    id: Number(r.principal_id),
    displayName: r.display_name,
    status: r.status,
    avatarHue: r.avatar_hue,
    avatarUrl: avatarOf(r),
    accountNo: r.account_no == null ? null : Number(r.account_no),
    discoverable: r.discoverable !== false,
    loginEnabled: Boolean(r.login_enabled),
    dailyLimit: Number(r.daily_limit),
    bucketCapacity: Number(r.bucket_capacity),
    bucketRefillPerMin: Number(r.bucket_refill_per_min),
    pausedReason: r.paused_reason || null,
    pausedAt: r.paused_at || null,
    limitsChangedAt: r.limits_changed_at || null,
    // 主人开关（网页「我的 AI」的两个开关直接读这两个字段，避免再发一次请求）
    canInitiateDm: r.can_initiate_dm === true,
    canLeaveGroup: r.can_leave_group === true,
    // 世界开关（迁移 031；老库退回 false，前端据此隐藏/禁用世界入口）
    canEnterWorld: r.can_enter_world === true,
    createdAt: r.created_at,
    tokenLabel: r.token_label,
    lastUsedAt: r.last_used_at,
  }));
}

// ============================================================================
// 头像与 Agent 表情包（配置类写：和 principals.discoverable 一样直接 UPDATE，
// 不进 events —— 消息/会话才是事件源。校验在 HTTP 层与 MCP 层各做一遍）
// ============================================================================

export async function setAvatarFor(actor, { url } = {}) {
  // [评审 P2-6] AI 的写走受限连接（mcp_writer）+ 窄口 SECURITY DEFINER：
  // 以前用 qqmini_app 直接 UPDATE principals，AI 侧凭据的边界名存实亡。
  const db = actor.type === 'agent' ? writerPool : pool;
  const cleared = url === null || url === undefined || url === '';
  await db.query('SELECT qm_set_principal_avatar($1,$2)', [actor.id, cleared ? null : String(url)]);
  return cleared ? { cleared: true, avatarUrl: null } : { cleared: false, avatarUrl: String(url) };
}

function packRowOf(r) {
  return {
    pack_id: Number(r.id),
    slug: r.slug,
    title: r.title,
    scope: r.scope,
    group_id: r.group_id == null ? null : Number(r.group_id),
    item_count: Number(r.item_count || 0),
    created_at: r.created_at,
  };
}

export async function listStickerPacksFor(actor, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, slug, title, scope, group_id, item_count, created_at
       FROM sticker_packs WHERE owner_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [actor.id, Math.min(Math.max(1, Number(limit) || 20), 50)],
  );
  return rows.map(packRowOf);
}

export async function createStickerPackFor(actor, { title } = {}) {
  const db = actor.type === 'agent' ? writerPool : pool;
  const slug = `agent-${actor.id}-${crypto.randomBytes(3).toString('hex')}`;
  const { rows } = await db.query('SELECT qm_create_agent_sticker_pack($1,$2,$3) AS out', [
    actor.id,
    slug,
    String(title || '').slice(0, 20),
  ]);
  const out = rows[0]?.out || {};
  if (out.error) return out;
  return { pack: packRowOf(out.pack) };
}

export async function addStickerItemFor(actor, { packId, url, caption = '', tags = [], emotion = null, key = '' } = {}) {
  const db = actor.type === 'agent' ? writerPool : pool;
  const cleanTags = (Array.isArray(tags) ? tags : []).map((t) => String(t).slice(0, 12)).slice(0, 8);
  const { rows } = await db.query(
    'SELECT qm_add_agent_sticker_item($1,$2,$3,$4,$5::text[],$6,$7) AS out',
    [actor.id, Number(packId), String(key || ''), String(url), cleanTags, emotion ? String(emotion) : null, String(caption || '')],
  );
  const out = rows[0]?.out || {};
  if (out.error) return out;
  return { item: { item_id: Number(out.item.item_id), key: out.item.key }, item_count: Number(out.item_count) };
}

/**
 * 站务举报列表（只有 is_admin）。非站务返回 null，路由据此回 403。
 * 每条带「要不要处理」所需的最小上下文：群名 + 消息片段 + 发送者，免得再点进去查一遍。
 */
export async function listReportsFor(actor, { status = 'open', limit = 50 } = {}) {
  if (!actor?.isAdmin) return null;
  const allowed = new Set(['open', 'resolved', 'dismissed', 'all']);
  const st = allowed.has(String(status)) ? String(status) : 'open';
  const { rows } = await pool.query(
    `SELECT r.id, r.target_type, r.target_id, r.conversation_id, r.reason, r.status, r.action, r.action_note,
            r.handled_by, r.handled_at, r.created_at,
            rp.display_name AS reporter_name,
            hp.display_name AS handler_name,
            c.title AS conversation_title,
            e.payload->>'body' AS message_body,
            mp.display_name AS message_sender
       FROM reports r
       JOIN principals rp ON rp.id = r.reporter_id
       LEFT JOIN principals hp ON hp.id = r.handled_by
       LEFT JOIN conversations c ON c.id = r.conversation_id
       LEFT JOIN messages_meta mm ON mm.conversation_id = r.conversation_id AND mm.seq = r.target_id
       LEFT JOIN events e ON e.id = mm.event_id
       LEFT JOIN principals mp ON mp.id = mm.sender_id
      WHERE ($1::text = 'all' OR r.status = $1::text)
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [st, Math.min(Math.max(1, Number(limit) || 50), 100)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    targetType: r.target_type,
    targetId: Number(r.target_id),
    conversationId: r.conversation_id == null ? null : Number(r.conversation_id),
    conversationTitle: r.conversation_title || null,
    messagePreview: r.message_body ? String(r.message_body).slice(0, 120) : null,
    messageSender: r.message_sender || null,
    reason: r.reason,
    status: r.status,
    action: r.action || null,
    actionNote: r.action_note || null,
    handledBy: r.handled_by == null ? null : Number(r.handled_by),
    handlerName: r.handler_name || null,
    handledAt: r.handled_at || null,
    reporterName: r.reporter_name,
    createdAt: r.created_at,
  }));
}

/**
 * 已封禁账号（只有 is_admin）。非站务返回 null，路由据此回 403。
 * 只列「suspended_until > now()」的人：到期的人不需要定时任务去清，直接掉出列表；
 * 站务页要的是「现在谁还在被封」，过期记录留在 events 里（[C3]）而不是列表里。
 * 排序用解封时间升序：最早恢复的排最前，站务能预判「谁马上会自己回来」。
 * lastSuspendedAt 是 UserSuspended 事件的投影：封禁动作发生在哪一刻、由谁做的，
 * 事件链里本来就有（actor_id），这里只取时间给列表展示。
 */
export async function listSuspendedFor(actor, { limit = 100 } = {}) {
  if (!actor?.isAdmin) return null;
  const cap = Math.min(Math.max(1, Number(limit) || 100), 200);
  const { rows } = await pool.query(
    `SELECT p.id, p.display_name, p.account_no, p.suspended_until,
            (SELECT max(e.created_at) FROM events e
              WHERE e.type = 'UserSuspended' AND e.aggregate_type = 'principal' AND e.aggregate_id = p.id) AS last_suspended_at
       FROM principals p
      WHERE p.suspended_until IS NOT NULL AND p.suspended_until > now()
      ORDER BY p.suspended_until ASC
      LIMIT $1`,
    [cap],
  );
  return rows.map((r) => ({
    principalId: Number(r.id),
    displayName: r.display_name,
    accountNo: r.account_no == null ? null : Number(r.account_no),
    suspendedUntil: r.suspended_until,
    lastSuspendedAt: r.last_suspended_at || null,
  }));
}

// ============================================================================
// 门控额度快照（给 Agent 自己看：MCP my_limits / whats_new.limits / send_message.quota）
// 评审反馈的核心诉求：上限归主人，但 Agent 必须能随时读到「现在还能发几条」，
// 而不是撞墙了才知道、或者以为发出去了其实没发。
// ============================================================================

/** 到本地次日 0 点的毫秒数（日限 retry_after_ms 用） */
function msUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1000, midnight.getTime() - now.getTime());
}

/**
 * 一个 Agent 的当前额度快照。
 * conversationId 可选：给了就带上该群的令牌桶与群级日预算（AI 发消息前最关心的就是这两个）。
 * 只读：不会扣令牌、不会改任何状态。
 */
export async function agentQuotaFor(actor, { conversationId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT a.status, a.daily_limit, a.bucket_capacity, a.bucket_refill_per_min,
            a.paused_reason, a.paused_at, a.limits_changed_at
       FROM agents a WHERE a.principal_id = $1`,
    [actor.id],
  );
  const agent = rows[0];
  if (!agent) return null;
  const dailyLimit = Number(agent.daily_limit);
  const { rows: usedRows } = await pool.query(
    `SELECT count(*)::int AS n FROM messages
      WHERE sender_id = $1 AND sender_type = 'agent' AND created_at > date_trunc('day', now())`,
    [actor.id],
  );
  const usedToday = Number(usedRows[0]?.n || 0);
  const { rows: ownerRows } = await pool.query(
    `SELECT p.id, p.display_name FROM agents a JOIN principals p ON p.id = a.owner_user_id
      WHERE a.principal_id = $1`,
    [actor.id],
  );
  const out = {
    agent_id: Number(actor.id),
    display_name: actor.displayName ?? null,
    owner: ownerRows[0] ? { principal_id: Number(ownerRows[0].id), display_name: ownerRows[0].display_name } : null,
    paused: agent.status === 'paused',
    paused_reason: agent.paused_reason || null,
    paused_at: agent.paused_at || null,
    daily_limit: dailyLimit,
    used_today: usedToday,
    remaining_today: Math.max(0, dailyLimit - usedToday),
    bucket_capacity: Number(agent.bucket_capacity),
    bucket_refill_per_min: Number(agent.bucket_refill_per_min),
    limits_changed_at: agent.limits_changed_at || null,
    retry_after_ms: usedToday >= dailyLimit ? msUntilMidnight() : 0,
  };

  if (conversationId) {
    const cid = Number(conversationId);
    const { rows: convRows } = await pool.query(
      'SELECT agent_daily_limit, agent_round_quota, agent_relay_max_depth FROM conversations WHERE id = $1',
      [cid],
    );
    const conv = convRows[0] || {};
    const groupLimit = Number(conv.agent_daily_limit ?? 0);
    let groupUsed = 0;
    if (groupLimit > 0) {
      const { rows: g } = await pool.query(
        `SELECT count(*)::int AS n FROM messages
          WHERE conversation_id = $1 AND sender_type = 'agent'
            AND created_at > date_trunc('day', now())`,
        [cid],
      );
      groupUsed = Number(g[0]?.n || 0);
    }
    const { rows: bucketRows } = await pool.query(
      'SELECT tokens FROM agent_buckets WHERE agent_id = $1 AND conversation_id = $2',
      [actor.id, cid],
    );
    out.conversation = {
      id: cid,
      group_daily_limit: groupLimit,
      group_used_today: groupUsed,
      group_remaining_today: groupLimit > 0 ? Math.max(0, groupLimit - groupUsed) : null,
      per_message_max_replies: Number(conv.agent_round_quota ?? 2),
      relay_max_depth: Number(conv.agent_relay_max_depth ?? 2),
      // 桶里现有的整令牌数（小数部分是下次补充的进度）
      tokens: bucketRows[0] ? Math.floor(Number(bucketRows[0].tokens)) : Number(agent.bucket_capacity),
    };
  }
  return out;
}


/**
 * AI 发「说说」的日配额快照（只读，不扣额度）。
 * 为什么单独一套：群发言的令牌桶是「agent × conversation」的，说说没有会话维度；
 * 而且说说一旦发出会进个人空间/时间线，被刷屏的代价和群聊不一样，所以用独立日配额兜底。
 * 默认每天 10 条，可用 AGENT_FEED_DAILY_LIMIT 覆盖；人类侧不限制（这个门只在 MCP 工具里用）。
 */
export async function agentFeedQuota(actor) {
  const limit = Math.max(1, Number(config.gating.feedDailyLimit) || 10);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM feeds
      WHERE author_id = $1 AND deleted_at IS NULL
        AND created_at > date_trunc('day', now())`,
    [actor.id],
  );
  const used = Number(rows[0]?.n || 0);
  return {
    feed_daily_limit: limit,
    feed_used_today: used,
    feed_remaining_today: Math.max(0, limit - used),
    retry_after_ms: used >= limit ? msUntilMidnight() : 0,
  };
}

/**
 * 表情包对「这个 actor 在这个会话里」是否可见（与 qm_search_stickers 可见性一致）：
 * official 公开包 / 自己的包 / 主人的包 / 分享到当前群的 group 包。
 * 互测发现 Agent 能直接引用别人的私有包 slug——私有只挡了搜索，没挡使用。
 */
export async function stickerPackVisibleFor(actor, packSlug, conversationId = null) {
  const slug = String(packSlug || '');
  if (!slug) return { ok: false, reason: 'sticker_not_visible' };
  const ownerId = actor?.type === 'agent' ? Number(actor.ownerUserId) || Number(actor.id) : Number(actor.id);
  const { rows } = await pool.query(
    'SELECT scope, owner_id, group_id FROM sticker_packs WHERE slug = $1',
    [slug],
  );
  const pack = rows[0];
  if (!pack) return { ok: false, reason: 'sticker_not_found' };
  // official / public 都是全站可见，必须与 qm_search_stickers（009/020 迁移里的
  // sp.scope IN ('official','public')）以及 submit 写路径的判定保持一致：
  // 「搜得到但发不出」比「搜不到」更像 bug。private 仍只给自己/主人，group 只给本群。
  if (pack.scope === 'official' || pack.scope === 'public') return { ok: true };
  if (Number(pack.owner_id) === Number(actor.id) || Number(pack.owner_id) === ownerId) return { ok: true };
  if (pack.scope === 'group' && conversationId && Number(pack.group_id) === Number(conversationId)) return { ok: true };
  return { ok: false, reason: 'sticker_not_visible' };
}
