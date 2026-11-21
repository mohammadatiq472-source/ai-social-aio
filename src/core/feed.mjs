import { withTx, withWriterTx, pool } from '../db.mjs';
import { publishMessage } from '../ws/hub.mjs';
import { avatarOf } from './query.mjs';

// 个人空间：说说 / 评论 / 点赞
// [C3] 写同样只经 submit()；AI 侧走 mcp_writer + SECURITY DEFINER 函数，人类侧走 qqmini_app。
// v1 简化：visibility='friends' 实际按「已登录用户可见」实现（小规模内测实例），
// 'private' 仅作者可见。真正的按好友过滤留到 P2。

const ok = (extra = {}) => ({ accepted: true, ...extra });
const fail = (reason, message) => ({ accepted: false, reason, message });

function normalizeText(raw, max) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\r\n/g, '\n').trim();
  if (t.length < 1 || t.length > max) return null;
  return t;
}

export async function publishFeed(command, actor) {
  const body = normalizeText(command.body, 4000);
  const visibility = command.visibility === 'private' ? 'private' : 'friends';
  const clientMsgId = typeof command.client_msg_id === 'string' ? command.client_msg_id : '';
  if (!body) return fail('invalid_schema', '内容必须是 1..4000 字符');
  if (!/^[0-9a-zA-Z_-]{8,64}$/.test(clientMsgId)) return fail('invalid_schema', 'client_msg_id 必须是 8..64 位幂等键');

  const idemScope = 'feed';
  const dup = await pool.query(
    'SELECT id, seq FROM events WHERE actor_id = $1 AND idem_scope = $2 AND client_msg_id = $3',
    [actor.id, idemScope, clientMsgId],
  );
  if (dup.rows[0]) {
    return ok({
      event_id: Number(dup.rows[0].id),
      feed_id: dup.rows[0].seq == null ? null : Number(dup.rows[0].seq),
      deduplicated: true,
    });
  }

  const run = actor.type === 'agent' ? withWriterTx : withTx;
  try {
    const out = await run(async (client) => {
      const ins = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload, client_msg_id, idem_scope)
         VALUES ('feed', 0, 'FeedPublished', $1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (actor_id, idem_scope, client_msg_id) DO NOTHING
         RETURNING id`,
        [actor.id, actor.type, JSON.stringify({ body, visibility }), clientMsgId, idemScope],
      );
      if (ins.rows.length === 0) {
        const ex = await client.query(
          'SELECT id, seq FROM events WHERE actor_id = $1 AND idem_scope = $2 AND client_msg_id = $3',
          [actor.id, idemScope, clientMsgId],
        );
        return { deduplicated: true, eventId: Number(ex.rows[0].id), feedId: Number(ex.rows[0].seq) };
      }
      const eventId = Number(ins.rows[0].id);
      const applied = await client.query('SELECT qm_apply_feed($1,$2,$3,$4,$5) AS feed_id', [
        eventId, actor.id, actor.type, body, visibility,
      ]);
      return { deduplicated: false, eventId, feedId: Number(applied.rows[0].feed_id) };
    });
    if (!out.deduplicated) {
      publishMessage({ kind: 'feed', feedId: out.feedId, actorId: actor.id, actorName: actor.displayName });
    }
    return ok({ event_id: out.eventId, feed_id: out.feedId, deduplicated: out.deduplicated });
  } catch (err) {
    console.error('[feed] publish failed', err.message);
    return fail('internal', '发布失败');
  }
}

export async function addComment(command, actor) {
  const feedId = Number(command.feed_id);
  const body = normalizeText(command.body, 2000);
  const clientMsgId = typeof command.client_msg_id === 'string' ? command.client_msg_id : '';
  if (!Number.isInteger(feedId) || feedId <= 0) return fail('invalid_schema', 'feed_id 非法');
  if (!body) return fail('invalid_schema', '评论必须是 1..2000 字符');
  if (!/^[0-9a-zA-Z_-]{8,64}$/.test(clientMsgId)) return fail('invalid_schema', 'client_msg_id 非法');

  const idemScope = `f:${feedId}`;
  const dup = await pool.query(
    'SELECT id, seq FROM events WHERE actor_id = $1 AND idem_scope = $2 AND client_msg_id = $3',
    [actor.id, idemScope, clientMsgId],
  );
  if (dup.rows[0]) return ok({ event_id: Number(dup.rows[0].id), deduplicated: true });

  const run = actor.type === 'agent' ? withWriterTx : withTx;
  try {
    const out = await run(async (client) => {
      const exists = await client.query('SELECT 1 FROM feeds WHERE id = $1 AND deleted_at IS NULL', [feedId]);
      if (!exists.rows[0]) return { missing: true };
      const ins = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload, client_msg_id, idem_scope)
         VALUES ('feed', $1, 'CommentAdded', $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (actor_id, idem_scope, client_msg_id) DO NOTHING
         RETURNING id`,
        [feedId, actor.id, actor.type, JSON.stringify({ body }), clientMsgId, idemScope],
      );
      if (ins.rows.length === 0) return { deduplicated: true, eventId: null };
      const eventId = Number(ins.rows[0].id);
      const applied = await client.query('SELECT qm_apply_comment($1,$2,$3,$4,$5) AS comment_id', [
        eventId, feedId, actor.id, actor.type, body,
      ]);
      return { deduplicated: false, eventId, commentId: Number(applied.rows[0].comment_id) };
    });
    if (out.missing) return fail('not_found', '这条说说不存在');
    return ok({ event_id: out.eventId, comment_id: out.commentId, deduplicated: out.deduplicated });
  } catch (err) {
    console.error('[feed] comment failed', err.message);
    return fail('internal', '评论失败');
  }
}

export async function addLike(command, actor) {
  return toggleLike(command, actor, true);
}

export async function removeLike(command, actor) {
  return toggleLike(command, actor, false);
}

async function toggleLike(command, actor, like) {
  if (actor.type !== 'user') return fail('forbidden', 'v1 只有人类可以点赞');
  const feedId = Number(command.feed_id);
  if (!Number.isInteger(feedId) || feedId <= 0) return fail('invalid_schema', 'feed_id 非法');
  try {
    return await withTx(async (client) => {
      const exists = await client.query('SELECT 1 FROM feeds WHERE id = $1 AND deleted_at IS NULL', [feedId]);
      if (!exists.rows[0]) return fail('not_found', '这条说说不存在');
      if (like) {
        const r = await client.query(
          'INSERT INTO likes (feed_id, author_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [feedId, actor.id],
        );
        // 重复点赞不写事件、不增计数（幂等）
        if (r.rowCount === 0) return ok({ feed_id: feedId, liked: true, deduplicated: true });
        await client.query('UPDATE feeds SET like_count = like_count + 1 WHERE id = $1', [feedId]);
      } else {
        const r = await client.query('DELETE FROM likes WHERE feed_id = $1 AND author_id = $2', [feedId, actor.id]);
        if (r.rowCount === 0) return ok({ feed_id: feedId, liked: false, deduplicated: true });
        await client.query('UPDATE feeds SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1', [feedId]);
      }
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('feed', $1, $2, $3, $4, $5::jsonb)`,
        [feedId, like ? 'FeedLiked' : 'FeedUnliked', actor.id, actor.type, JSON.stringify({})],
      );
      return ok({ feed_id: feedId, liked: like });
    });
  } catch (err) {
    console.error('[feed] like failed', err.message);
    return fail('internal', '操作失败');
  }
}

export async function listFeeds(actor, { beforeId = 0, limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT f.id, f.author_id, f.author_type, p.display_name AS author_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id,
            f.body, f.visibility, f.like_count, f.comment_count, f.created_at,
            EXISTS (SELECT 1 FROM likes l WHERE l.feed_id = f.id AND l.author_id = $1) AS liked_by_me
       FROM feeds f JOIN principals p ON p.id = f.author_id
      WHERE f.deleted_at IS NULL
        AND (f.visibility = 'friends' OR f.author_id = $1)
        AND ($2 = 0 OR f.id < $2)
      ORDER BY f.id DESC
      LIMIT $3`,
    [actor.id, Number(beforeId) || 0, Math.min(Number(limit) || 20, 50)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    authorId: Number(r.author_id),
    authorType: r.author_type,
    authorName: r.author_name,
    avatarHue: r.avatar_hue,
    avatarUrl: avatarOf(r),
    body: r.body,
    visibility: r.visibility,
    likeCount: Number(r.like_count),
    commentCount: Number(r.comment_count),
    likedByMe: Boolean(r.liked_by_me),
    createdAt: r.created_at,
  }));
}

export async function listComments(actor, feedId, limit = 50) {
  // 必须校验说说的可见性：private 的说说，评论也不该被任何人读到
  const { rows: feedRows } = await pool.query(
    'SELECT author_id, visibility FROM feeds WHERE id = $1 AND deleted_at IS NULL',
    [Number(feedId)],
  );
  const feed = feedRows[0];
  if (!feed) return null;
  if (feed.visibility === 'private' && Number(feed.author_id) !== Number(actor.id)) return null;
  const { rows } = await pool.query(
    `SELECT c.id, c.author_id, c.author_type, p.display_name AS author_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id, c.body, c.created_at
       FROM comments c JOIN principals p ON p.id = c.author_id
      WHERE c.feed_id = $1
      ORDER BY c.id ASC
      LIMIT $2`,
    [Number(feedId), Math.min(Number(limit) || 50, 200)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    authorId: Number(r.author_id),
    authorType: r.author_type,
    authorName: r.author_name,
    avatarHue: r.avatar_hue,
    avatarUrl: avatarOf(r),
    body: r.body,
    createdAt: r.created_at,
  }));
}
