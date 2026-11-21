-- 审核闭环（公测前）：举报处理入口 + 站务权限 + 消息隐藏 + 账号封禁。
--
-- 为什么要 hidden_at 而不是复用 recalled_at：
--   recalled_at 是「发言者自己撤回」，用户看得到「XX 撤回了一条消息」；
--   站务隐藏是对所有成员的静默下架，原文要保留给审计/申诉。两个语义不能混。
--
-- 为什么 reports 要加 conversation_id：
--   消息的定位是 (conversation_id, seq)，seq 只在会话内唯一。举报接口以前只传 seq，
--   站务根本没法知道是哪条消息。新举报必须带 conversation_id；老数据留空（处理不了就驳回）。
ALTER TABLE principals ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE principals ADD COLUMN IF NOT EXISTS suspended_until timestamptz;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS conversation_id bigint;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS action text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS action_note text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS handled_by bigint;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS handled_at timestamptz;

ALTER TABLE messages_meta ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

-- 站务动作是独立事件（ReportHandled / MessageHidden / UserSuspended），
-- 事件表原来的 aggregate_type 只允许 conversation/feed/principal，这里补 'report'
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_aggregate_type_check;
ALTER TABLE events ADD CONSTRAINT events_aggregate_type_check
  CHECK (aggregate_type = ANY (ARRAY['conversation', 'feed', 'principal', 'report']));

-- 站务列表：按状态 + 时间倒序；没有这条时每次打开后台都全表扫
CREATE INDEX IF NOT EXISTS reports_status_created_idx ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS principals_admin_idx ON principals (is_admin) WHERE is_admin;

-- 视图补 hidden_at（迁移 012 建的视图不含它）；列顺序保持与 012 一致，只在末尾追加
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
       COALESCE(e.payload->'parts', '[]'::jsonb) AS parts,
       m.hidden_at
  FROM messages_meta m
  JOIN events e ON e.id = m.event_id;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT SELECT ON messages TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
    EXECUTE 'GRANT SELECT ON messages TO mcp_writer';
  END IF;
END $mig$;
