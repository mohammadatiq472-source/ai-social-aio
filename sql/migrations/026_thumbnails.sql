-- P1-6：图片缩略图（服务端派生 480px WebP + 签名 URL 变体）
--
-- 为什么把缩略图记在 attachments 上，而不是新建表：
--   缩略图是原图的**派生属性**（一图最多一张），读写都跟着附件走（/media/:id?v=thumb、
--   上传响应、/api/attachments）。单独建表只会让每次读附件多一次 join，而这里要的只是
--   「有没有、多大、什么尺寸」四个标量。
--
-- 为什么文件本体不进库、key 用原图 sha256：
--   [C5] 二进制只走存储驱动。缩略图 key 定为 `thumb/<原图 sha256>.webp`——同一份内容
--   只产出一张缩略图（跨用户去重天然成立），也不需要额外的 id 映射。
--
-- 为什么不进 events：
--   缩略图是读模型的缓存物，不是业务动作；丢了能按需重建（loadAttachmentMeta 的 on-demand
--   路径），所以不应该污染 append-only 事件日志。
--
-- 为什么四个列都可空：
--   迁移前的老图没有缩略图；请求 `v=thumb` 时按需生成并回填。生成失败（坏图/GIF/SVG）
--   保持 NULL，读路径回退原图，不 404。

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumb_key    TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumb_bytes  BIGINT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumb_width  INT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumb_height INT;
