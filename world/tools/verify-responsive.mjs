// D8「手机实测」的前置检查：不同视口下是否仍可操作、移动端降级是否生效。
// spec §8 要求中端手机 30fps @720p；这里只验**布局与降级规则**，fps 需真机。
import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? 'dist';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  let p = rel === '' ? join(ROOT, 'index.html') : join(ROOT, rel);
  if (!existsSync(p) || !extname(p)) p = join(ROOT, 'index.html');
  try {
    res.setHeader('Content-Type', MIME[extname(p)] ?? 'application/octet-stream');
    res.end(readFileSync(p));
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});

// 常见手机视口（CSS px）
const viewports = [
  { name: 'iPhone SE', width: 375, height: 667, dpr: 2 },
  { name: 'iPhone 14 Pro', width: 393, height: 852, dpr: 3 },
  { name: 'Pixel 7', width: 412, height: 915, dpr: 2.6 },
  { name: 'iPad mini', width: 744, height: 1133, dpr: 2 },
  { name: '桌面 1080p', width: 1920, height: 1080, dpr: 1 },
];

let fails = 0;
for (const v of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.dpr,
    isMobile: v.width < 800,
    hasTouch: v.width < 800,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    if (!c) return false;
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    return !gl || !gl.isContextLost();
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const r = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const rect = c?.getBoundingClientRect();
    return {
      canvasW: Math.round(rect?.width ?? 0),
      canvasH: Math.round(rect?.height ?? 0),
      bufW: c?.width ?? 0,
      bufH: c?.height ?? 0,
      docScrollW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      // 移动端降级：DPR 应被夹到 ≤1.6
      effectiveDpr: c ? c.width / Math.max(1, Math.round(rect?.width ?? 1)) : 0,
    };
  });

  // 断言
  const fillsViewport = r.canvasW >= v.width - 2 && r.canvasH >= v.height - 2;
  const noHScroll = r.docScrollW <= r.winW + 2;
  const dprClamped = v.width < 800 ? r.effectiveDpr <= 1.61 : true;

  const ok = fillsViewport && noHScroll && dprClamped && errors.length === 0;
  if (!ok) fails++;

  console.log(
    `${ok ? '✓' : '✗'} ${v.name.padEnd(14)} ${String(v.width).padStart(4)}x${String(v.height).padStart(4)}@${v.dpr}  ` +
      `canvas ${r.canvasW}x${r.canvasH} (buf ${r.bufW}x${r.bufH})  dpr=${r.effectiveDpr.toFixed(2)}` +
      `${fillsViewport ? '' : ' [不铺满]'}${noHScroll ? '' : ' [横向滚动]'}${dprClamped ? '' : ' [DPR 未夹到 1.6]'}` +
      `${errors.length ? ' [JS 错误: ' + errors[0] + ']' : ''}`,
  );

  await ctx.close();
}

await browser.close();
server.close();

console.log('');
console.log(fails === 0 ? `全部通过：${viewports.length}/${viewports.length}` : `失败：${fails}/${viewports.length}`);
process.exit(fails === 0 ? 0 : 1);
