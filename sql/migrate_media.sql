-- M0 媒体地基：附件表 + 消息 parts
-- 原则：二进制永远不进 events；events/messages 只存引用与元数据。

CREATE TABLE IF NOT EXISTS attachments (
  id               BIGSERIAL PRIMARY KEY,
  uploader_id      BIGINT NOT NULL REFERENCES principals(id),
  kind             TEXT NOT NULL CHECK (kind IN ('image','voice','video','file','sticker')),
  mime             TEXT NOT NULL,
  bytes            BIGINT NOT NULL,
  sha256           TEXT NOT NULL,
  storage_key      TEXT NOT NULL,
  width            INT,
  height           INT,
  duration_ms      INT,
  poster_key       TEXT,
  transcript       TEXT,
  transcript_state TEXT NOT NULL DEFAULT 'none'
                   CHECK (transcript_state IN ('none','pending','done','failed')),
  scan_state       TEXT NOT NULL DEFAULT 'clean'
                   CHECK (scan_state IN ('pending','clean','blocked')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  UNIQUE (sha256, uploader_id)
);
CREATE INDEX IF NOT EXISTS attachments_uploader_idx ON attachments (uploader_id, created_at DESC);

-- 一条消息 = 若干 parts（文本/图片/语音/视频/表情/文件）
-- body 仍然保留，作为「预览文本」：首段文本，或 [图片] / [语音] 这类占位，便于列表与搜索
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parts JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS messages_parts_gin ON messages USING gin (parts);

-- 投影函数加 p_parts
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
  UPDATE conversations
     SET last_seq = last_seq + 1
   WHERE id = p_conversation_id
   RETURNING last_seq INTO v_seq;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'conversation % not found', p_conversation_id; END IF;

  SELECT created_at INTO v_created FROM events WHERE id = p_event_id;
  IF v_created IS NULL THEN RAISE EXCEPTION 'event % not found', p_event_id; END IF;

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

-- 旧签名（无 parts）可能还在被旧进程调用：保留一个包装，避免发布瞬间报错
CREATE OR REPLACE FUNCTION qm_apply_message(
  bigint,bigint,bigint,text,text,bigint,bigint[]
) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT qm_apply_message($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb);
$$;

REVOKE ALL ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[],jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[],jsonb) TO mcp_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[],jsonb) TO qqmini_app';
  END IF;
END $$;

-- [C3] AI 角色需要读附件元数据才能拿 URL（正文仍只读）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT SELECT ON attachments TO mcp_writer';
  END IF;
END $$;
