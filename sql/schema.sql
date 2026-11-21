-- QQ-mini schema v1
-- 单机 PostgreSQL 16；所有写只经 submit()；events 是唯一真相源。
-- 本文件由 scripts/migrate.mjs 按顺序执行（幂等：全部 IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS principals (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('user','agent')),
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_hue   SMALLINT NOT NULL DEFAULT 200,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_accounts (
  principal_id  BIGINT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  algo          TEXT NOT NULL DEFAULT 'scrypt-1',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  principal_id     BIGINT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  owner_user_id    BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
  can_initiate_dm  BOOLEAN NOT NULL DEFAULT false,
  can_leave_group  BOOLEAN NOT NULL DEFAULT false,
  msgs_per_minute  INT NOT NULL DEFAULT 20,
  persona          TEXT NOT NULL DEFAULT '',
  daily_limit      INT NOT NULL DEFAULT 200,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           BIGSERIAL PRIMARY KEY,
  agent_id     BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  label        TEXT NOT NULL DEFAULT 'default',
  client_info  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS conversations (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'group' CHECK (type IN ('c2c','group')),
  title      TEXT,
  owner_id   BIGINT REFERENCES principals(id),
  created_by BIGINT NOT NULL REFERENCES principals(id),
  last_seq   BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  principal_id    BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  reply_mode      TEXT NOT NULL DEFAULT 'mention' CHECK (reply_mode IN ('mention','free','off')),
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, principal_id)
);

CREATE TABLE IF NOT EXISTS events (
  id             BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('conversation','feed')),
  aggregate_id   BIGINT NOT NULL,
  type           TEXT NOT NULL,
  actor_id       BIGINT NOT NULL REFERENCES principals(id),
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('user','agent')),
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_msg_id  TEXT,
  seq            BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (actor_id, client_msg_id)
);

CREATE INDEX IF NOT EXISTS events_agg_idx ON events (aggregate_type, aggregate_id, seq);
CREATE INDEX IF NOT EXISTS events_id_idx  ON events (id);

CREATE TABLE IF NOT EXISTS messages (
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  event_id        BIGINT NOT NULL UNIQUE REFERENCES events(id),
  sender_id       BIGINT NOT NULL REFERENCES principals(id),
  sender_type     TEXT NOT NULL CHECK (sender_type IN ('user','agent')),
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','system')),
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  reply_to_seq    BIGINT,
  mentions        BIGINT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL,
  recalled_at     TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_cursors (
  agent_id     BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  client_label TEXT NOT NULL DEFAULT 'default',
  last_cursor  BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, client_label)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  principal_id BIGINT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_principal_idx ON sessions (principal_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  failures     INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_digests (
  conversation_id BIGINT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  last_seq        BIGINT NOT NULL DEFAULT 0,
  summary         TEXT NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
