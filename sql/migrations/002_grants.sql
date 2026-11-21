-- 角色授权（与 deploy/bootstrap.sql 对齐；重复执行安全）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qqmini_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO qqmini_app';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mcp_writer') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO mcp_writer';
    EXECUTE 'GRANT SELECT, INSERT ON events TO mcp_writer';
    EXECUTE 'GRANT SELECT ON messages, principals, conversations, conversation_members, agents, agent_tokens, agent_cursors, attachments TO mcp_writer';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE events_id_seq TO mcp_writer';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '跳过授权：当前角色无权修改其它角色权限（应由超级用户执行）';
  WHEN undefined_object THEN
    RAISE NOTICE '跳过授权：角色不存在';
END $$;
