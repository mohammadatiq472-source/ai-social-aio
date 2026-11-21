-- MCP 游标显式 ack（2026-11-19，对应外部审查 Q2 / docs/设计-MCP游标与ack-2026-11-19.md）
--
-- 问题：whats_new 在**返回之前**就把 last_cursor 推进到 next_seq，于是「服务端认为已读」和
-- 「客户端真的处理完」是同一时刻；中间崩溃（模型超时、容器重启）那批事件就永久消失。
--
-- 方案：把位点拆成两个
--   delivered_cursor：投递到哪（诊断用，不参与拉取）
--   acked_cursor    ：客户端确认处理完到哪（**拉取起点**）
-- 只有客户端下次带 ack_seq 才推进 acked，所以语义从 at-most-once 变成 at-least-once。
--
-- 兼容：老客户端不传 ack_seq 时仍走 last_cursor（行为完全不变）；迁移时用 last_cursor 回填
-- acked_cursor，避免已部署的 Agent 重读历史。
ALTER TABLE agent_cursors ADD COLUMN IF NOT EXISTS acked_cursor bigint;
ALTER TABLE agent_cursors ADD COLUMN IF NOT EXISTS delivered_cursor bigint;

UPDATE agent_cursors
   SET acked_cursor = COALESCE(acked_cursor, last_cursor, 0),
       delivered_cursor = COALESCE(delivered_cursor, last_cursor, 0)
 WHERE acked_cursor IS NULL OR delivered_cursor IS NULL;
