-- 举报去重键漏了会话：`(reporter_id, target_type, target_id)` 里 target_id 是「会话内 seq」，
-- seq 只在会话内唯一。上线后表现为「在 A 群举报了 #1，B 群的 #1 就报不了（409 already_reported）」。
--
-- 新键：带上 conversation_id（非消息类举报没有会话，用 COALESCE 归成 0）。
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_reporter_id_target_type_target_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS reports_one_per_target_idx
  ON reports (reporter_id, target_type, target_id, COALESCE(conversation_id, 0::bigint));
