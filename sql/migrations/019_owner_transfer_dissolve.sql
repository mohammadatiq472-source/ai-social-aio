-- 群主转让 / 解散群（产品口径：群主可以直接解散，不需要先把人踢完）
--
-- 解散用「软解散」：conversations.dissolved_at + 清空 conversation_members。
-- 为什么不清 conversations/messages：events 是 append-only 的审计源（C2），
-- 物理删会破坏重放；而所有读路径都以 conversation_members 判成员资格，
-- 清空成员后「列表看不到、读写 403」自然成立，不需要在每个查询里再塞 dissolved 判断。

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS dissolved_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS dissolved_by bigint REFERENCES principals(id) ON DELETE SET NULL;

-- 列表/搜索侧显式过滤一次，防御未来新增查询只看 members 忘了 dissolved
CREATE INDEX IF NOT EXISTS conversations_dissolved_idx ON conversations (dissolved_at) WHERE dissolved_at IS NULL;
