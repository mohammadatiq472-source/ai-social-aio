-- ============================================================================
-- 数据库加固：events / invite_audit 只追加（owner + 最小 GRANT）
-- ----------------------------------------------------------------------------
-- 为什么需要这个文件：
--   deploy/bootstrap.sql 为了让应用能自动建表/跑迁移，会把 public 下所有表、
--   序列、函数的 owner 归位给 qqmini_app，并给 app 全表 SELECT/INSERT/UPDATE/DELETE。
--   这对业务表是对的，但对「唯一真相源」events 和审计表 invite_audit 是错的：
--   app 账号一旦泄漏/被注入，攻击者可以直接 UPDATE/DELETE 审计链，事件日志
--   就不能再证明任何事。代码约定（只 INSERT）挡不住 DBA 误操作或 SQL 注入。
--
-- 目标状态：
--   * events / invite_audit 的 owner = postgres（app 不是 owner，不能 DROP/ALTER/
--     TRUNCATE/建触发器）；
--   * qqmini_app 对两表只有 SELECT, INSERT（events 另需 sequence USAGE）；
--     没有 UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES；
--   * 会 UPDATE events 的 SECURITY DEFINER 投影函数 owner = postgres——
--     app 仍能 EXECUTE，函数以 postgres 身份完成 seq 回填；app 自己改不了 events。
--   * mcp_writer 的 events SELECT/INSERT 授权保持不动（[C4]）。
--
-- 前置条件：
--   * 以 postgres 超级用户执行（ALTER ... OWNER TO postgres / 改函数 owner 都需要）；
--   * 迁移已跑到 025（events、invite_audit、qm_apply_system_message、
--     qm_invite_audit_append_only、identity 序列都存在）；
--   * 推荐用 scripts/harden-db.mjs（默认 dry-run，--apply 才执行），不要手抄语句。
--
-- 幂等：所有 ALTER OWNER / REVOKE / GRANT / 动态函数 owner 循环都可重复执行。
-- 执行顺序（重要）：
--   deploy/bootstrap.sql → node scripts/migrate.mjs → node scripts/harden-db.mjs --apply
--   如果之后重跑了 bootstrap（它会重新把 owner 归位 app 并 GRANT ALL），必须重跑本文件。
--
-- 回滚（应急）：
--   BEGIN;
--     ALTER TABLE public.events OWNER TO qqmini_app;
--     GRANT ALL PRIVILEGES ON public.events TO qqmini_app;
--     ALTER TABLE public.invite_audit OWNER TO qqmini_app;
--     GRANT ALL PRIVILEGES ON public.invite_audit TO qqmini_app;
--     -- 若需恢复函数 owner（一般不必）：ALTER FUNCTION public.qm_apply_system_message(...) OWNER TO qqmini_app;
--   COMMIT;
--   回滚只用于紧急排障；它会重新打开审计链被改写的口子。
-- ============================================================================

BEGIN;

-- 0) 只允许超级用户执行：OWNER TO postgres 与跨角色 GRANT/REVOKE 都需要它。
--    放在事务里，失败不会留下半套权限。
DO $harden_guard$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'hardening 需要超级用户执行（current_user=%）', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'public.events 不存在：先跑 node scripts/migrate.mjs';
  END IF;
  IF to_regclass('public.invite_audit') IS NULL THEN
    RAISE EXCEPTION 'public.invite_audit 不存在：迁移 024 还没应用';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    RAISE EXCEPTION '角色 qqmini_app 不存在：这不是生产/演练库，拒绝执行';
  END IF;
END
$harden_guard$;

-- ---------------------------------------------------------------------------
-- 1) events：owner 归 postgres；app 只保留 SELECT + INSERT
-- ---------------------------------------------------------------------------
ALTER TABLE public.events OWNER TO postgres;

-- 先收全部，再只发两权：TRUNCATE/TRIGGER/REFERENCES 也一并收掉。
-- 注意：REVOKE ALL 不会影响 mcp_writer 的授权（那是另一个角色）。
REVOKE ALL PRIVILEGES ON TABLE public.events FROM qqmini_app;
GRANT SELECT, INSERT ON TABLE public.events TO qqmini_app;

-- 序列：app 的 INSERT 要用 nextval；owner 归 postgres 与表保持一致。
-- events 的 id 序列在 001 里固定命名为 events_id_seq。
ALTER SEQUENCE public.events_id_seq OWNER TO postgres;
GRANT USAGE, SELECT ON SEQUENCE public.events_id_seq TO qqmini_app;

-- ---------------------------------------------------------------------------
-- 2) 会 UPDATE events 的 SECURITY DEFINER 投影函数 → owner postgres
--
-- 生产实测 qm_apply_system_message 的 owner 是 qqmini_app：app 一旦失去
-- events 的 UPDATE 权限，这个函数就会在回填 seq 时 42501，系统消息全挂。
-- 所以必须先把函数 owner 提升到 postgres（SECURITY DEFINER 以 owner 身份运行），
-- 再收表权限。这里用 prosrc 动态找，不写死函数名——将来新增投影函数也不会漏。
--
-- 正则而不是 ILIKE '%UPDATE events%'：同时覆盖 `UPDATE public.events` 和多空格，
-- 又不会误伤 `UPDATE events_meta`（events 后必须是空白/语句结束）。
-- 只改 owner<>postgres 的函数；已是 postgres 的（qm_apply_message/qm_apply_feed）跳过。
-- ---------------------------------------------------------------------------
DO $harden_update_fns$
DECLARE
  r record;
  v_changed integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig,
           p.proname,
           p.prosecdef,
           pg_get_userbyid(p.proowner) AS owner_name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosrc ~* 'update[[:space:]]+(public\.)?events([[:space:]]|$)'
     ORDER BY p.proname, p.oid
  LOOP
    -- 这些函数必须是 SECURITY DEFINER（以 owner 身份 UPDATE events）。
    -- 若是普通函数，换 owner 也救不了 app：它会以 app 身份执行并 42501。
    -- 宁可让加固失败也不要留下“上线后系统消息全挂”的隐患。
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'harden: 函数 % 会 UPDATE events 但不是 SECURITY DEFINER，拒绝半加固', r.sig;
    END IF;

    IF r.owner_name <> 'postgres' THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', r.sig);
      v_changed := v_changed + 1;
      RAISE NOTICE 'harden: % (owner=% , UPDATE events) -> owner=postgres', r.sig, r.owner_name;
    END IF;

    -- 无论是否换 owner，都显式保证 app 能 EXECUTE：这些是 app 的写入窄口。
    -- 历史上 owner=app 时 ACL 可能只有 owner 项，ALTER OWNER 会把 app 的
    -- EXECUTE 一并带走（演练实测），不重发就会「加固后系统消息 permission denied」。
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO qqmini_app', r.sig);
  END LOOP;
  RAISE NOTICE 'harden: 共 % 个 UPDATE events 函数改为 postgres，全部已 GRANT EXECUTE -> qqmini_app', v_changed;
END
$harden_update_fns$;

-- ---------------------------------------------------------------------------
-- 3) invite_audit：owner 归 postgres；app 只保留 SELECT + INSERT
--    append-only 触发器函数也归 postgres（app 不再是 owner，不能
--    CREATE OR REPLACE / DROP FUNCTION / DROP TRIGGER 绕过 append-only）。
-- ---------------------------------------------------------------------------
ALTER TABLE public.invite_audit OWNER TO postgres;
ALTER FUNCTION public.qm_invite_audit_append_only() OWNER TO postgres;

REVOKE ALL PRIVILEGES ON TABLE public.invite_audit FROM qqmini_app;
GRANT SELECT, INSERT ON TABLE public.invite_audit TO qqmini_app;

-- identity 序列（id BIGINT GENERATED ... AS IDENTITY）：按依赖关系动态找，
-- 不写死序列名；app INSERT 时需要 USAGE，owner 与表一致归 postgres。
DO $harden_invite_seq$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS seq
      FROM pg_class c
      JOIN pg_depend d ON d.objid = c.oid AND d.deptype IN ('i', 'a')
     WHERE c.relkind = 'S'
       AND d.refobjid = 'public.invite_audit'::regclass
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO postgres', r.seq);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO qqmini_app', r.seq);
    RAISE NOTICE 'harden: sequence % owner=postgres, GRANT USAGE/SELECT -> qqmini_app', r.seq;
  END LOOP;
END
$harden_invite_seq$;

-- 触发器保持启用（只改函数 owner，不动 trigger 定义）。
-- 这里不做 DISABLE/ENABLE：trigger 本来就在，重复 ALTER 没意义。

COMMIT;
