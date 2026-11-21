// 对构建产物截图：这是 D7「部署前最后一道验证」——真实 dist 里角色到底出不出来。
// 只看构建日志和 0 报错是不够的：资产 404 时页面不报错，只是角色静默消失。
import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? 'dist';
const OUT = process.argv[3] ?? 'tmp/world-prod.png';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  let p = rel === '' ? join(ROOT, 'index.html') : join(ROOT, rel);
  if (!existsSync(p) || !extname(p)) p = join(ROOT, 'index.html');
  try {
    res.setHeader('Content-Type', MIME[extname(p)] ?? 'application/octet-stream');
    res.end(readFileSync(p));
  } catch {
    res.statusCode = 404;
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

// 等资产加载 + 若干帧。
//
// ⚠️ 为什么要等 context restored 再截图：
// headless SwiftShader 下，页面加载初期会经历一次 webglcontextlost → webglcontextrestored
// （约 1 秒空窗）。**在这个空窗里截图会得到一张全黑的图**，很容易被误判成"渲染坏了"。
// 实测：lost 期间截图 4KB 全黑；restored 之后 154KB 正常画面。
// 这条踩过，别再踩。
await page.waitForTimeout(2000);
await page
  .waitForFunction(() => {
    const c = document.querySelector('canvas');
    if (!c) return false;
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    // 拿不到 gl（比如已被 three 持有且不可重入）时，退化为"已等待足够久"
    if (!gl) return true;
    return !gl.isContextLost();
  }, { timeout: 20000 })
  .catch(() => { /* 超时也继续，下面会报告 pageErrors */ });

// 再等几帧让画面稳定（阴影、动画起始帧）
await page.waitForTimeout(6000);
await page.screenshot({ path: OUT });

// 自检：黑屏图会非常小（<20KB）。给个明确警告，避免"以为拍到了其实全黑"。
const shotBytes = statSync(OUT).size;
if (shotBytes < 20 * 1024) {
  console.error(
    `⚠️ 截图只有 ${Math.round(shotBytes / 1024)}KB，很可能是全黑（context lost 空窗）。` +
      `请用 tools/diag-drawcall-timeline.mjs 确认是否真的没出帧。`,
  );
}

console.log(JSON.stringify({
  screenshot: OUT,
  pageErrors: errors.slice(0, 5),
  failedRequests: failed.slice(0, 8),
}, null, 2));

await browser.close();
server.close();
process.exit(errors.length === 0 && failed.length === 0 ? 0 : 1);
