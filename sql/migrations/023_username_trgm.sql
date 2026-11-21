-- 目录搜索：用户名模糊匹配补 trigram 索引（性能审计 B 组 P1）
--
-- 背景：GET /api/directory?q= → src/core/query.mjs#directoryFor 的 WHERE 是
--   (p.display_name ILIKE '%q%' OR p.username ILIKE '%q%')
-- 008 已经给 display_name 建了 principals_name_trgm，username 只有唯一 btree
-- （principals_username_key，等值查询用，前后通配符的 ILIKE 用不上）。
-- OR 的两臂必须都能走索引才可能得到 BitmapOr；一臂没有 → 优化器只能
-- Seq Scan（或整棵索引全扫 + Filter），principals 变大后每次搜人都是全表扫。
--
-- 为什么照 008/013 的 DO/异常保护：pg_trgm 是 trusted extension，普通库主一般能建，
-- 但托管库有时禁止 CREATE EXTENSION。建不了就跳过索引——ILIKE 仍然正确，只是慢，
-- 不能因为这个功能性问题阻塞整条迁移链。
--
-- 为什么不 CREATE INDEX CONCURRENTLY：
--   scripts/migrate.mjs 把每个文件包在事务里执行，CONCURRENTLY 不能在事务中跑。
--   当前 principals 只有千级行，锁表时间可忽略；上量以后请手工用
--   CREATE INDEX CONCURRENTLY principals_username_trgm
--     ON principals USING gin (username gin_trgm_ops);
--   重放同一份定义（幂等：IF NOT EXISTS）。
--
-- 验证：node scripts/verify/verify-directory-trgm.mjs
--   （断言索引存在 + enable_seqscan=off 下 EXPLAIN 走 Bitmap Index Scan）
DO $mig$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm 不可用，跳过 username 模糊搜索索引（ILIKE 仍可用，只是慢）';
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS principals_username_trgm
        ON principals USING gin (username gin_trgm_ops)
    $idx$;
  END IF;
END $mig$;
