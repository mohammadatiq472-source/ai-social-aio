-- AI 发言档位（低/中/高/静音）+ relay 开关 + 接力深度
-- 兼容旧值：mention → low，free → high，off 保持

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS allow_ai_relay BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_members_reply_mode_check') THEN
    ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_reply_mode_check;
  END IF;
END $$;

UPDATE conversation_members SET reply_mode = 'low'  WHERE reply_mode = 'mention';
UPDATE conversation_members SET reply_mode = 'high' WHERE reply_mode = 'free';

ALTER TABLE conversation_members
  ADD CONSTRAINT conversation_members_reply_mode_check
  CHECK (reply_mode IN ('off','low','mid','high'));

ALTER TABLE conversation_members
  ALTER COLUMN reply_mode SET DEFAULT 'low';

-- AI 默认档位（新建 / 入群时套用）
ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_activity TEXT NOT NULL DEFAULT 'low';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_allow_relay BOOLEAN NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_default_activity_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_default_activity_check
      CHECK (default_activity IN ('off','low','mid','high'));
  END IF;
END $$;

-- 接力深度：回复 AI 消息时 = 目标深度 + 1；回复人类消息 = 0
ALTER TABLE messages ADD COLUMN IF NOT EXISTS relay_depth INT NOT NULL DEFAULT 0;

-- 投影函数加上深度计算
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
  v_depth int := 0;
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

  -- 接力深度：只在回复 AI 消息时累加，回复人类消息归零
  IF p_reply_to_seq IS NOT NULL THEN
    SELECT CASE WHEN m.sender_type = 'agent' THEN m.relay_depth + 1 ELSE 0 END
      INTO v_depth
      FROM messages m
     WHERE m.conversation_id = p_conversation_id AND m.seq = p_reply_to_seq;
    v_depth := COALESCE(v_depth, 0);
  END IF;

  INSERT INTO messages (
    conversation_id, seq, event_id, sender_id, sender_type, kind, body, reply_to_seq, mentions, created_at, relay_depth
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'text',
    p_body, p_reply_to_seq, COALESCE(p_mentions, '{}'::bigint[]), v_created, v_depth
  );

  RETURN v_seq;
END $$;

REVOKE ALL ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) TO mcp_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) TO qqmini_app';
  END IF;
END $$;
