
-- 系统消息（kind='system'）：表情包分享这类"事件反馈"用，居中灰字展示，不带头像/气泡。
-- 关键点：仍然用事件类型 MessageSent + payload.kind='system'，
-- 这样 M1 重放（sql/rebuild.sql）按同一批事件就能还原，不会漏消息、也不会把 kind 弄丢。
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
  v_seq     bigint;
  v_created timestamptz;
BEGIN
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
    conversation_id, seq, event_id, sender_id, sender_type, kind, body,
    reply_to_seq, mentions, created_at, relay_depth, parts
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'system', p_body,
    NULL, COALESCE(p_mentions, '{}'::bigint[]), v_created, 0, '[]'::jsonb
  );

  RETURN v_seq;
END $$;

REVOKE ALL ON FUNCTION qm_apply_system_message(bigint,bigint,bigint,text,text,bigint[]) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_system_message(bigint,bigint,bigint,text,text,bigint[]) TO qqmini_app';
  END IF;
  -- 系统消息只允许人类侧写入；mcp_writer 不授权（AI 不能伪造系统提示）
END $$;

SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname = 'qm_apply_system_message';