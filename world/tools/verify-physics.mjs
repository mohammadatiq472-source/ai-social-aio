#!/usr/bin/env node
/**
 * 物理验收套件 P1–P12（spec §7 / docs/world/verify-contract.md）。
 *
 * 分工：
 * - 用例的**判定逻辑**在 `src/verify/harness.ts`（physics-agent，已锁死，别改判定）
 * - 本文件负责**驱动与报告**：起静态服务 → 打开 ?verify=1 → 轮询 window.__verify → 打印结果
 *
 * 用法：
 *   node tools/verify-physics.mjs             # 跑全部
 *   node tools/verify-physics.mjs P6 P11      # 只跑指定用例（调试）
 *   node tools/verify-physics.mjs --url http://127.0.0.1:5199/   # 用已在跑的 dev server
 *
 * 为什么默认跑 dist/ 而不是 dev server：
 * 验收要测的是**要发布的那份产物**。dev server 有 HMR 注入、未压缩代码，跑出来的东西不一样。
 */
import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * 硬超时（契约要求 180s）。
 *
 * 允许环境变量覆盖，只为一件事：**自测失败路径**。
 * `tools/verify-physics-selftest.mjs` 要验"卡在 running 时会超时非零退出"，
 * 真等 180s 会让自测变成没人愿意跑的 3 分钟脚本，于是它会被跳过——
 * 而"没人跑的自测"等于没有自测。所以给一个显式出口，
 * 默认值仍然是契约的 180s，生产/CI 路径不受影响。
 */
const HARD_TIMEOUT_MS = Number(process.env['VERIFY_TIMEOUT_MS'] ?? 180_000);

// ── 参数解析 ──
const argv = process.argv.slice(2);
const urlIdx = argv.indexOf('--url');
const explicitUrl = urlIdx >= 0 ? argv[urlIdx + 1] : null;

/**
 * 用例 id 列表。
 *
 * 这里踩过一个坑，写下来免得回去：
 * 第一版是 `argv.filter((a, i) => ... && i !== urlIdx + 1)`。
 * 没传 `--url` 时 `urlIdx === -1`，于是 `urlIdx + 1 === 0`，
 * **第 0 个参数被当成 --url 的值排掉了** —— `node tools/verify-physics.mjs P6 P11`
 * 只跑 P11，而且打印"只跑：P11"，看起来像正常行为。
 * 现在显式算"哪些下标是 --url 的值"，而不是用 -1 的算术。
 */
const urlValueIndex = urlIdx >= 0 ? urlIdx + 1 : -1;
const only = argv
  .map((a, i) => ({ a, i }))
  .filter(({ a, i }) => i !== urlValueIndex && !a.startsWith('--') && /^P\d+$/i.test(a))
  .map(({ a }) => a.toUpperCase());

// ── 静态服务（用 dist/，与要发布的产物一致） ──
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function serve(root) {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    let p = rel === '' ? join(root, 'index.html') : join(root, rel);
    if (!existsSync(p) || !extname(p)) p = join(root, 'index.html');
    try {
      res.setHeader('Content-Type', MIME[extname(p)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(readFileSync(p));
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  let server = null;
  let baseUrl = explicitUrl;

  if (!baseUrl) {
    if (!existsSync('dist')) {
      console.error('找不到 dist/。先跑 `npm run build`，或用 --url 指向一个已在跑的服务。');
      process.exit(2);
    }
    const s = await serve('dist');
    server = s.server;
    baseUrl = `http://127.0.0.1:${s.port}/`;
  }

  const target = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}verify=1${
    only.length ? `&only=${only.join(',')}` : ''
  }`;
  console.log(`物理验收套件 P1–P12（spec §7）`);
  console.log(`目标：${target}`);
  if (only.length) console.log(`只跑：${only.join(' ')}`);
  console.log('');

  const browser = await chromium.launch({
    // 必须显式给 executablePath：Playwright 默认找 chromium_headless_shell-1255，本机没有。
    executablePath: chromiumLaunchOptions().executablePath,
    args: [
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      // P12 需要精确堆信息
      '--enable-precise-memory-info',
      // P12 必须能强制 GC：否则堆增量随 GC 时机在 0.5MB~16MB 之间乱跳，
      // 用例会变成"看运气"。实测这组参数能把 globalThis.gc 暴露出来。
      // 拿不到 gc 时 harness 会如实 SKIP，不会谎报通过。
      '--js-flags=--expose-gc',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  let report;
  try {
    await page.goto(target, { waitUntil: 'load' });

    // 轮询 window.__verify 直到 status 不再是 running。
    // 契约：单条用例抛异常也必须把报告推进到 done/crashed，不许停在 running。
    report = await page.waitForFunction(
      () => {
        const v = window.__verify;
        if (!v) return null;
        return v.status === 'running' ? null : v;
      },
      { timeout: HARD_TIMEOUT_MS, polling: 250 },
    ).then((h) => h.jsonValue());
  } catch (err) {
    const stuck = await page.evaluate(() => window.__verify ?? null).catch(() => null);
    await browser.close();
    server?.close();
    console.error(`\n超时或失败：${err instanceof Error ? err.message : String(err)}`);
    if (stuck) {
      console.error(`卡住时的进度：status=${stuck.status} 已完成 ${stuck.cases?.length ?? 0}/${stuck.total}`);
      for (const c of stuck.cases ?? []) console.error(`  ${c.pass ? '✓' : '✗'} ${c.id} ${c.measured}`);
    }
    if (pageErrors.length) console.error(`页面错误：\n  ${pageErrors.slice(0, 5).join('\n  ')}`);
    process.exit(1);
  }

  await browser.close();
  server?.close();

  // ── 报告 ──
  const cases = report.cases ?? [];
  /**
   * 期望的用例清单。
   *
   * 这里踩过一个坑：第一版用 `cases.map(c => c.id)` 当期望清单，
   * 于是"只返回 11 条"时循环只走 11 次、11 条全绿、打印 **全部通过：11/11**，
   * 靠最后那个 `total !== 12` 的判断才勉强 exit 1。
   * 屏幕上写着"全部通过"、退出码却是 1 —— 看日志的人会以为是环境抖动。
   *
   * 契约 §2 明写「total 必须是 12，少跑一条算失败」。所以期望清单必须来自
   * **契约**（P1..P12），不是来自**结果**。缺的那条要显式打成 ✗。
   */
  const CONTRACT_IDS = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
  const expected = only.length ? only : CONTRACT_IDS;
  const byId = new Map(cases.map((c) => [c.id, c]));

  let passCount = 0;
  let missing = 0;
  for (const id of expected) {
    const c = byId.get(id);
    if (!c) {
      missing += 1;
      console.log(`✗ ${id.padEnd(4)} （没有结果 —— 用例未执行，按契约算失败）`);
      continue;
    }
    if (c.pass) passCount += 1;
    const mark = c.pass ? '✓' : '✗';
    console.log(`${mark} ${c.id.padEnd(4)} ${String(c.title).padEnd(20)} ${c.measured}`);
    if (!c.pass) {
      if (c.error) console.log(`      error: ${c.error}`);
      const d = c.detail ?? {};
      const keys = Object.keys(d);
      if (keys.length) {
        console.log(`      detail: ${keys.map((k) => `${k}=${JSON.stringify(d[k])}`).join('  ')}`);
      }
    }
  }

  const total = expected.length;
  console.log('');
  if (pageErrors.length) {
    console.log(`页面错误（${pageErrors.length}）：`);
    for (const e of pageErrors.slice(0, 5)) console.log(`  ${e}`);
    console.log('');
  }

  const env = report.env ?? {};
  console.log(`环境：${env.renderer ?? '?'} / rapier ${env.rapierVersion ?? '?'}`);

  const allPassed = passCount === total && missing === 0;
  // 只有真的全绿才打印"全部通过"这一行。宁可让 CI 正则抓不到，也不要在失败时打印它——
  // 一个 grep "全部通过" 的 CI 会把 11/11 当成绿。
  if (allPassed) {
    console.log(`全部通过：${passCount}/${total}`);
  } else {
    const bits = [`${passCount}/${total} 通过`];
    if (missing > 0) bits.push(`缺 ${missing} 条`);
    console.log(`未全部通过：${bits.join('，')}`);
  }

  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
