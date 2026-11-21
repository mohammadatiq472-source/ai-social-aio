-- 推荐群聊（群发现）：群主/管理员把群设为「公开推荐」，别人能搜到；入群方式二选一。
--
-- 为什么 discoverable / join_mode / description 放在 conversations 上而不是拆新表：
--   发现目录按 (last_message_at, id) 做 keyset 分页，过滤条件必须是同一行的列；
--   拆表等于每次翻页多一次 join，而这三个字段本来就是每群一份的标量配置。
--
-- 为什么不物理删 group_join_requests：审批记录是群主决策的审计痕迹。
--   「被拒之后还能再申请」靠的是只在 pending 上生效的部分唯一索引，而不是删旧行——
--   删行会让「谁在什么时候被谁拒过」永久消失，且和 events 里的 GroupJoinRejected 对不上。

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS join_mode TEXT NOT NULL DEFAULT 'approval';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

-- CHECK 单独加：ADD COLUMN 里带 CHECK 不能 IF NOT EXISTS，重复执行会报错
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_join_mode_check') THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_join_mode_check CHECK (join_mode IN ('open', 'approval'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS group_join_requests (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  principal_id    BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  message         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  decided_by      BIGINT REFERENCES principals(id) ON DELETE SET NULL
);

-- 同一群 + 同一人只能有一条 pending；accepted/rejected 的历史行不受这个索引约束，
-- 所以 reject 之后再申请是「插一条新 pending」，两次申请的时间线都能查到。
CREATE UNIQUE INDEX IF NOT EXISTS group_join_requests_pending_uniq
    ON group_join_requests (conversation_id, principal_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS group_join_requests_status_idx
    ON group_join_requests (conversation_id, status);

-- 发现目录只扫公开群：部分索引让索引大小跟「公开群数」走，而不是全站群数
CREATE INDEX IF NOT EXISTS conversations_discoverable_idx
    ON conversations (discoverable) WHERE discoverable;

-- 授权：002_grants.sql 的 GRANT ALL ON ALL TABLES 只覆盖「当时已存在」的表，
-- 新表必须显式补，否则部署机上的 qqmini_app 会在运行时 permission denied。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT ALL PRIVILEGES ON group_join_requests TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON SEQUENCE group_join_requests_id_seq TO qqmini_app';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '跳过授权：当前角色无权修改其它角色权限（应由超级用户执行）';
WHEN undefined_object THEN
    RAISE NOTICE '跳过授权：角色或序列不存在';
END $$;
