-- ⚠️ 本文件必须用超级用户（postgres）执行：qm_apply_message / qm_apply_system_message 的 owner 是 postgres，
-- 普通库角色 qqmini_app 执行会报 "must be owner of function"。
-- 线上执行方式：su - postgres -c "psql -d qqmini -f sql/migrations/011_last_message_at.sql"
-- 会话列表优化：把「每个群最后一条消息时间」从相关子查询改成 conversations 上的缓存列。
-- 之前每次打开列表都要对每个群查一次 messages 的 max(created_at)（20 万行时单群 108ms）。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

-- 回填历史
UPDATE conversations c
   SET last_message_at = m.last_at
  FROM (SELECT conversation_id, max(created_at) AS last_at FROM messages GROUP BY conversation_id) m
 WHERE m.conversation_id = c.id
   AND c.last_message_at IS NULL;

CREATE INDEX IF NOT EXISTS conversations_last_message_idx ON conversations (last_message_at DESC NULLS LAST);

-- 投影函数：写消息时顺手更新 last_message_at（和 last_seq 同一个 UPDATE，不增加写次数）
CREATE OR REPLACE FUNCTION qm_apply_message(
  p_event_id        bigint,
  p_conversation_id bigint,
  p_sender_id       bigint,
  p_sender_type     text,
  p_body            text,
  p_reply_to_seq    bigint,
  p_mentions        bigint[],
  p_parts           jsonb DEFAULT '[]'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq bigint;
  v_created timestamptz;
  v_depth int := 0;
BEGIN
  SELECT created_at INTO v_created FROM events WHERE id = p_event_id;
  IF v_created IS NULL THEN
    RAISE EXCEPTION 'event % not found', p_event_id;
  END IF;

  UPDATE conversations
     SET last_seq = last_seq + 1,
         last_message_at = v_created
   WHERE id = p_conversation_id
   RETURNING last_seq INTO v_seq;
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'conversation % not found', p_conversation_id;
  END IF;

  UPDATE events SET seq = v_seq WHERE id = p_event_id;

  IF p_reply_to_seq IS NOT NULL THEN
    SELECT CASE WHEN m.sender_type = 'agent' THEN m.relay_depth + 1 ELSE 0 END
      INTO v_depth
      FROM messages m
     WHERE m.conversation_id = p_conversation_id AND m.seq = p_reply_to_seq;
    v_depth := COALESCE(v_depth, 0);
  END IF;

  INSERT INTO messages (
    conversation_id, seq, event_id, sender_id, sender_type, kind, body,
    reply_to_seq, mentions, created_at, relay_depth, parts
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'text', p_body,
    p_reply_to_seq, COALESCE(p_mentions, '{}'::bigint[]), v_created, v_depth,
    COALESCE(p_parts, '[]'::jsonb)
  );

  RETURN v_seq;
END $$;

-- 系统消息（表情包分享等）也要推进 last_message_at
CREATE OR REPLACE FUNCTION qm_apply_system_message(
  p_event_id        bigint,
  p_conversation_id bigint,
  p_sender_id       bigint,
  p_sender_type     text,
  p_body            text,
  p_mentions        bigint[]
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq bigint;
  v_created timestamptz;
BEGIN
  SELECT created_at INTO v_created FROM events WHERE id = p_event_id;
  IF v_created IS NULL THEN
    RAISE EXCEPTION 'event % not found', p_event_id;
  END IF;

  UPDATE conversations
     SET last_seq = last_seq + 1,
         last_message_at = v_created
   WHERE id = p_conversation_id
   RETURNING last_seq INTO v_seq;
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'conversation % not found', p_conversation_id;
  END IF;

  UPDATE events SET seq = v_seq WHERE id = p_event_id;

  INSERT INTO messages (
    conversation_id, seq, event_id, sender_id, sender_type, kind, body,
    reply_to_seq, mentions, created_at, relay_depth, parts
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'system', p_body,
    NULL, COALESCE(p_mentions, '{}'::bigint[]), v_created, 0, '[]'::jsonb
  );

  RETURN v_seq;
END $$;
