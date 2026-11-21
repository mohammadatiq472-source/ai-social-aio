// 容量触发线巡检回归（P4）：脚本判级、退出码、状态文件、/healthz 读取。
//
// 为什么用「改阈值」而不是造一个 3 GB 的库：触发线是比例判断，把阈值压到真实值附近
// 就能覆盖 ok/warn/exceeded 三段，且不依赖数据量。媒体用临时目录造 2 MB 真实文件。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-capacity.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(3).toString('hex');
const TMP_MEDIA = path.join(ROOT, 'tmp', `capacity-media-${rnd()}`);

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function run(env = {}, args = ['--json']) {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'capacity-check.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
  let json = null;
  try {
    json = JSON.parse(String(out.stdout || '').trim().split('\n').pop());
  } catch { /* 非 JSON */ }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json };
}

const dbUrl = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';

const main = async () => {
  // 1) 默认阈值：真实环境应该 ok（本机库/媒体都远小于 3 GB / 20 GB）
  const base = run({ DATABASE_URL: dbUrl, MEDIA_DIR: path.join(ROOT, 'tmp', 'devmedia'), CAPACITY_STATE: path.join(ROOT, 'tmp', 'capacity-real.json') });
  check('默认阈值跑通，退出码 0（本机容量远低于触发线）', base.status === 0, `exit=${base.status} ${String(base.stderr).slice(0, 120)}`);
  check('输出是可解析的 JSON 报告（checkedAt/status/metrics）',
    Boolean(base.json) && typeof base.json.checkedAt === 'string' && base.json.status === 'ok'
      && typeof base.json.metrics?.db?.gb === 'number' && typeof base.json.metrics?.media?.gb === 'number',
    JSON.stringify(base.json && { status: base.json.status, db: base.json.metrics?.db?.gb, media: base.json.metrics?.media?.gb }));
  check('在线 WS 数能读到（/healthz/full 的 wsOnline）',
    typeof base.json?.metrics?.online?.count === 'number', `online=${JSON.stringify(base.json?.metrics?.online)}`);

  const dbGb = base.json?.metrics?.db?.gb || 0.0001;

  // 2) warn 区：阈值压到真实值的 90% 附近 → ratio ∈ [0.8, 1)
  const warn = run({
    DATABASE_URL: dbUrl,
    MEDIA_DIR: path.join(ROOT, 'tmp', 'devmedia'),
    CAP_DB_GB: String(dbGb * 1.1),
    CAPACITY_STATE: path.join(ROOT, 'tmp', 'capacity-warn.json'),
  });
  check('阈值压到 1/1.1 → warn 区，退出码 1', warn.status === 1 && warn.json?.status === 'warn',
    `exit=${warn.status} status=${warn.json?.status} ratio=${warn.json?.metrics?.db?.ratio}`);
  check('warn 会写出问题描述（人不用自己算比例）', (warn.json?.problems || []).some((p) => p.includes('阈值')),
    JSON.stringify(warn.json?.problems));

  // 3) exceeded：阈值远小于真实值
  const over = run({
    DATABASE_URL: dbUrl,
    MEDIA_DIR: path.join(ROOT, 'tmp', 'devmedia'),
    CAP_DB_GB: String(dbGb / 10),
    CAPACITY_STATE: path.join(ROOT, 'tmp', 'capacity-over.json'),
  });
  check('阈值远小于真实值 → exceeded，退出码 2', over.status === 2 && over.json?.status === 'exceeded',
    `exit=${over.status} ratio=${over.json?.metrics?.db?.ratio}`);

  // 4) 媒体目录：造一个 2 MB 真实文件，阈值 1 MB → 触发媒体那条线
  fs.mkdirSync(path.join(TMP_MEDIA, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(TMP_MEDIA, 'sub', 'blob.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
  const media = run({
    DATABASE_URL: dbUrl,
    MEDIA_DIR: TMP_MEDIA,
    CAP_MEDIA_GB: String(1 / 1024), // 1 MB
    CAPACITY_STATE: path.join(ROOT, 'tmp', 'capacity-media.json'),
  });
  check('媒体目录超阈值 → exceeded，且量到 1 个文件 / 2 MB',
    media.status === 2 && media.json?.metrics?.media?.status === 'exceeded'
      && media.json.metrics.media.files === 1
      && Math.round(media.json.metrics.media.bytes / 1024) === 2048,
    JSON.stringify(media.json?.metrics?.media));

  // 5) 状态文件：内容可读、阈值/时间戳齐全（/healthz 就靠它）
  const statePath = path.join(ROOT, 'tmp', 'capacity-over.json');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* ignore */ }
  check('状态文件按约定落盘（status/checkedAt/metrics/thresholds）',
    Boolean(state) && state.status === 'exceeded' && Boolean(state.checkedAt) && Boolean(state.thresholds?.dbGb),
    statePath);

  // 6) /healthz（本机）能读到巡检结果——监控面板不用另接一套。
  //    先按服务端同一个推导路径写一份默认阈值报告（<MEDIA_DIR 父目录>/capacity.json）。
  run({
    DATABASE_URL: dbUrl,
    MEDIA_DIR: path.join(ROOT, 'tmp', 'devmedia'),
    CAPACITY_STATE: path.join(ROOT, 'tmp', 'capacity.json'),
  }, []);
  const hz = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch(() => null);
  check('/healthz 带 capacity 块（status/checkedAt/ageMinutes/数值）',
    Boolean(hz?.capacity) && hz.capacity.status === 'ok' && typeof hz.capacity.checkedAt === 'string'
      && 'dbGb' in hz.capacity && 'mediaGb' in hz.capacity && 'ageMinutes' in hz.capacity,
    JSON.stringify(hz?.capacity));

  fs.rmSync(TMP_MEDIA, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exitCode = 1;
});
