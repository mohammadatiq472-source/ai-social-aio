-- 门控改造（评审任务书 §1~§7）：预算 + 令牌桶 + 熔断，不再用固定墙。
--
-- 背景：C10 门控原来按「AI 是刷屏机器」设计——固定 30s 冷却、默认日限 200、low 档必须被 @。
-- 对「AI 每天正经发几百条」的目标场景是系统性误伤，而且撞墙时只拿到一次失败调用，
-- Agent 不知道为什么、要等多久、现在上限是多少。
--
-- 本迁移只加「状态与配置」，判定逻辑在 submit.mjs；所有写都通过 SECURITY DEFINER 函数，
-- 因为 AI 的写事务是 mcp_writer（只能 INSERT events，不能直接 UPDATE 业务表）。

-- 1) 每 Agent 的额度配置（主人可调）
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bucket_capacity integer NOT NULL DEFAULT 5;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bucket_refill_per_min integer NOT NULL DEFAULT 10;
-- 熔断/人工暂停的原因（管理页要显示「为什么停了」，否则主人只会看到它不说话）
ALTER TABLE agents ADD COLUMN IF NOT EXISTS paused_reason text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS paused_at timestamptz;
-- 额度最近一次被修改的时间：Agent 侧据此判断「我读到的上限是不是过期了」
ALTER TABLE agents ADD COLUMN IF NOT EXISTS limits_changed_at timestamptz NOT NULL DEFAULT now();

-- 2) 默认日限 200 → 1000（任务书 §3）。旧默认值 200 的行一起提，但不动主人已经改过的其它值。
ALTER TABLE agents ALTER COLUMN daily_limit SET DEFAULT 1000;
UPDATE agents SET daily_limit = 1000 WHERE daily_limit = 200;

-- 3) 群级 AI 设置（任务书 §5）：每消息最多几个 AI 回、AI→AI 接力深度
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_relay_max_depth integer NOT NULL DEFAULT 2;

-- 4) 令牌桶状态：每 Agent × 每会话一行（tokens 是小数，按时间线性补充）
CREATE TABLE IF NOT EXISTS agent_buckets (
  agent_id        bigint NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tokens          numeric(10,3) NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, conversation_id)
);

-- 5) 取令牌（原子；mcp_writer 通过 EXECUTE 调用，不直接碰表）
CREATE OR REPLACE FUNCTION qm_take_agent_token(
  p_agent bigint,
  p_conversation bigint,
  p_capacity integer,
  p_refill_per_min integer
) RETURNS TABLE (allowed boolean, tokens numeric, retry_after_ms integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_cap   numeric := GREATEST(COALESCE(p_capacity, 5), 1);
  v_rate  numeric := GREATEST(COALESCE(p_refill_per_min, 0), 0);
  v_tokens numeric;
BEGIN
  INSERT INTO agent_buckets (agent_id, conversation_id, tokens, updated_at)
  VALUES (p_agent, p_conversation, v_cap, v_now)
  ON CONFLICT (agent_id, conversation_id) DO UPDATE
    SET tokens = LEAST(v_cap,
          agent_buckets.tokens
          + EXTRACT(EPOCH FROM (v_now - agent_buckets.updated_at)) / 60.0 * v_rate),
        updated_at = v_now
  RETURNING agent_buckets.tokens INTO v_tokens;

  IF v_tokens >= 1 THEN
    UPDATE agent_buckets SET tokens = v_tokens - 1
     WHERE agent_id = p_agent AND conversation_id = p_conversation;
    RETURN QUERY SELECT true, v_tokens - 1, 0;
  ELSE
    RETURN QUERY SELECT false, v_tokens,
      CASE WHEN v_rate <= 0 THEN 60000
           ELSE CEIL((1 - v_tokens) / v_rate * 60000)::int END;
  END IF;
END $fn$;

-- 6) 熔断：暂停 Agent（同样只能由函数改，AI 写事务没有 agents 的 UPDATE 权限）
CREATE OR REPLACE FUNCTION qm_pause_agent(p_agent bigint, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  UPDATE agents
     SET status = 'paused',
         paused_reason = COALESCE(p_reason, 'manual'),
         paused_at = now()
   WHERE principal_id = p_agent AND status <> 'revoked';
END $fn$;

-- 7) 授权
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qqmini_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent_buckets TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_take_agent_token(bigint,bigint,integer,integer) TO qqmini_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_pause_agent(bigint,text) TO qqmini_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
    -- AI 侧只需要这两个函数，不给 agent_buckets / agents 的直接 DML（C4 边界不变）
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_take_agent_token(bigint,bigint,integer,integer) TO mcp_writer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION qm_pause_agent(bigint,text) TO mcp_writer';
    -- 读额度快照需要读 agents/agent_buckets/conversations
    EXECUTE 'GRANT SELECT ON agent_buckets TO mcp_writer';
  END IF;
END $mig$;
