-- 邮箱验证（2026-11-19）
--
-- 默认不启用：只有配了 SMTP_* 才生效（见 src/mail.mjs 的 emailVerifySettings）。
-- 所以这张表和这个列在「没配 SMTP」的实例上永远是空的/为 NULL，不影响任何既有行为。
--
-- 为什么令牌单独一张表，而不是在 user_accounts 上加一个 token 列：
--   a) 要能「单次、有有效期、可重发」——列存法每次重发都会覆盖旧值，
--      用户点上一封邮件里的链接就无法区分「已被替换」和「本来就无效」；
--   b) 要能审计「这个账号 24 小时发了几封」——限流靠它；
--   c) 库里只存哈希：即使拿到库也换不出可用链接（与 agent_tokens 同一套口径）。
CREATE TABLE IF NOT EXISTS email_verifications (
    id bigserial PRIMARY KEY,
    principal_id bigint NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    -- sha256(明文令牌)：明文只在邮件链接里出现一次
    token_hash text NOT NULL UNIQUE,
    -- 收件地址快照：之后用户改邮箱也不影响「这封信是发给谁的」这条审计事实
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS email_verifications_principal_idx
    ON email_verifications (principal_id, created_at DESC);

-- 账号级「已验证」时间戳。NULL = 从未验证过（未配 SMTP 的实例恒为 NULL）。
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS email_verified_at timestamp with time zone;
