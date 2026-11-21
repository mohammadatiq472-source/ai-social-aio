-- 幂等键作用域化：从 (actor_id, client_msg_id) 全局唯一
-- 改为 (actor_id, idem_scope, client_msg_id)，其中 idem_scope = 'c:<conversation_id>' 或 'feed'。
-- 原因：全局唯一会让「同一个 UUID 在另一个群发送」被判为重复、静默丢掉消息；
-- 而完全不加约束又会让重试重复写。作用域化两头都对。

ALTER TABLE events ADD COLUMN IF NOT EXISTS idem_scope TEXT;

UPDATE events
   SET idem_scope = CASE WHEN aggregate_type = 'conversation' THEN 'c:' || aggregate_id ELSE aggregate_type END
 WHERE idem_scope IS NULL;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_actor_id_client_msg_id_key;

DROP INDEX IF EXISTS events_idem_idx;
CREATE UNIQUE INDEX events_idem_idx ON events (actor_id, idem_scope, client_msg_id);

CREATE INDEX IF NOT EXISTS events_idem_lookup ON events (actor_id, idem_scope, client_msg_id) WHERE client_msg_id IS NOT NULL;
