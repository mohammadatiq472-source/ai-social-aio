-- 性能审计（2026-11-13）落地的索引与死索引清理。
-- 注意：scripts/migrate.mjs 每个文件在事务里执行，所以这里不能用 CREATE INDEX CONCURRENTLY。
-- 当前表都很小（messages 百级），锁表时间可忽略；上量以后请手工用
--   CREATE INDEX CONCURRENTLY ...
-- 的方式重放同样的定义。

-- 1) [C10] 门控与列表：按 sender / conversation + 时间倒序
--    没有这两条时，每发一条 AI 消息都要全表扫 messages 三次（实测 20 万行 133/133/138ms）
CREATE INDEX IF NOT EXISTS messages_sender_created_idx ON messages (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_conv_created_idx   ON messages (conversation_id, created_at DESC);

-- 2) /api/agents 的两个子查询、以及 WS 里的 token 查找
CREATE INDEX IF NOT EXISTS agent_tokens_agent_idx ON agent_tokens (agent_id, last_used_at DESC);

-- 3) 按 principal 反查会话（会话列表、好友/群查询都用）
CREATE INDEX IF NOT EXISTS conversation_members_principal_idx ON conversation_members (principal_id);

-- 4) whats_new 游标：只关心 MessageSent，按会话 + 事件 id
CREATE INDEX IF NOT EXISTS events_message_cursor_idx
  ON events (aggregate_id, id) WHERE type = 'MessageSent';

-- 5) 清理重复/无用索引（写入放大）
--    events_id_idx 与 events_pkey 定义完全相同；events_idem_lookup 与唯一索引 events_idem_idx 同列
DROP INDEX IF EXISTS events_id_idx;
DROP INDEX IF EXISTS events_idem_lookup;
--    parts 从来没被 `@>` 查询过（GIN 是最贵的索引维护）；tags 同理
DROP INDEX IF EXISTS messages_parts_gin;
DROP INDEX IF EXISTS sticker_items_tags_idx;

-- 6) 昵称模糊搜索：10 万用户时 ILIKE '%q%' 会全表扫 119ms。
--    pg_trgm 是 trusted extension，普通库主一般也能建；建不了就跳过，不阻塞迁移。
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm 不可用，跳过昵称模糊搜索索引（ILIKE 仍可用，只是慢）';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS principals_name_trgm ON principals USING gin (display_name gin_trgm_ops)';
  END IF;
END $$;
