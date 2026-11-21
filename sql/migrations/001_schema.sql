--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: qm_apply_comment(bigint, bigint, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.qm_apply_comment(p_event_id bigint, p_feed_id bigint, p_author_id bigint, p_author_type text, p_body text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO comments (feed_id, author_id, author_type, body)
  VALUES (p_feed_id, p_author_id, p_author_type, p_body)
  RETURNING id INTO v_id;
  UPDATE feeds SET comment_count = comment_count + 1 WHERE id = p_feed_id;
  RETURN v_id;
END $$;


--
-- Name: qm_apply_feed(bigint, bigint, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.qm_apply_feed(p_event_id bigint, p_author_id bigint, p_author_type text, p_body text, p_visibility text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO feeds (author_id, author_type, body, visibility)
  VALUES (p_author_id, p_author_type, p_body, p_visibility)
  RETURNING id INTO v_id;
  UPDATE events SET seq = v_id, aggregate_id = v_id WHERE id = p_event_id;
  RETURN v_id;
END $$;


--
-- Name: qm_apply_message(bigint, bigint, bigint, text, text, bigint, bigint[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.qm_apply_message(p_event_id bigint, p_conversation_id bigint, p_sender_id bigint, p_sender_type text, p_body text, p_reply_to_seq bigint, p_mentions bigint[]) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  SELECT qm_apply_message($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb);
$_$;


--
-- Name: qm_apply_message(bigint, bigint, bigint, text, text, bigint, bigint[], jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.qm_apply_message(p_event_id bigint, p_conversation_id bigint, p_sender_id bigint, p_sender_type text, p_body text, p_reply_to_seq bigint, p_mentions bigint[], p_parts jsonb DEFAULT '[]'::jsonb) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_seq bigint;
  v_created timestamptz;
  v_depth int := 0;
BEGIN
  UPDATE conversations
     SET last_seq = last_seq + 1
   WHERE id = p_conversation_id
   RETURNING last_seq INTO v_seq;
  IF v_seq IS NULL THEN RAISE EXCEPTION 'conversation % not found', p_conversation_id; END IF;

  SELECT created_at INTO v_created FROM events WHERE id = p_event_id;
  IF v_created IS NULL THEN RAISE EXCEPTION 'event % not found', p_event_id; END IF;

  UPDATE events SET seq = v_seq WHERE id = p_event_id;

  IF p_reply_to_seq IS NOT NULL THEN
    SELECT CASE WHEN m.sender_type = 'agent' THEN m.relay_depth + 1 ELSE 0 END
      INTO v_depth
      FROM messages m
     WHERE m.conversation_id = p_conversation_id AND m.seq = p_reply_to_seq;
    v_depth := COALESCE(v_depth, 0);
  END IF;

  INSERT INTO messages (
    conversation_id, seq, event_id, sender_id, sender_type, kind, body,
    reply_to_seq, mentions, created_at, relay_depth, parts
  ) VALUES (
    p_conversation_id, v_seq, p_event_id, p_sender_id, p_sender_type, 'text', p_body,
    p_reply_to_seq, COALESCE(p_mentions, '{}'::bigint[]), v_created, v_depth,
    COALESCE(p_parts, '[]'::jsonb)
  );

  RETURN v_seq;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_cursors (
    agent_id bigint NOT NULL,
    client_label text DEFAULT 'default'::text NOT NULL,
    last_cursor bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tokens (
    id bigint NOT NULL,
    agent_id bigint NOT NULL,
    token_hash text NOT NULL,
    label text DEFAULT 'default'::text NOT NULL,
    client_info text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: agent_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_tokens_id_seq OWNED BY public.agent_tokens.id;


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    principal_id bigint NOT NULL,
    owner_user_id bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    can_initiate_dm boolean DEFAULT false NOT NULL,
    msgs_per_minute integer DEFAULT 20 NOT NULL,
    persona text DEFAULT ''::text NOT NULL,
    daily_limit integer DEFAULT 200 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    default_activity text DEFAULT 'low'::text NOT NULL,
    default_allow_relay boolean DEFAULT false NOT NULL,
    CONSTRAINT agents_default_activity_check CHECK ((default_activity = ANY (ARRAY['off'::text, 'low'::text, 'mid'::text, 'high'::text]))),
    CONSTRAINT agents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'revoked'::text])))
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id bigint NOT NULL,
    uploader_id bigint NOT NULL,
    kind text NOT NULL,
    mime text NOT NULL,
    bytes bigint NOT NULL,
    sha256 text NOT NULL,
    storage_key text NOT NULL,
    width integer,
    height integer,
    duration_ms integer,
    poster_key text,
    transcript text,
    transcript_state text DEFAULT 'none'::text NOT NULL,
    scan_state text DEFAULT 'clean'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT attachments_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'voice'::text, 'video'::text, 'file'::text, 'sticker'::text]))),
    CONSTRAINT attachments_scan_state_check CHECK ((scan_state = ANY (ARRAY['pending'::text, 'clean'::text, 'blocked'::text]))),
    CONSTRAINT attachments_transcript_state_check CHECK ((transcript_state = ANY (ARRAY['none'::text, 'pending'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attachments_id_seq OWNED BY public.attachments.id;


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id bigint NOT NULL,
    feed_id bigint NOT NULL,
    author_id bigint NOT NULL,
    author_type text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT comments_author_type_check CHECK ((author_type = ANY (ARRAY['user'::text, 'agent'::text]))),
    CONSTRAINT comments_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2000)))
);


--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.comments_id_seq OWNED BY public.comments.id;


--
-- Name: conversation_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_members (
    conversation_id bigint NOT NULL,
    principal_id bigint NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    reply_mode text DEFAULT 'low'::text NOT NULL,
    last_read_seq bigint DEFAULT 0 NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    allow_ai_relay boolean DEFAULT false NOT NULL,
    CONSTRAINT conversation_members_reply_mode_check CHECK ((reply_mode = ANY (ARRAY['off'::text, 'low'::text, 'mid'::text, 'high'::text]))),
    CONSTRAINT conversation_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id bigint NOT NULL,
    type text DEFAULT 'group'::text NOT NULL,
    title text,
    owner_id bigint,
    created_by bigint NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_daily_limit integer DEFAULT 600 NOT NULL,
    agent_round_quota integer DEFAULT 2 NOT NULL,
    CONSTRAINT conversations_type_check CHECK ((type = ANY (ARRAY['c2c'::text, 'group'::text])))
);


--
-- Name: conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversations_id_seq OWNED BY public.conversations.id;


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id bigint NOT NULL,
    type text NOT NULL,
    actor_id bigint NOT NULL,
    actor_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_msg_id text,
    seq bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idem_scope text,
    CONSTRAINT events_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'agent'::text]))),
    CONSTRAINT events_aggregate_type_check CHECK ((aggregate_type = ANY (ARRAY['conversation'::text, 'feed'::text, 'principal'::text])))
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;


--
-- Name: feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feeds (
    id bigint NOT NULL,
    author_id bigint NOT NULL,
    author_type text NOT NULL,
    body text NOT NULL,
    visibility text DEFAULT 'friends'::text NOT NULL,
    like_count integer DEFAULT 0 NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT feeds_author_type_check CHECK ((author_type = ANY (ARRAY['user'::text, 'agent'::text]))),
    CONSTRAINT feeds_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 4000))),
    CONSTRAINT feeds_visibility_check CHECK ((visibility = ANY (ARRAY['friends'::text, 'private'::text])))
);


--
-- Name: feeds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feeds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feeds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feeds_id_seq OWNED BY public.feeds.id;


--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    user_id bigint NOT NULL,
    friend_id bigint NOT NULL,
    status text DEFAULT 'accepted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT friendships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'blocked'::text])))
);


--
-- Name: group_digests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_digests (
    conversation_id bigint NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.likes (
    feed_id bigint NOT NULL,
    author_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_attempts (
    key text NOT NULL,
    failures integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    conversation_id bigint NOT NULL,
    seq bigint NOT NULL,
    event_id bigint NOT NULL,
    sender_id bigint NOT NULL,
    sender_type text NOT NULL,
    kind text DEFAULT 'text'::text NOT NULL,
    body text NOT NULL,
    reply_to_seq bigint,
    mentions bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    created_at timestamp with time zone NOT NULL,
    recalled_at timestamp with time zone,
    relay_depth integer DEFAULT 0 NOT NULL,
    parts jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT messages_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 4000))),
    CONSTRAINT messages_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'system'::text]))),
    CONSTRAINT messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['user'::text, 'agent'::text])))
);


--
-- Name: principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.principals (
    id bigint NOT NULL,
    type text NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    avatar_hue smallint DEFAULT 200 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    CONSTRAINT principals_type_check CHECK ((type = ANY (ARRAY['user'::text, 'agent'::text])))
);


--
-- Name: principals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.principals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: principals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.principals_id_seq OWNED BY public.principals.id;


--
-- Name: qm_replay_source; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.qm_replay_source AS
 SELECT id AS event_id,
    aggregate_id AS conversation_id,
    seq,
    actor_id AS sender_id,
    actor_type,
    (payload ->> 'body'::text) AS body,
    (NULLIF((payload ->> 'reply_to_seq'::text), ''::text))::bigint AS reply_to_seq,
        CASE
            WHEN (jsonb_typeof((payload -> 'mentions'::text)) = 'array'::text) THEN (ARRAY( SELECT jsonb_array_elements_text((events.payload -> 'mentions'::text)) AS jsonb_array_elements_text))::bigint[]
            ELSE '{}'::bigint[]
        END AS mentions,
    created_at
   FROM public.events
  WHERE (type = 'MessageSent'::text)
  ORDER BY id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    token_hash text NOT NULL,
    principal_id bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_accounts (
    principal_id bigint NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    algo text DEFAULT 'scrypt-1'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens ALTER COLUMN id SET DEFAULT nextval('public.agent_tokens_id_seq'::regclass);


--
-- Name: attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments ALTER COLUMN id SET DEFAULT nextval('public.attachments_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments ALTER COLUMN id SET DEFAULT nextval('public.comments_id_seq'::regclass);


--
-- Name: conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations ALTER COLUMN id SET DEFAULT nextval('public.conversations_id_seq'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);


--
-- Name: feeds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds ALTER COLUMN id SET DEFAULT nextval('public.feeds_id_seq'::regclass);


--
-- Name: principals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals ALTER COLUMN id SET DEFAULT nextval('public.principals_id_seq'::regclass);


--
-- Name: agent_cursors agent_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_cursors
    ADD CONSTRAINT agent_cursors_pkey PRIMARY KEY (agent_id, client_label);


--
-- Name: agent_tokens agent_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_pkey PRIMARY KEY (id);


--
-- Name: agent_tokens agent_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (principal_id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_sha256_uploader_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_sha256_uploader_id_key UNIQUE (sha256, uploader_id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: conversation_members conversation_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_pkey PRIMARY KEY (conversation_id, principal_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: feeds feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_pkey PRIMARY KEY (id);


--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (user_id, friend_id);


--
-- Name: group_digests group_digests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_digests
    ADD CONSTRAINT group_digests_pkey PRIMARY KEY (conversation_id);


--
-- Name: likes likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT likes_pkey PRIMARY KEY (feed_id, author_id);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (key);


--
-- Name: messages messages_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_event_id_key UNIQUE (event_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (conversation_id, seq);


--
-- Name: principals principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);


--
-- Name: principals principals_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_username_key UNIQUE (username);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: user_accounts user_accounts_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_accounts
    ADD CONSTRAINT user_accounts_email_key UNIQUE (email);


--
-- Name: user_accounts user_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_accounts
    ADD CONSTRAINT user_accounts_pkey PRIMARY KEY (principal_id);


--
-- Name: attachments_uploader_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_uploader_idx ON public.attachments USING btree (uploader_id, created_at DESC);


--
-- Name: comments_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_feed_idx ON public.comments USING btree (feed_id, created_at);


--
-- Name: events_agg_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_agg_idx ON public.events USING btree (aggregate_type, aggregate_id, seq);


--
-- Name: events_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_id_idx ON public.events USING btree (id);


--
-- Name: events_idem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX events_idem_idx ON public.events USING btree (actor_id, idem_scope, client_msg_id);


--
-- Name: events_idem_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_idem_lookup ON public.events USING btree (actor_id, idem_scope, client_msg_id) WHERE (client_msg_id IS NOT NULL);


--
-- Name: feeds_author_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feeds_author_idx ON public.feeds USING btree (author_id, created_at DESC);


--
-- Name: feeds_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feeds_created_idx ON public.feeds USING btree (created_at DESC);


--
-- Name: messages_parts_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_parts_gin ON public.messages USING gin (parts);


--
-- Name: sessions_principal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_principal_idx ON public.sessions USING btree (principal_id);


--
-- Name: agent_cursors agent_cursors_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_cursors
    ADD CONSTRAINT agent_cursors_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: agent_tokens agent_tokens_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: agents agents_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: agents agents_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_uploader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.principals(id);


--
-- Name: comments comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: comments comments_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id);


--
-- Name: conversations conversations_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.principals(id);


--
-- Name: events events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.principals(id);


--
-- Name: feeds feeds_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: friendships friendships_friend_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_friend_id_fkey FOREIGN KEY (friend_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: friendships friendships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: group_digests group_digests_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_digests
    ADD CONSTRAINT group_digests_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: likes likes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT likes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: likes likes_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.likes
    ADD CONSTRAINT likes_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: messages messages_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.principals(id);


--
-- Name: sessions sessions_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- Name: user_accounts user_accounts_principal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_accounts
    ADD CONSTRAINT user_accounts_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


