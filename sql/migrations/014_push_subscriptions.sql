-- Web Push 订阅（浏览器/手机的系统通知）。
-- 一条记录 = 一个「浏览器/设备 + 账号」的订阅；同一账号在多台设备上会有多行。
--
-- 为什么 endpoint 是唯一键（和 principal 一起）：
--   同一个 endpoint 重复订阅（用户点了两次「开启通知」）应当更新密钥而不是插两行，
--   否则一条消息会推两遍；换设备会换 endpoint，自然多一行。
--
-- 为什么记 last_push_at / last_error / attempts：
--   1) 验证脚本要用「是否真的尝试过推送」作为断言（假 endpoint 必然失败，但尝试是可观测的）
--   2) 排障时能区分「没推」和「推了被 push 服务拒绝」（410/404 表示订阅失效，应当清理）
--   3) 设置页可以显示「上次通知时间」，用户能自查
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            bigserial PRIMARY KEY,
  principal_id  bigint NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_push_at  timestamptz,
  last_error    text,
  attempts      integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_principal_endpoint_key
  ON push_subscriptions (principal_id, endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_principal_idx
  ON push_subscriptions (principal_id);

-- 迁移可能在 postgres 名下执行（如 rebuild-drill），而业务连接是 qqmini_app：
-- 显式授权，别依赖「建表时的 owner 恰好是应用角色」。
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO qqmini_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE push_subscriptions_id_seq TO qqmini_app';
  END IF;
  -- mcp_writer 不给：AI 没有读别人推送订阅的理由
END $mig$;
