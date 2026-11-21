-- 候补队列（2026-11-19，实例开放 A 方案）
--
-- 为什么是「申请 + 站务发码」而不是自助注册：当前没有邮箱/手机验证，
-- 自助注册等于给脚本开闸（几千个号几分钟就能造出来，然后私聊骚扰 / 占满目录 / 打满 AI 预算）。
-- 候补队列把「谁能进来」留在人手上，同时不必让运维手工加人。
--
-- 邮箱为什么存明文：站务看到地址才能把码发出去（我们没有 SMTP）。
-- 与 user_accounts.email 同一数据等级；额外存 email_hash 只用于「同邮箱重复申请」去重。
CREATE TABLE IF NOT EXISTS signup_waitlist (
    id bigserial PRIMARY KEY,
    email text NOT NULL,
    email_hash text NOT NULL,
    note text,
    ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    -- pending：待处理；approved：已发码；rejected：不通过（保留记录，避免被反复申请刷屏）
    status text DEFAULT 'pending' NOT NULL,
    invite_code_id bigint REFERENCES invite_codes(id) ON DELETE SET NULL,
    decided_by bigint REFERENCES principals(id) ON DELETE SET NULL,
    decided_at timestamp with time zone
);

ALTER TABLE signup_waitlist ADD CONSTRAINT signup_waitlist_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected'));

-- 同邮箱只允许一条「待处理」申请：重复提交是幂等的，不是新建一条
CREATE UNIQUE INDEX IF NOT EXISTS signup_waitlist_pending_email_idx
    ON signup_waitlist (email_hash) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS signup_waitlist_status_created_idx
    ON signup_waitlist (status, created_at DESC);

-- 单 IP 24 小时最多申请几条（防刷队列表），用 SQL 统计即可，不建额外表
CREATE INDEX IF NOT EXISTS signup_waitlist_ip_idx
    ON signup_waitlist (ip_hash, created_at);
