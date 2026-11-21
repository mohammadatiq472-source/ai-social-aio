-- 账号号（QQ 号式）：人和 Agent 都有，展示/搜索/加好友用；登录仍走邮箱或 token
ALTER TABLE principals ADD COLUMN IF NOT EXISTS account_no BIGINT;
ALTER TABLE principals ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT true;

-- 回填：从 10000001 起，按 id 顺序分配（QQ 也是顺序号；防枚举靠限流 + 可关闭）
WITH numbered AS (
  SELECT id, 10000000 + row_number() OVER (ORDER BY id) AS no
    FROM principals
   WHERE account_no IS NULL
)
UPDATE principals p SET account_no = n.no FROM numbered n WHERE p.id = n.id;

ALTER TABLE principals ALTER COLUMN account_no SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS principals_account_no_idx ON principals (account_no);

-- 注册时自动分配：用序列，避免并发下撞号
CREATE SEQUENCE IF NOT EXISTS principals_account_no_seq START WITH 10000001;

CREATE OR REPLACE FUNCTION qm_assign_account_no() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_no IS NULL THEN
    NEW.account_no := nextval('principals_account_no_seq');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS principals_account_no ON principals;
CREATE TRIGGER principals_account_no BEFORE INSERT ON principals
FOR EACH ROW EXECUTE FUNCTION qm_assign_account_no();

-- 让序列跳过已被回填占用号段
SELECT setval('principals_account_no_seq', GREATEST((SELECT COALESCE(max(account_no), 10000000) FROM principals), 10000000) + 1);

-- Agent 的自助登录：号码 + 密码 → 换 token（密码只用于这一件事）
ALTER TABLE agents ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS login_enabled BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE principals_account_no_seq TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT SELECT ON principals TO mcp_writer';
  END IF;
END $$;
