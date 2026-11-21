-- 从 events 重建读模型（M1 验收；2026-11-19 Q9 扩到「消息之外」）
-- 用法：psql -d <某个库> -f sql/rebuild.sql
-- 前提：events 是唯一真相源；本文件只读 events，不读写模型当作输入（唯一例外见「非事件状态」）。
--
-- 覆盖范围（Q9 之后）：
--   1. messages_meta：MessageSent、MessageRecalled（recalled_at）、MessageHidden（hidden_at）
--   2. conversations：GroupCreated（title/owner/created_at/join_mode/discoverable/description）、
--      GroupPublicityChanged、ConversationDissolved（dissolved_at/by）、last_seq、last_message_at
--   3. conversation_members：GroupCreated/MemberAdded/GroupJoined/GroupJoinAccepted 入群、
--      MemberRemoved 退群、MemberRoleChanged 改角色 —— **整体从事件重放，不再保留脏成员行**
--   4. group_join_requests：GroupJoinRequested 建 pending、GroupJoinAccepted/Rejected 落决定
--   5. feeds/comments/likes（沿用 M1 的逻辑）
--
-- **非事件状态**（刻意不从事件重放，先快照再还原）：
--   conversation_members.{reply_mode,last_read_seq,allow_ai_relay,joined_at} 是客户端行为缓存：
--   已读位点由 REST 直接写、没有对应事件（每次读都落事件会把日志变大几十倍），
--   所以 rebuild 把它们当"成员属性"保留。同理 conversations.announcement 正文：审计事件按设计只记
--   length、不复制正文，空库恢复必须靠 PITR + 备份（见 docs/维护手册.md §5），不要指望本文件。
--
-- 与 sql/ops/harden-event-append-only.sql 的关系：
--   hardening 把 events 的 owner 改成 postgres、只给 qqmini_app 留 SELECT/INSERT，
--   本文件对 events 只做 SELECT（不 UPDATE/DELETE），所以加固后仍可用 app 角色执行；
--   它 TRUNCATE/INSERT 的是读模型（owner 不变）。
--   执行顺序：bootstrap → migrate → harden；若重跑 bootstrap（会重置 owner/GRANT），必须再跑一次 harden。
--
-- 验证：node scripts/verify/verify-rebuild-replay.mjs（造「发消息→撤回→站务隐藏→已读→成员退出→改角色→审批」序列，
--   跑本文件后与跑之前**逐表逐字段对比**；需要 AIO_ALLOW_REBUILD=1，避免误在生产库上跑）。
BEGIN;

-- 0) 先把「非事件状态」抄出来：这些列不由事件产生，重建成员关系时必须还原回去
CREATE TEMP TABLE _keep_member_state ON COMMIT DROP AS
SELECT conversation_id, principal_id, reply_mode, last_read_seq, allow_ai_relay, joined_at
  FROM conversation_members;

TRUNCATE messages_meta, comments, likes, feeds RESTART IDENTITY;
-- 成员与审批完全由事件推导：先清空，避免「事件里已经退群、表里还留着」的脏行
TRUNCATE conversation_members;
TRUNCATE group_join_requests RESTART IDENTITY;

-- ---------------------------------------------------------------- 1) 消息正文
INSERT INTO messages_meta (
  conversation_id, seq, event_id, sender_id, sender_type, kind, reply_to_seq, mentions, created_at
)
SELECT
  e.aggregate_id,
  e.seq,
  e.id,
  e.actor_id,
  e.actor_type,
  COALESCE(NULLIF(e.payload->>'kind', ''), 'text'),
  NULLIF(e.payload->>'reply_to_seq', '')::bigint,
  COALESCE((SELECT array_agg(v::bigint) FROM jsonb_array_elements_text(e.payload->'mentions') v), '{}'::bigint[]),
  e.created_at
FROM events e
WHERE e.type = 'MessageSent'
  AND e.seq IS NOT NULL
  -- 会话被物理删除后，其消息事件仍留在日志里（审计用）；重建只还原"仍存在的聚合"，
  -- 否则会把已删会话的消息重建成孤儿行。生产上应改为软删除 + ConversationDeleted 事件。
  AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = e.aggregate_id)
ORDER BY e.id;

-- 撤回：消息行先插好，再补 recalled_at（同一 (会话, seq) 可能因重发被记多次，取最早一条）
UPDATE messages_meta m
   SET recalled_at = x.ts
  FROM (
    SELECT e.aggregate_id AS cid, (e.payload->>'seq')::bigint AS seq, min(e.created_at) AS ts
      FROM events e
     WHERE e.type = 'MessageRecalled' AND e.payload ? 'seq'
     GROUP BY 1, 2
  ) x
 WHERE m.conversation_id = x.cid AND m.seq = x.seq;

-- 站务隐藏：与撤回分开两个字段（语义不同：本人撤回 vs 站务静默下架）
UPDATE messages_meta m
   SET hidden_at = x.ts
  FROM (
    SELECT e.aggregate_id AS cid, (e.payload->>'seq')::bigint AS seq, min(e.created_at) AS ts
      FROM events e
     WHERE e.type = 'MessageHidden' AND e.payload ? 'seq'
     GROUP BY 1, 2
  ) x
 WHERE m.conversation_id = x.cid AND m.seq = x.seq;

-- ---------------------------------------------------------------- 2) 会话元信息 + 成员 + 审批（按事件顺序重放）
DO $$
DECLARE
  ev RECORD;
  pid BIGINT;
  rid BIGINT;
BEGIN
  FOR ev IN
    SELECT id, aggregate_id, type, actor_id, payload, created_at
      FROM events
     WHERE type IN (
       'GroupCreated', 'GroupPublicityChanged', 'GroupAnnouncementChanged', 'ConversationDissolved',
       'MemberAdded', 'MemberRemoved', 'MemberRoleChanged', 'GroupJoined',
       'GroupJoinRequested', 'GroupJoinAccepted', 'GroupJoinRejected'
     )
     ORDER BY id
  LOOP
    -- 会话被物理删除后事件仍在日志里（审计用）：这类事件的投影目标已经不存在，
    -- 直接跳过，否则会撞 conversation_members.group_join_requests 的外键。
    -- （生产应改为软删除 + 事件；这里只保证「不因为历史脏事件把整个重建搞挂」。）
    IF ev.aggregate_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = ev.aggregate_id) THEN
      CONTINUE;
    END IF;

    CASE ev.type
      WHEN 'GroupCreated' THEN
        -- join_mode/discoverable/description 是 2026-11-19 起才写进 payload 的；
        -- 老事件没有这些字段时 COALESCE 会保留当前列（不会把公开群悄悄改回私有）。
        UPDATE conversations c
           SET title = COALESCE(ev.payload->>'title', c.title),
               owner_id = ev.actor_id,
               created_by = ev.actor_id,
               created_at = ev.created_at,
               join_mode = COALESCE(ev.payload->>'join_mode', c.join_mode),
               discoverable = COALESCE((ev.payload->>'discoverable')::boolean, c.discoverable),
               description = COALESCE(ev.payload->>'description', c.description)
         WHERE c.id = ev.aggregate_id;
        INSERT INTO conversation_members (conversation_id, principal_id, role)
          VALUES (ev.aggregate_id, ev.actor_id, 'owner')
          ON CONFLICT (conversation_id, principal_id) DO UPDATE SET role = 'owner';
        INSERT INTO conversation_members (conversation_id, principal_id, role)
          SELECT ev.aggregate_id, v::bigint, 'member'
            FROM jsonb_array_elements_text(COALESCE(ev.payload->'member_ids', '[]'::jsonb)) v
          ON CONFLICT DO NOTHING;

      WHEN 'GroupPublicityChanged' THEN
        UPDATE conversations c
           SET discoverable = COALESCE((ev.payload->>'discoverable')::boolean, c.discoverable),
               join_mode = COALESCE(ev.payload->>'join_mode', c.join_mode),
               description = COALESCE(ev.payload->>'description', c.description)
         WHERE c.id = ev.aggregate_id;

      WHEN 'GroupAnnouncementChanged' THEN
        -- payload 只有 length（设计：审计不复制正文）。此处只把时间戳对齐事件时间，
        -- 正文保留现值——空库恢复必须 PITR + 备份，不要指望 rebuild 变出群公告。
        UPDATE conversations c
           SET announcement_updated_at = ev.created_at,
               announcement_updated_by = ev.actor_id
         WHERE c.id = ev.aggregate_id
           AND (c.announcement_updated_at IS NULL OR c.announcement_updated_at <= ev.created_at);

      WHEN 'ConversationDissolved' THEN
        UPDATE conversations c
           SET dissolved_at = ev.created_at,
               dissolved_by = COALESCE((ev.payload->>'dissolved_by')::bigint, ev.actor_id)
         WHERE c.id = ev.aggregate_id;

      WHEN 'MemberAdded' THEN
        IF ev.payload ? 'principal_id' THEN
          pid := (ev.payload->>'principal_id')::bigint;
          INSERT INTO conversation_members (conversation_id, principal_id, role)
            VALUES (ev.aggregate_id, pid, 'member')
            ON CONFLICT DO NOTHING;
        END IF;

      WHEN 'GroupJoined' THEN
        INSERT INTO conversation_members (conversation_id, principal_id, role)
          VALUES (ev.aggregate_id, ev.actor_id, 'member')
          ON CONFLICT DO NOTHING;

      WHEN 'MemberRemoved' THEN
        -- self:true 的退群事件没有 principal_id，退群的人就是 actor
        pid := COALESCE((ev.payload->>'principal_id')::bigint, ev.actor_id);
        DELETE FROM conversation_members
         WHERE conversation_id = ev.aggregate_id AND principal_id = pid;

      WHEN 'MemberRoleChanged' THEN
        IF ev.payload ? 'principal_id' THEN
          pid := (ev.payload->>'principal_id')::bigint;
          UPDATE conversation_members SET role = COALESCE(ev.payload->>'role', role)
           WHERE conversation_id = ev.aggregate_id AND principal_id = pid;
        END IF;

      WHEN 'GroupJoinRequested' THEN
        IF ev.payload ? 'request_id' THEN
          rid := (ev.payload->>'request_id')::bigint;
          INSERT INTO group_join_requests (id, conversation_id, principal_id, status, message, created_at)
            VALUES (
              rid,
              ev.aggregate_id,
              COALESCE((ev.payload->>'principal_id')::bigint, ev.actor_id),
              'pending',
              COALESCE(ev.payload->>'message', ''),
              ev.created_at
            )
            ON CONFLICT (id) DO NOTHING;
        END IF;

      WHEN 'GroupJoinAccepted' THEN
        IF ev.payload ? 'request_id' THEN
          rid := (ev.payload->>'request_id')::bigint;
          UPDATE group_join_requests
             SET status = 'accepted', decided_at = ev.created_at, decided_by = ev.actor_id
           WHERE id = rid;
        END IF;
        IF ev.payload ? 'principal_id' THEN
          pid := (ev.payload->>'principal_id')::bigint;
          INSERT INTO conversation_members (conversation_id, principal_id, role)
            VALUES (ev.aggregate_id, pid, 'member')
            ON CONFLICT DO NOTHING;
        END IF;

      WHEN 'GroupJoinRejected' THEN
        IF ev.payload ? 'request_id' THEN
          rid := (ev.payload->>'request_id')::bigint;
          UPDATE group_join_requests
             SET status = 'rejected', decided_at = ev.created_at, decided_by = ev.actor_id
           WHERE id = rid;
        END IF;

      ELSE
        NULL;
    END CASE;
  END LOOP;
END $$;

-- 审批表 id 是显式重放的，序列必须推到最大值之后，否则下一次申请会撞主键
SELECT setval('group_join_requests_id_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM group_join_requests), 1));

-- 还原「非事件状态」：已读位点/回复模式/接力开关/入群时间不是事件，按 (会话, 人) 贴回去。
-- 注意：只对「重建后仍然在群里」的行生效——已经退群的人不会因为旧快照被复活。
UPDATE conversation_members cm
   SET reply_mode = k.reply_mode,
       last_read_seq = k.last_read_seq,
       allow_ai_relay = k.allow_ai_relay,
       joined_at = k.joined_at
  FROM _keep_member_state k
 WHERE k.conversation_id = cm.conversation_id
   AND k.principal_id = cm.principal_id;

-- ---------------------------------------------------------------- 3) 会话上的派生计数
UPDATE conversations c
   SET last_seq = COALESCE((SELECT max(m.seq) FROM messages_meta m WHERE m.conversation_id = c.id), 0);

UPDATE conversations c
   SET last_message_at = (SELECT max(m.created_at) FROM messages_meta m WHERE m.conversation_id = c.id);

-- ---------------------------------------------------------------- 4) 说说（沿用 M1 逻辑）
INSERT INTO feeds (id, author_id, author_type, body, visibility, created_at)
SELECT e.seq, e.actor_id, e.actor_type, e.payload->>'body',
       COALESCE(e.payload->>'visibility', 'friends'), e.created_at
FROM events e
WHERE e.type = 'FeedPublished' AND e.seq IS NOT NULL
ORDER BY e.id;

SELECT setval('feeds_id_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM feeds), 1));

-- 评论
INSERT INTO comments (feed_id, author_id, author_type, body, created_at)
SELECT e.aggregate_id, e.actor_id, e.actor_type, e.payload->>'body', e.created_at
FROM events e
WHERE e.type = 'CommentAdded'
ORDER BY e.id;

-- 点赞：按 like/unlike 状态机取每个 (feed, author) 的最后一次动作
INSERT INTO likes (feed_id, author_id, created_at)
SELECT s.aggregate_id, s.actor_id, s.created_at
FROM (
  SELECT DISTINCT ON (aggregate_id, actor_id) aggregate_id, actor_id, type, created_at
    FROM events
   WHERE type IN ('FeedLiked', 'FeedUnliked')
   ORDER BY aggregate_id, actor_id, id DESC
) s
WHERE s.type = 'FeedLiked'
ON CONFLICT DO NOTHING;

-- 冗余计数
UPDATE feeds f
   SET like_count = (SELECT count(*) FROM likes l WHERE l.feed_id = f.id),
       comment_count = (SELECT count(*) FROM comments c WHERE c.feed_id = f.id);

-- 软删除也要重放：FeedDeleted 把 deleted_at 还原
UPDATE feeds f
   SET deleted_at = d.ts
  FROM (SELECT aggregate_id, min(created_at) AS ts FROM events WHERE type='FeedDeleted' GROUP BY aggregate_id) d
 WHERE f.id = d.aggregate_id;

-- ---------------------------------------------------------------- 5) 屏蔽关系（Q12，完全事件驱动）
-- 每个 (blocker, blocked) 取最后一次 BlockCreated/BlockRemoved：BlockCreated 才落一行。
TRUNCATE principal_blocks;
INSERT INTO principal_blocks (blocker_id, blocked_id, created_at)
SELECT s.blocker_id, s.blocked_id, s.created_at
FROM (
  SELECT DISTINCT ON (e.aggregate_id, (e.payload->>'blocked_id')::bigint)
         e.aggregate_id AS blocker_id,
         (e.payload->>'blocked_id')::bigint AS blocked_id,
         e.type, e.created_at
    FROM events e
   WHERE e.type IN ('BlockCreated', 'BlockRemoved')
     AND e.payload ? 'blocked_id'
   ORDER BY e.aggregate_id, (e.payload->>'blocked_id')::bigint, e.id DESC
) s
WHERE s.type = 'BlockCreated'
  AND EXISTS (SELECT 1 FROM principals p WHERE p.id = s.blocker_id)
  AND EXISTS (SELECT 1 FROM principals p WHERE p.id = s.blocked_id);

COMMIT;
