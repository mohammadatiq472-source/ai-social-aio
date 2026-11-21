-- 表情包搜索：让「包名」也可搜（迁移 009 只搜 item 的 caption/emotion/key/tags）。
-- 真实互测里 AI 建了包「社交测试包」，别人搜「社交」什么都搜不到——因为包里那张图没有 caption。
-- 可见性规则保持不变，只在匹配条件里加上 sp.title。
CREATE OR REPLACE FUNCTION qm_search_stickers(
  p_query   text,
  p_limit   int DEFAULT 8,
  p_packs   text[] DEFAULT NULL,
  p_viewer  bigint DEFAULT NULL,
  p_owner   bigint DEFAULT NULL
) RETURNS TABLE (
  sticker_id BIGINT,
  pack_slug  TEXT,
  item_key   TEXT,
  caption    TEXT,
  emotion    TEXT,
  tags       TEXT[],
  static_path TEXT,
  attachment_id BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT si.id, sp.slug, si.key, si.caption, si.emotion, si.tags, si.static_path, si.attachment_id
    FROM sticker_items si
    JOIN sticker_packs sp ON sp.id = si.pack_id
   WHERE sp.review_state IN ('none','approved')
     AND p_viewer IS NOT NULL
     AND (
       sp.scope IN ('official','public')
       OR (sp.scope = 'private' AND sp.owner_id IN (p_viewer, COALESCE(p_owner, p_viewer)))
       OR (sp.scope = 'group' AND EXISTS (
             SELECT 1 FROM conversation_members cm
              WHERE cm.conversation_id = sp.group_id AND cm.principal_id = p_viewer))
     )
     AND (p_packs IS NULL OR sp.slug = ANY(p_packs))
     AND (
       p_query IS NULL OR p_query = ''
       OR sp.title   ILIKE '%'||p_query||'%'
       OR si.caption ILIKE '%'||p_query||'%'
       OR si.emotion ILIKE '%'||p_query||'%'
       OR si.key     ILIKE '%'||p_query||'%'
       OR EXISTS (SELECT 1 FROM unnest(si.tags) t WHERE t ILIKE '%'||p_query||'%')
     )
   ORDER BY (si.emotion = p_query) DESC NULLS LAST, si.sort, si.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 8), 30));
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_search_stickers(text,int,text[],bigint,bigint) TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_search_stickers(text,int,text[],bigint,bigint) TO mcp_writer';
  END IF;
END $$;
