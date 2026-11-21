-- 消息搜索（P0）：在「我可见的会话」里按关键词搜正文。
--
-- 为什么索引建在 events 上而不是 messages：
--   迁移 012 起 messages 是视图（messages_meta JOIN events），正文只存在
--   events.payload->>'body'。视图列上做 ILIKE 命中不了表达式索引，会退化成
--   「全量 events 扫描 + join」；所以表达式索引必须建在 events 的原始表达式上。
--   不新增冗余列 —— 那会回到「正文存两份」，正是 012 要消掉的浪费。
--
-- 为什么是 pg_trgm + GIN：
--   ILIKE '%关键词%' 前后都有通配符，B-tree 用不上；trigram 是唯一能命中的内置方案。
--   pg_trgm 按「字符」切三元组，中文同样可用（相邻两字即可组成 trigram）；
--   单字查询（<3 字符）trigram 选择度低，可能退化为顺序扫描 —— 慢但结果正确。
--   若实测召回/速度不够，再评估 pg_bigm / zhparser（需要另装扩展）。
--
-- 为什么不 CREATE INDEX CONCURRENTLY：
--   scripts/migrate.mjs 把每个文件包在事务里执行（CONCURRENTLY 不能在事务中跑）。
--   当前线上 events 仅数百行，锁表时间可忽略；上量后请手工用 CONCURRENTLY 重放同一份定义。
DO $mig$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    -- 只影响速度，不影响正确性：没有 pg_trgm 就退化为顺序扫描
    RAISE NOTICE 'pg_trgm 不可用，跳过消息搜索索引（ILIKE 仍可用，只是慢）';
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS events_message_body_trgm
        ON events USING gin ((payload->>'body') gin_trgm_ops)
        WHERE type = 'MessageSent'
    $idx$;
  END IF;
END $mig$;

-- 搜索还要按「我加入的会话」过滤 + 按事件 id 倒序分页：
-- conversation_members(principal_id) 已在迁移 008 建过；这里补 events 的 id 回表方向
-- （events_message_cursor_idx 是 (aggregate_id,id)，跨会话按 id 倒序用不上）。
-- events 主键已经能倒序扫；显式保留这条注释是为了说明「没有额外索引是刻意的」。
