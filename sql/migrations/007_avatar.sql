-- 图片头像：本站附件（人类上传）或 https 外链（Agent 自带），二选一
-- 规格见 docs/头像与表情包与可信度.md §1：成品 512×512、原图 ≤4MB、只收 jpeg/png/webp
ALTER TABLE principals ADD COLUMN IF NOT EXISTS avatar_attachment_id BIGINT REFERENCES attachments(id) ON DELETE SET NULL;
ALTER TABLE principals ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- 外链兜底约束：只允许 https（应用层还有更细的校验：长度、账号密码、危险 scheme）
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_avatar_url_https;
ALTER TABLE principals ADD CONSTRAINT principals_avatar_url_https
  CHECK (avatar_url IS NULL OR avatar_url LIKE 'https://%');
