// 打开构建产物，验证它真的能跑起来（不是只看构建绿）。
// 这是本项目最重要的一条纪律：涉及 WASM 的改动，构建绿 ≠ 能跑。
import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? 'dist';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  let p = rel === '' ? join(ROOT, 'index.html') : join(ROOT, rel);
  if (!existsSync(p) || !extname(p)) p = join(ROOT, 'index.html');
  try {
    res.setHeader('Content-Type', MIME[extname(p)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(p));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: [
    '--no-sandbox',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const failedRequests = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

// 给应用时间：加载资产 + 初始化物理 + 跑若干帧
await page.waitForTimeout(9000);

const probe = await page.evaluate(() => {
  const w = window;
  const out = {
    hasCanvas: !!document.querySelector('canvas'),
    debug: typeof w.__worldDebug === 'object' && w.__worldDebug !== null
      ? (typeof w.__worldDebug.read === 'function' ? w.__worldDebug.read() : w.__worldDebug)
      : null,
    assets: typeof w.__worldAssets === 'object' && w.__worldAssets !== null
      ? (typeof w.__worldAssets.measure === 'function' ? w.__worldAssets.measure() : 'present')
      : null,
    title: document.title,
  };
  return out;
});

// 量一次真实渲染帧率（SwiftShader 软渲染，仅代表"循环在跑"）
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => {
    n++;
    if (performance.now() - t0 > 2000) res(Math.round((n / (performance.now() - t0)) * 1000));
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

console.log(JSON.stringify({
  canvas: probe.hasCanvas,
  title: probe.title,
  debug: probe.debug,
  assets: probe.assets,
  rafFps: fps,
  pageErrors: errors.slice(0, 6),
  failedRequests: failedRequests.slice(0, 6),
}, null, 2));

await browser.close();
server.close();
process.exit(errors.length === 0 && probe.hasCanvas ? 0 : 1);
