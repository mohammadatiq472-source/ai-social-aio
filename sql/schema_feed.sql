-- 个人空间（说说 / 评论 / 点赞）
-- 与主库同库；写入同样只经 submit()，事件进 events（aggregate_type='feed'）。

CREATE TABLE IF NOT EXISTS feeds (
  id             BIGSERIAL PRIMARY KEY,
  author_id      BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  author_type    TEXT NOT NULL CHECK (author_type IN ('user','agent')),
  body           TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  visibility     TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('friends','private')),
  like_count     INT NOT NULL DEFAULT 0,
  comment_count  INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS feeds_author_idx ON feeds (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feeds_created_idx ON feeds (created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id          BIGSERIAL PRIMARY KEY,
  feed_id     BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  author_id   BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('user','agent')),
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_feed_idx ON comments (feed_id, created_at);

CREATE TABLE IF NOT EXISTS likes (
  feed_id    BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  author_id  BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_id, author_id)
);

-- 好友关系（个人空间的可见性依赖它；v1 只做单向接受）
CREATE TABLE IF NOT EXISTS friendships (
  user_id   BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  friend_id BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  status    TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending','accepted','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);

-- [C3] 权限：AI 角色对空间的写同样只走函数；先给读权限
GRANT SELECT ON feeds, comments, likes, friendships TO mcp_writer;

-- 投影函数：发布说说
CREATE OR REPLACE FUNCTION qm_apply_feed(
  p_event_id bigint, p_author_id bigint, p_author_type text, p_body text, p_visibility text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO feeds (author_id, author_type, body, visibility)
  VALUES (p_author_id, p_author_type, p_body, p_visibility)
  RETURNING id INTO v_id;
  UPDATE events SET seq = v_id, aggregate_id = v_id WHERE id = p_event_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION qm_apply_comment(
  p_event_id bigint, p_feed_id bigint, p_author_id bigint, p_author_type text, p_body text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO comments (feed_id, author_id, author_type, body)
  VALUES (p_feed_id, p_author_id, p_author_type, p_body)
  RETURNING id INTO v_id;
  UPDATE feeds SET comment_count = comment_count + 1 WHERE id = p_feed_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION qm_apply_feed(bigint,bigint,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION qm_apply_comment(bigint,bigint,bigint,text,text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_feed(bigint,bigint,text,text,text) TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_comment(bigint,bigint,bigint,text,text) TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_feed(bigint,bigint,text,text,text) TO mcp_writer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_comment(bigint,bigint,bigint,text,text) TO mcp_writer';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT ALL PRIVILEGES ON feeds, comments, likes, friendships TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON SEQUENCE feeds_id_seq, comments_id_seq TO qqmini_app';
  END IF;
END $$;
