-- P0 第一批：群公告（AI 可读的群规）+ 邀请防刷（IP 频率 / 邀请深度）
--
-- 为什么公告放在 conversations 上而不是新表：
--   公告是「每个群一份的标量配置」，读路径是会话列表（listConversationsFor）与 MCP 的
--   list_conversations——两者都已经在 conversations 上。拆表等于每次列表都多一次 join，
--   而这 2000 字本来就是群主手写的运维信息，不是消息流。
--
-- 为什么公告不进 events 的 payload：公告是群内公开内容，不是敏感数据；但 2000 字的文本
--   塞进 append-only 事件会被反复重放/索引放大（C3 的 events 要保持机器可读）。变更本身
--   仍然落一条 GroupAnnouncementChanged 事件（谁、什么时候、多长），正文留在当前行上。
--
-- 为什么邀请要有 depth：
--   B 方案没有邮箱验证，「A 邀请 B、B 再邀请 C」可以无限向下繁衍，且每一层都不需要任何
--   外部凭证。depth 记录「这个账号是第几层被邀请的」（站务码 = 0），超过上限就不能再往下
--   邀请——把「一个人能拉出的树」限制在可控规模，而不需要砍掉邀请制本身。
--
-- 为什么 IP 频率闸要按成功兑换数算（而不是失败数）：
--   失败数已经有 login_attempts（invite:<ip>，5 次锁 15 分钟）。这里要拦的是「同一个出口
--   IP 一天批量造出很多真账号」（家宽 NAT / 机房代理），所以必须数成功入账的那些行。
--   计数与兑换在同一个事务里，并且用 advisory lock 按 ip_hash 串行化，避免两个并发兑换
--   同时看到 count=2 都放过去。

-- ---------------------------------------------------------------------------
-- 群公告
-- ---------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS announcement TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS announcement_updated_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS announcement_updated_by BIGINT
  REFERENCES principals(id) ON DELETE SET NULL;

-- 长度上限：应用层按码点校验（emoji 算 1 个字），DB 这里是最后一道。
-- ADD COLUMN 里不能带 IF NOT EXISTS 的 CHECK，所以单独用 DO 块加。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_announcement_len') THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_announcement_len CHECK (char_length(announcement) <= 2000);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 邀请深度 + IP 频率
-- ---------------------------------------------------------------------------
ALTER TABLE user_invite_quotas ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0;
ALTER TABLE invite_redemptions ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_invite_quotas_depth_check') THEN
    ALTER TABLE user_invite_quotas ADD CONSTRAINT user_invite_quotas_depth_check CHECK (depth >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_redemptions_depth_check') THEN
    ALTER TABLE invite_redemptions ADD CONSTRAINT invite_redemptions_depth_check CHECK (depth >= 0);
  END IF;
END $$;

-- 24 小时窗口计数的主查询：WHERE ip_hash = $1 AND redeemed_at > now() - interval '24 hours'
-- 没有这个索引时，每兑换一次都要扫全表（兑换是低频写，但计数发生在锁里，扫全表会拖长锁时间）。
CREATE INDEX IF NOT EXISTS invite_redemptions_ip_time_idx
  ON invite_redemptions (ip_hash, redeemed_at DESC);

-- 现有用户/历史兑换默认 depth=0（DEFAULT 已保证），这里不用回填 UPDATE：
-- 在迁移里对大表做 UPDATE 会让整表行版本翻新，而 DEFAULT 0 已经给出正确值。
