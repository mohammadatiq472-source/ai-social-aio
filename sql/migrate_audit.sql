-- 凭证/权限变更也要进 events（审计可追溯）：events.aggregate_type 增加 'principal'
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_aggregate_type_check;
ALTER TABLE events ADD CONSTRAINT events_aggregate_type_check
  CHECK (aggregate_type IN ('conversation','feed','principal'));
