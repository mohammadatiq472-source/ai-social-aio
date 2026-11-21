import pg from 'pg';
import { config } from './config.mjs';

const { Pool } = pg;

// 连接级超时：pg 默认全 0（无限等）。一条被锁住的语句会永久占住 1/14 个槽，
// 槽满后全站挂起 —— 这里给上界，超时由应用兜底成错误而不是拖死进程。
const POOL_TIMEOUTS = {
  statement_timeout: 15_000,                     // 单条 SQL 最多 15s
  lock_timeout: 5_000,                           // 等锁最多 5s
  idle_in_transaction_session_timeout: 20_000,   // 事务里发呆 20s 就回收
  connectionTimeoutMillis: 5_000,                // 借连接最多等 5s
  query_timeout: 16_000,                         // 客户端侧兜底
};

// 业务连接池：人类侧读写；role=qqmini_app
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  ...POOL_TIMEOUTS,
});

// [C3] 受限连接池：role=mcp_writer。只能 INSERT events、SELECT 读模型、
// 以及 EXECUTE 投影函数（SECURITY DEFINER）。任何 UPDATE messages_meta 都会被数据库拒绝。
export const writerPool = new Pool({
  connectionString: config.writerDatabaseUrl,
  max: config.writerPoolMax,
  idleTimeoutMillis: 30_000,
  ...POOL_TIMEOUTS,
});

pool.on('error', (e) => console.error('[db] pool error', e.message));
writerPool.on('error', (e) => console.error('[db] writer pool error', e.message));

// ============================================================================
// 慢查询观测（P1-5）
//
// 目标：不引 Prometheus/Sentry，也能回答「慢在哪」。
//   * 业务池日志前缀 [db.slow]，writer 池 [db.slow.writer]；
//   * 只记录「执行耗时 + SQL 文本前 200 字」；
//   * **绝不记录参数**：正文、邀请码、token hash 都可能在 $1/$2 里，一旦进日志就是泄漏。
//
// 为什么包装 connect 而不是只包装 pool.query：
//   node-pg 的 pool.query 内部就是 `this.connect(cb)` → `client.query(...)`。
//   把借出的 client.query 包住，pool.query 与手写 withTx 两条路径就都覆盖了；
//   再单独包 pool.query 只用于兜住「连不上连接池」这类拿不到 client 的错误。
//
// 防重复包装：client 回池后会被再次借出；用 Symbol 标记，第二次直接复用，
// 否则同一 client 会套 N 层计时（日志重复 + 每次请求多一层闭包）。
// ============================================================================
const SLOW_WRAPPED = Symbol('qqmini.db.slowWrapped');
const slowErrorLogged = new WeakSet();

function sqlTextOf(q) {
  if (typeof q === 'string') return q;
  if (q && typeof q.text === 'string') return q.text;
  return '';
}

function logSlow(tag, text, ms, err) {
  const slow = ms >= config.dbSlowMs;
  if (!slow && !err) return;
  // 压成一行、截 200 字；参数一个都不带（这是隐私红线，不是可选项）
  const sql = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const payload = { ms, sql };
  if (err) {
    payload.code = err.code || null;
    // 不记 err.message：PG 的部分错误（如 invalid input syntax for type json）
    // 会把参数值回显到 message 里——那可能就是消息正文/邀请码。code + ms 足够定位。
    payload.error = err.name || 'Error';
    // 同一个错误会被 client 包装与 pool.query 兜底各看到一次，标记后只记一次
    slowErrorLogged.add(err);
  }
  // 单行 JSON：console.warn 直接传对象时 util.inspect 会在 80 列换行，
  // 日志采集/verify 都只能看到第一行（错误字段被折到后面）。JSON 一行，字段仍完整。
  console.warn(tag, JSON.stringify(payload));
}

function wrapClientQuery(client, tag) {
  if (client[SLOW_WRAPPED] === tag) return client; // 同一 client 再次借出：不重复包装
  const orig = client.query.bind(client);
  client.query = function wrappedClientQuery(...args) {
    const start = Date.now();
    const text = sqlTextOf(args[0]);
    const last = args.length - 1;
    if (last >= 0 && typeof args[last] === 'function') {
      // pg 的 callback 风格：在回调里记完成耗时（仓库目前全用 promise，这里只做兼容）
      const cb = args[last];
      args[last] = function (err, res) {
        logSlow(tag, text, Date.now() - start, err);
        return cb.apply(this, arguments);
      };
      return orig(...args);
    }
    let p;
    try {
      p = orig(...args);
    } catch (err) {
      logSlow(tag, text, Date.now() - start, err);
      throw err;
    }
    if (p && typeof p.then === 'function') {
      return p.then(
        (res) => { logSlow(tag, text, Date.now() - start, null); return res; },
        (err) => { logSlow(tag, text, Date.now() - start, err); throw err; },
      );
    }
    return p;
  };
  Object.defineProperty(client, SLOW_WRAPPED, { value: tag, configurable: true });
  return client;
}

function wrapPool(pool, tag) {
  // pool.query：只兜「借连接失败/排队超时」这类 client.query 覆盖不到的错误；
  // 成功路径由 client 包装计时（否则同一条 SQL 会打两条 [db.slow]）。
  const origQuery = pool.query.bind(pool);
  pool.query = function wrappedPoolQuery(...args) {
    const start = Date.now();
    const text = sqlTextOf(args[0]);
    let p;
    try {
      p = origQuery(...args);
    } catch (err) {
      logSlow(tag, text, Date.now() - start, err);
      throw err;
    }
    if (p && typeof p.then === 'function') {
      return p.catch((err) => {
        if (!slowErrorLogged.has(err)) logSlow(tag, text, Date.now() - start, err);
        throw err;
      });
    }
    return p;
  };

  const origConnect = pool.connect.bind(pool);
  pool.connect = function wrappedPoolConnect(...args) {
    if (typeof args[0] === 'function') {
      const cb = args[0];
      return origConnect(function (err, client, release) {
        if (client) wrapClientQuery(client, tag);
        return cb(err, client, release);
      });
    }
    const p = origConnect(...args);
    return p.then((client) => wrapClientQuery(client, tag));
  };
}

wrapPool(pool, '[db.slow]');
wrapPool(writerPool, '[db.slow.writer]');

/** 连接池水位：total/idle/waiting（不暴露连接串/账号） */
export function poolStats() {
  const snap = (p) => ({ total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount });
  return { app: snap(pool), writer: snap(writerPool) };
}


export async function query(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

// ============================================================================
// 命名预处理语句（读路径热点）
//
// 为什么需要：node-pg 默认发未命名语句，每条请求都要 Parse + 规划。审计实测
// 消息页 Planning 14.5ms / Execution 4.3ms、会话列表 8.5ms / 0.55ms —— 规划比执行还贵，
// 而且规划时间随参数分布抖动（参数化查询没有计划缓存）。用稳定 name 让 PG 按连接
// 准备一次，后续只发 Bind/Execute。连接池 max 10，首次各自准备一次是可接受成本。
//
// 坑（必须在这里兜住）：prepared statement 是**连接级**对象，node-pg 还会在客户端
// 按连接记账（connection.parsedStatements）。当服务端把语句丢了——PG 重启、后端被换掉、
// 有人在这条连接上执行 DEALLOCATE/DISCARD ALL——客户端记账还在，于是只发 Bind，
// 服务端回 26000 invalid_sql_statement_name。
//
// 恢复策略：**捕获 26000 后去掉 name 重试一次**（不是同名重试）。理由：同名重试时
// node-pg 的 submit() 看到客户端记账命中会跳过 Parse，再撞同一个 26000；要同名重建
// 只能去清 pg 的私有字段（connection.parsedStatements / submittedNamedStatements），
// 依赖内部实现太脆。未命名重试一定重新 Parse，代价只是这一条查询重新规划一次；
// 之后如果请求落到别的连接，那条连接会正常准备。语义与参数完全不变。
// ============================================================================
const PREPARED_STATEMENT_MISSING = '26000'; // PG: invalid_sql_statement_name

export async function readQuery(name, text, values = []) {
  try {
    return await pool.query({ name, text, values });
  } catch (err) {
    if (err?.code !== PREPARED_STATEMENT_MISSING) throw err;
    return pool.query({ text, values });
  }
}

async function runTx(p, fn) {
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* 连接已断则忽略 */ }
    throw err;
  } finally {
    client.release();
  }
}

// 人类侧事务（qqmini_app）
export function withTx(fn) {
  return runTx(pool, fn);
}

// [C3] AI 侧事务（mcp_writer）
export function withWriterTx(fn) {
  return runTx(writerPool, fn);
}

export async function closeDb() {
  await Promise.allSettled([pool.end(), writerPool.end()]);
}
