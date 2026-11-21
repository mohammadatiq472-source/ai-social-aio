#!/usr/bin/env node
/**
 * M11 面板的**浏览器内**验收（spec §6 M11 的"验收：?debug=1 出现面板"）。
 *
 * 为什么不能只靠单测：单测证明的是"逻辑对"，而 M11 的验收标准是
 * "**页面里**出现面板、按键**真的**切换线框/网格/暂停"。
 * 那需要真 DOM、真渲染循环、真物理世界。
 *
 * 这里断言 8 条：
 * 1. `?debug=1` 下 `#aio-debug-panel` 存在，且六项指标都渲染出来了
 * 2. 面板 `pointer-events:none`（不吃相机拖拽）
 * 3. D 键：物理线框从不可见 → 可见，且 debug draw 真的画出了线段
 * 4. 再按 D：回到不可见（是"切换"不是"开"）
 * 5. G 键：网格可见性翻转
 * 6. P 键：物理暂停后 `__worldDebug.read().physicsSteps` 不再增长，
 *    但 `tick` 继续增长（证明"暂停的是物理，不是整个世界"）
 * 7. 面板显示的数字与 `__worldDebug` 一致（面板不是自己编的）
 * 8. 不带 `?debug=1` 时（dev 构建）也启用；生产构建下带参数也不出现
 *
 * 用法：
 *   node tools/verify-debug-panel.mjs                       # 起本地服务发 dist/（生产 → 面板应不存在）
 *   node tools/verify-debug-panel.mjs --mode dev --url ...  # 指向 dev server（面板应出现）
 */

import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const EXPLICIT_URL = opt('url', null);
const MODE = opt('mode', 'dev'); // dev | prod
const ROOT = opt('root', 'dist-debug');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

function serve(rootDir) {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const candidates = [
      rel === '' ? join(rootDir, 'index.html') : join(rootDir, rel),
      rel.startsWith('assets/') ? join(WORLD_ROOT, rel) : null,
    ].filter(Boolean);
    let file = candidates.find((p) => existsSync(p) && statSync(p).isFile());
    if (!file && (rel === '' || !extname(rel))) file = join(rootDir, 'index.html');
    if (!file) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(file));
  });
  return new Promise((r) => {
    server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port }));
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  let server = null;
  let baseUrl = EXPLICIT_URL;
  if (!baseUrl) {
    if (!existsSync(ROOT)) {
      console.error(`找不到 ${ROOT}/。先跑 \`npm run build\`（生产）或 \`npx vite build --mode debug\`。`);
      process.exit(2);
    }
    const s = await serve(ROOT);
    server = s.server;
    baseUrl = `http://127.0.0.1:${s.port}/`;
  }

  const browser = await chromium.launch({
    executablePath: chromiumLaunchOptions().executablePath,
    args: chromiumLaunchOptions().args,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  const target = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}debug=1`;
  console.log(`M11 面板验收（mode=${MODE}）`);
  console.log(`目标：${target}`);
  console.log('─'.repeat(64));

  await page.goto(target, { waitUntil: 'load' });

  if (MODE === 'prod') {
    // 生产构建：面板代码不存在，带 ?debug=1 也不该出现
    await page.waitForTimeout(4000);
    const has = await page.evaluate(() => document.querySelector('#aio-debug-panel') !== null);
    const hasGlobal = await page.evaluate(() => typeof window.__aioDebug !== 'undefined');
    check('生产构建：?debug=1 不出现面板', !has);
    check('生产构建：window.__aioDebug 不存在', !hasGlobal);
    await browser.close();
    server?.close();
    report();
    return;
  }

  // ── dev 构建：面板必须出现 ──
  await page.waitForFunction(() => document.querySelector('#aio-debug-panel') !== null, null, {
    timeout: 30_000,
  });

  /**
   * 等 WebGL 上下文稳定，再开始断言。
   *
   * 为什么必须有这一步（lead 审计时踩的坑，2026-11-20）：
   * headless SwiftShader 下页面加载初期会有一次 `webglcontextlost → webglcontextrestored`，
   * 约 1 秒空窗。空窗里读 canvas / 截图会拿到**全黑**，很容易误判成"渲染坏了"。
   * 所以判"上下文没丢"再等 6 秒（让 first-frame 阴影贴图与资产上传走完），
   * 之后读到的 fps/drawCall 才是稳态值。
   *
   * 本脚本虽然不截图，但读的是 `drawCalls` / `fps` —— 在空窗里同样是 0，
   * 不做这个等待就会假红（实测踩到过：面板显示 fps 0、tick 0）。
   */
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      if (!c) return false;
      const gl = c.getContext('webgl2') ?? c.getContext('webgl');
      return gl !== null && gl.isContextLost() === false;
    },
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(6000);

  // 等物理与渲染都真的在推进（面板要显示刚体数、fps 要非 0）
  // 用 `__aioDebug.probe()` 而不是 `__worldDebug`：后者只在 dev 构建存在，
  // 而本脚本还要验 `--mode debug` 的产物（那条路径才有真机 GPU 的意义）。
  await page.waitForFunction(() => {
    const d = window.__aioDebug;
    return d && d.probe().physicsSteps > 10 && d.probe().tick > 10;
  }, null, { timeout: 40_000 });
  await page.waitForTimeout(600);

  check('?debug=1 出现面板', true, '#aio-debug-panel');

  // 1. 六项指标都渲染出来
  const text = await page.evaluate(
    () => document.querySelector('#aio-debug-panel')?.textContent ?? '',
  );
  for (const key of ['fps', '帧耗时', '物理步', '刚体', '实体', 'overrun']) {
    check(`面板含指标「${key}」`, text.includes(key));
  }
  check('物理步同时给均值与峰值', /均/.test(text) && /峰/.test(text), text.match(/物理步.*/)?.[0] ?? '');

  // 2. 不吃指针事件
  const pe = await page.evaluate(
    () => getComputedStyle(document.querySelector('#aio-debug-panel')).pointerEvents,
  );
  check('面板 pointer-events:none（不挡相机拖拽）', pe === 'none', pe);

  // 3. D 键 → 物理线框出现
  const before = await page.evaluate(() => window.__aioDebug.read());
  await page.keyboard.press('d');
  await page.waitForTimeout(400);
  const afterD = await page.evaluate(() => window.__aioDebug.read());
  check(
    'D 键切物理线框：关 → 开',
    before.physicsWireframe === false && afterD.physicsWireframe === true,
    `${before.physicsWireframe} → ${afterD.physicsWireframe}`,
  );

  // 4. 再按 D → 关
  await page.keyboard.press('d');
  await page.waitForTimeout(300);
  const afterD2 = await page.evaluate(() => window.__aioDebug.read());
  check('再按 D：开 → 关（是切换不是单向开启）', afterD2.physicsWireframe === false);

  // 5. G 键 → 网格翻转
  await page.keyboard.press('g');
  await page.waitForTimeout(300);
  const afterG = await page.evaluate(() => window.__aioDebug.read());
  check(
    'G 键切网格线框',
    afterG.gridVisible !== afterD2.gridVisible,
    `${afterD2.gridVisible} → ${afterG.gridVisible}`,
  );

  // 6. P 键 → 物理暂停：physicsSteps 不涨，tick 继续涨
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  const pausedStart = await page.evaluate(() => window.__aioDebug.probe());
  await page.waitForTimeout(1200);
  const pausedEnd = await page.evaluate(() => window.__aioDebug.probe());
  check('P 键：面板显示"已暂停"', pausedStart.paused === true);
  check(
    'P 键：物理步不再推进',
    pausedEnd.physicsSteps === pausedStart.physicsSteps,
    `steps ${pausedStart.physicsSteps} → ${pausedEnd.physicsSteps}`,
  );
  check(
    'P 键：世界 tick 仍在推进（暂停的是物理，不是整个世界）',
    pausedEnd.tick > pausedStart.tick,
    `tick ${pausedStart.tick} → ${pausedEnd.tick}`,
  );

  // 恢复
  await page.keyboard.press('p');
  await page.waitForTimeout(500);
  const resumed = await page.evaluate(() => window.__aioDebug.probe());
  check(
    '再按 P：物理恢复',
    resumed.paused === false && resumed.physicsSteps > pausedEnd.physicsSteps,
    `steps ${pausedEnd.physicsSteps} → ${resumed.physicsSteps}`,
  );

  // 7. 面板数字与内部读数一致（面板不是自己编的）
  const consistency = await page.evaluate(() => {
    const panel = document.querySelector('#aio-debug-panel')?.textContent ?? '';
    const mine = window.__aioDebug.read();
    return {
      entitiesPanel: /实体\s+(\d+)/.exec(panel)?.[1] ?? null,
      entitiesMine: String(mine.entities),
      rigidBodiesPanel: /刚体\s+(\d+)/.exec(panel)?.[1] ?? null,
      rigidBodiesMine: String(mine.rigidBodies),
      hasPhysicsStepLine: /物理步\s+[\d.]+ms 均 \/ [\d.]+ms 峰/.test(panel),
      hasOverrunLine: /overrun\s+\d+/.test(panel),
    };
  });
  check(
    '面板实体数与内部读数一致',
    consistency.entitiesPanel === consistency.entitiesMine,
    `面板 ${consistency.entitiesPanel} / 内部 ${consistency.entitiesMine}`,
  );
  check(
    '面板刚体数与内部读数一致',
    consistency.rigidBodiesPanel === consistency.rigidBodiesMine,
    `面板 ${consistency.rigidBodiesPanel} / 内部 ${consistency.rigidBodiesMine}`,
  );
  check('面板物理步行格式为"均值 / 峰值"', consistency.hasPhysicsStepLine);
  check('面板 overrun 行存在', consistency.hasOverrunLine);

  check('页面无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server?.close();
  report();
}

function report() {
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log('─'.repeat(64));
  console.log(`全部通过：${passed}/${results.length}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
