#!/usr/bin/env bash
# AIO 容器入口：等数据库 → 迁移 → 幂等灌演示数据 → 起服务。
#
# 为什么把「迁移 + 演示数据」放在容器里而不是 compose 的额外 service：
#   首次 `docker compose up` 的用户只想要「打开就能玩」，不该先看三行命令再手动 seed；
#   这三步都幂等（migrate 记录 schema_migrations；seed-demo 群在就跳过），重启容器不会重复灌。
set -euo pipefail

: "${DATABASE_URL:?必须设置 DATABASE_URL（compose 里指向 db 服务）}"
DATABASE_URL_FOR_MIGRATE="${ADMIN_DATABASE_URL:-$DATABASE_URL}"

echo "[aio] 等待数据库就绪…"
node - <<'NODE'
const { Client } = require('pg');
const url = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 1; i <= 60; i += 1) {
    const c = new Client({ connectionString: url });
    try {
      await c.connect();
      await c.end();
      console.log('[aio] 数据库已就绪');
      return;
    } catch {
      try { await c.end(); } catch { /* ignore */ }
      if (i % 5 === 0) console.log(`[aio] 还在等数据库（${i}s）…`);
      await sleep(1000);
    }
  }
  console.error('[aio] 60 秒内连不上数据库，退出');
  process.exit(1);
})();
NODE

echo "[aio] 执行迁移…"
ADMIN_DATABASE_URL="$DATABASE_URL_FOR_MIGRATE" node scripts/migrate.mjs

echo "[aio] 灌演示数据（幂等，失败会非零退出）…"
node scripts/seed-demo.mjs

echo "[aio] 启动服务 :8787"
exec node src/index.mjs
