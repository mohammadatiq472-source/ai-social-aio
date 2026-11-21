-- S0 表情包：官方包（静态 SVG，走 /packs 静态目录）与用户包（走 attachments）
CREATE TABLE IF NOT EXISTS sticker_packs (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  owner_id     BIGINT REFERENCES principals(id),          -- NULL = 官方
  scope        TEXT NOT NULL DEFAULT 'private'
               CHECK (scope IN ('official','private','group','public')),
  group_id     BIGINT REFERENCES conversations(id),
  license      TEXT NOT NULL DEFAULT 'unknown'
               CHECK (license IN ('cc0','cc-by','exclusive','unknown')),
  cover_key    TEXT,
  item_count   INT NOT NULL DEFAULT 0,
  review_state TEXT NOT NULL DEFAULT 'none'
               CHECK (review_state IN ('none','pending','approved','rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sticker_items (
  id            BIGSERIAL PRIMARY KEY,
  pack_id       BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  attachment_id BIGINT REFERENCES attachments(id),   -- 用户上传的位图
  static_path   TEXT,                                 -- 官方包的仓库内路径（/packs/<slug>/<file>）
  tags          TEXT[] NOT NULL DEFAULT '{}',
  emotion       TEXT,
  caption       TEXT NOT NULL DEFAULT '',
  sort          INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pack_id, key),
  CHECK (attachment_id IS NOT NULL OR static_path IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sticker_items_tags_idx ON sticker_items USING gin (tags);
CREATE INDEX IF NOT EXISTS sticker_items_pack_idx ON sticker_items (pack_id, sort);

-- 检索：关键词命中 tags / caption / emotion / key，只返回调用者可见的包
CREATE OR REPLACE FUNCTION qm_search_stickers(
  p_query   text,
  p_limit   int DEFAULT 8,
  p_packs   text[] DEFAULT NULL
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
   WHERE sp.review_state IN ('none','approved')          -- rejected 永不出
     AND sp.scope IN ('official','public','private','group')
     AND (p_packs IS NULL OR sp.slug = ANY(p_packs))
     AND (
       p_query IS NULL OR p_query = ''
       OR si.caption ILIKE '%'||p_query||'%'
       OR si.emotion ILIKE '%'||p_query||'%'
       OR si.key ILIKE '%'||p_query||'%'
       OR EXISTS (SELECT 1 FROM unnest(si.tags) t WHERE t ILIKE '%'||p_query||'%')
     )
   ORDER BY (si.emotion = p_query) DESC NULLS LAST, si.sort, si.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 8), 30));
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT ALL PRIVILEGES ON sticker_packs, sticker_items TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON SEQUENCE sticker_packs_id_seq, sticker_items_id_seq TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_search_stickers(text,int,text[]) TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT SELECT ON sticker_packs, sticker_items TO mcp_writer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_search_stickers(text,int,text[]) TO mcp_writer';
  END IF;
END $$;
