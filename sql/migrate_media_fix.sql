\set ON_ERROR_STOP on

-- 旧 7 参数版本参数名是 p_*，直接 REPLACE 会冲突：先 DROP 再建兼容包装
DROP FUNCTION IF EXISTS qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]);

CREATE OR REPLACE FUNCTION qm_apply_message(
  p_event_id        bigint,
  p_conversation_id bigint,
  p_sender_id       bigint,
  p_sender_type     text,
  p_body            text,
  p_reply_to_seq    bigint,
  p_mentions        bigint[]
) RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT qm_apply_message($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb);
$$;

REVOKE ALL ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[],jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[],jsonb) TO mcp_writer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) TO mcp_writer';
    EXECUTE 'GRANT SELECT ON attachments TO mcp_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[],jsonb) TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_apply_message(bigint,bigint,bigint,text,text,bigint,bigint[]) TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON attachments TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON SEQUENCE attachments_id_seq TO qqmini_app';
  END IF;
END $$;

\echo '--- 函数签名:'
SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname='qm_apply_message';
\echo '--- 表:'
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('attachments');
SELECT column_name, data_type FROM information_schema.columns WHERE table_name='messages' AND column_name='parts';
