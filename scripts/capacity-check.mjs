#!/usr/bin/env node
// ============================================================================
// scripts/capacity-check.mjs —— 容量触发线巡检（P4）
//
// 为什么要有它：数据库 3 GB / 媒体 20 GB / 在线 2000 是《容量与成本模型》§4 写死的
// 「必须升级」线。以前只能靠人去 `du`、`psql`，等发现时盘已经满了。这里把三条线
// 变成一条可 cron 的命令：量出来 → 判 ok/warn/exceeded → 写状态文件 → 退出码分级。
//
// 退出码（cron 靠它决定要不要发邮件/告警）：
//   0 = 全部 ok
//   1 = 有指标进入 warn 区（默认 ≥80% 阈值）
//   2 = 有指标已超过阈值（该升级/迁对象存储了）
//   3 = 量不出来（连不上库、目录读不了…）——也要人看
//
// 状态文件给 /healthz 读（local 请求才会带出来），所以监控面板不用另外接。
//
// 用法：
//   node scripts/capacity-check.mjs                 # 人读摘要 + 写状态文件
//   node scripts/capacity-check.mjs --json          # 只输出 JSON（给监控/脚本）
//   node scripts/capacity-check.mjs --help
//
// 环境变量（都有默认值）：
//   DATABASE_URL / ADMIN_DATABASE_URL   量库大小（默认 DATABASE_URL）
//   MEDIA_DIR                           媒体目录（默认 /opt/aio/data/media）
//   CAPACITY_STATE                      状态文件（默认 <MEDIA_DIR 的父目录>/capacity.json）
//   HEALTHZ_URL                         取在线 WS 数（默认 http://127.0.0.1:8787/healthz/full）
//   CAP_DB_GB=3  CAP_MEDIA_GB=20  CAP_ONLINE=2000  CAP_WARN_RATIO=0.8
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const GB = 1024 ** 3;
const MEDIA_DIR = process.env.MEDIA_DIR || '/opt/aio/data/media';
const STATE_FILE = process.env.CAPACITY_STATE || path.join(path.dirname(MEDIA_DIR), 'capacity.json');
const HEALTHZ_URL = process.env.HEALTHZ_URL || 'http://127.0.0.1:8787/healthz/full';
const DB_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || '';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const CAP = {
  dbGb: num(process.env.CAP_DB_GB, 3),
  mediaGb: num(process.env.CAP_MEDIA_GB, 20),
  online: num(process.env.CAP_ONLINE, 2000),
  warnRatio: Math.min(Math.max(Number(process.env.CAP_WARN_RATIO) || 0.8, 0.1), 0.99),
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法: node scripts/capacity-check.mjs [--json]');
  console.log('阈值: CAP_DB_GB=3 CAP_MEDIA_GB=20 CAP_ONLINE=2000 CAP_WARN_RATIO=0.8');
  process.exit(0);
}
const jsonOnly = argv.includes('--json');

/** 单指标判级：ok / warn / exceeded。ratio 用来让人一眼看出「离墙还有多远」。 */
function grade(value, threshold) {
  const ratio = value / threshold;
  if (ratio >= 1) return { ratio, status: 'exceeded' };
  if (ratio >= CAP.warnRatio) return { ratio, status: 'warn' };
  return { ratio, status: 'ok' };
}

/** 递归量目录体积。不跟符号链接（防止指到别处把整块盘算进来）。 */
async function dirSize(root, { maxSeconds = 20 } = {}) {
  const started = Date.now();
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    if ((Date.now() - started) / 1000 > maxSeconds) { truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 子目录被删/无权限：跳过，不算失败
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) continue;
      try {
        const st = await fs.promises.stat(full);
        bytes += st.size;
        files += 1;
      } catch { /* 文件刚好被清理：跳过 */ }
    }
  }
  return { bytes, files, truncated };
}

async function dbSize() {
  if (!DB_URL) return { bytes: null, error: 'no DATABASE_URL' };
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT pg_database_size(current_database())::bigint AS bytes');
    return { bytes: Number(rows[0].bytes) };
  } catch (err) {
    return { bytes: null, error: err.message };
  } finally {
    await client.end().catch(() => {});
  }
}

/** 在线 WS 数只在进程里（[C1] 单进程），脚本只能问本机的 /healthz/full。 */
async function onlineCount() {
  try {
    const res = await fetch(HEALTHZ_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { count: null, error: `healthz ${res.status}` };
    const body = await res.json();
    const n = Number(body?.wsOnline ?? body?.online?.count);
    return Number.isFinite(n) ? { count: n } : { count: null, error: 'healthz 没有 wsOnline' };
  } catch (err) {
    return { count: null, error: err.message };
  }
}

async function main() {
  const checkedAt = new Date().toISOString();
  const [db, media, online] = await Promise.all([dbSize(), dirSize(MEDIA_DIR), onlineCount()]);

  const metrics = {
    db: {
      bytes: db.bytes,
      gb: db.bytes == null ? null : db.bytes / GB,
      thresholdGb: CAP.dbGb,
      ...(db.bytes == null ? { status: 'unknown' } : grade(db.bytes / GB, CAP.dbGb)),
      ...(db.error ? { error: db.error } : {}),
    },
    media: {
      bytes: media.bytes,
      gb: media.bytes / GB,
      files: media.files,
      truncated: media.truncated,
      thresholdGb: CAP.mediaGb,
      ...grade(media.bytes / GB, CAP.mediaGb),
    },
    online: {
      count: online.count,
      threshold: CAP.online,
      ...(online.count == null ? { status: 'unknown' } : grade(online.count, CAP.online)),
      ...(online.error ? { error: online.error } : {}),
    },
  };

  const order = { unknown: 3, exceeded: 2, warn: 1, ok: 0 };
  let worst = 'ok';
  for (const m of Object.values(metrics)) {
    if (order[m.status] > order[worst]) worst = m.status;
  }

  const problems = [];
  for (const [name, m] of Object.entries(metrics)) {
    if (m.status === 'exceeded') problems.push(`${name} 超过触发线（${(m.ratio * 100).toFixed(0)}%）`);
    else if (m.status === 'warn') problems.push(`${name} 已到 ${(m.ratio * 100).toFixed(0)}% 阈值`);
    else if (m.status === 'unknown') problems.push(`${name} 量不出来：${m.error || '未知'}`);
  }

  const report = {
    checkedAt,
    status: worst,
    thresholds: { dbGb: CAP.dbGb, mediaGb: CAP.mediaGb, online: CAP.online, warnRatio: CAP.warnRatio },
    metrics,
    problems,
    stateFile: STATE_FILE,
  };

  // 状态文件先写 tmp 再 rename：/healthz 读到半个 JSON 会 500，比没有更糟
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    problems.push(`状态文件写不了：${err.message}`);
    report.stateFileError = err.message;
  }

  if (jsonOnly) {
    console.log(JSON.stringify(report));
  } else {
    const fmt = (m) => (m.bytes == null && m.count == null
      ? 'n/a'
      : (m.gb != null ? `${m.gb.toFixed(2)} GB` : `${m.count}`));
    console.log(`容量巡检 ${checkedAt} → ${worst}`);
    console.log(`  数据库 ${fmt(metrics.db)} / ${CAP.dbGb} GB（${metrics.db.status}）`);
    console.log(`  媒体   ${fmt(metrics.media)} / ${CAP.mediaGb} GB（${metrics.media.status}，${metrics.media.files} 个文件${metrics.media.truncated ? '，超时截断' : ''}）`);
    console.log(`  在线   ${fmt(metrics.online)} / ${CAP.online}（${metrics.online.status}）`);
    for (const p of problems) console.log(`  ! ${p}`);
    console.log(`  状态文件 ${STATE_FILE}`);
  }

  // 3 = 完全量不出来（比如库和在线都失败）才算环境问题；单个 unknown 仍按 exceeded/warn 走
  if (worst === 'unknown') process.exit(3);
  if (worst === 'exceeded') process.exit(2);
  if (worst === 'warn') process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(`容量巡检失败：${err.message}`);
  process.exit(3);
});
