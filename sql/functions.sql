-- 投影函数：唯一允许"写读模型"的入口，以 SECURITY DEFINER 运行。
-- [C3] mcp_writer 角色自己没有任何 messages/conversations 的写权限，只能调用本函数。
-- 这样既满足"AI 走单一写入口"，又让"AI 不能直接改库"成为数据库层事实。

CREATE OR REPLACE FUNCTION qm_apply_message(
  p_event_id        bigint,
  p_conversation_id bigint,
  p_sender_id       bigint,
  p_sender_type     text,
  p_body            text,
  p_reply_to_seq    bigint,
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
  -- 会话内 seq 原子递增（行锁到事务结束，天然串行化同一会话的写入）
  UPDATE conversations
     SET last_seq = last_seq + 1
   WHERE id = p_conversation_id
   RETURNING last_seq INTO v_seq;

  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'conversation % not found', p_conversation_id;
  END IF;

  SELECT created_at INTO v_created FROM events WHERE id = p_event_id;
  IF v_created IS NULL THEN
    RAISE EXCEPTION 'event % not found', p_event_id;
  END IF;

  UPDATE events SET seq = v_seq WHERE id = p_event_id;

  INSERT INTO messages (
    conversation_id, seq, event_id, sender_id, sender_type, kind, body, reply_to_seq, mentions, created_at
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'text',
    p_body, p_reply_to_seq, COALESCE(p_mentions, '{}'::bigint[]), v_created
  );

  RETURN v_seq;
END $$;

REVOKE ALL ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) FROM PUBLIC;

-- 角色可能存在，也可能只在生产环境创建；用 DO 块避免开发环境报错
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) TO mcp_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) TO qqmini_app';
  END IF;
END $$;

-- 重建读模型用：按 events.id 顺序重放（M1 验收）
CREATE OR REPLACE VIEW qm_replay_source AS
SELECT id AS event_id, aggregate_id AS conversation_id, seq, actor_id AS sender_id, actor_type,
       payload->>'body' AS body,
       NULLIF(payload->>'reply_to_seq','')::bigint AS reply_to_seq,
       CASE WHEN jsonb_typeof(payload->'mentions') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(payload->'mentions'))::bigint[]
            ELSE '{}'::bigint[] END AS mentions,
       created_at
  FROM events
 WHERE type = 'MessageSent'
 ORDER BY id;
