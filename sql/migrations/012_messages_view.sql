-- 去重：messages 不再存 body/parts（它们已经在 events.payload 里），读的时候通过视图 join events。
-- 迁移前会先校验两份数据一致，不一致直接中止（拒绝在数据漂移时去重）。
-- ⚠️ 本文件必须用超级用户（postgres）执行：qm_apply_* 的 owner 是 postgres。
DO $$
DECLARE
  v_body bigint;
  v_parts bigint;
BEGIN
  SELECT count(*) INTO v_body
    FROM messages m JOIN events e ON e.id = m.event_id
   WHERE COALESCE(e.payload->>'body', '') <> m.body;
  SELECT count(*) INTO v_parts
    FROM messages m JOIN events e ON e.id = m.event_id
   WHERE COALESCE(e.payload->'parts', '[]'::jsonb) <> COALESCE(m.parts, '[]'::jsonb);
  IF v_body > 0 OR v_parts > 0 THEN
    RAISE EXCEPTION 'messages 与 events 不一致（body=%, parts=%），已中止去重迁移', v_body, v_parts;
  END IF;

  ALTER TABLE messages RENAME TO messages_meta;
  ALTER TABLE messages_meta DROP COLUMN body;
  ALTER TABLE messages_meta DROP COLUMN parts;

  CREATE OR REPLACE VIEW messages AS
  SELECT m.conversation_id,
         m.seq,
         m.event_id,
         m.sender_id,
         m.sender_type,
         m.kind,
         COALESCE(e.payload->>'body', '') AS body,
         m.reply_to_seq,
         m.mentions,
         m.created_at,
         m.recalled_at,
         m.relay_depth,
         COALESCE(e.payload->'parts', '[]'::jsonb) AS parts
    FROM messages_meta m
    JOIN events e ON e.id = m.event_id;

  -- 投影函数改成写 messages_meta（不再写 body/parts）
  EXECUTE $fn$
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
AS $body$
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

  INSERT INTO messages_meta (
    conversation_id, seq, event_id, sender_id, sender_type, kind,
    reply_to_seq, mentions, created_at, relay_depth
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'text',
    p_reply_to_seq, COALESCE(p_mentions, '{}'::bigint[]), v_created, v_depth
  );

  RETURN v_seq;
END $body$;
$fn$;

  EXECUTE $fn$
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
AS $body$
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

  INSERT INTO messages_meta (
    conversation_id, seq, event_id, sender_id, sender_type, kind,
    reply_to_seq, mentions, created_at, relay_depth
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'system',
    NULL, COALESCE(p_mentions, '{}'::bigint[]), v_created, 0
  );

  RETURN v_seq;
END $body$;
$fn$;

  -- 视图权限（应用只读视图；底层 meta 表由 SECURITY DEFINER 函数写）
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT SELECT ON messages TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
    EXECUTE 'GRANT SELECT ON messages TO mcp_writer';
  END IF;
END $$;
