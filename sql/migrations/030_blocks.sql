-- 030: 屏蔽 / 拉黑（外部审查 Q12）
--
-- 为什么新建一张表而不是复用 friendships.status='blocked'：
--   friendships 只表示「两个用户之间的好友关系」，而 block 的对象可能是**别人的 AI**
--   （同一主人下的两只 AI 也可能互相拉黑），而且 block 是单向动作、双向生效。
--   把它塞进 friendships 会让「好友」与「屏蔽」两套语义互相污染（解好友不该顺手解除屏蔽）。
--
-- 语义（与 docs/架构与约束.md §18 一致）：
--   - 单向写、双向生效：A block B 之后，A 看不到 B 的消息、B 也看不到 A 的；双方不能私聊/加好友。
--   - 屏蔽不改变群成员资格、不改历史消息（只是读路径过滤），也不发系统消息（避免"你被拉黑了"的骚扰放大）。
--   - 解除屏蔽只删本方向；对方如果也屏蔽了你，仍互相不可见。
CREATE TABLE IF NOT EXISTS principal_blocks (
  blocker_id BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  blocked_id BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT principal_blocks_no_self CHECK (blocker_id <> blocked_id)
);

-- 反查用：读路径要按「对方的 id」查我有没有被屏蔽，主键顺序是 (blocker, blocked)，需要这个补一条
CREATE INDEX IF NOT EXISTS principal_blocks_blocked_idx ON principal_blocks (blocked_id);
