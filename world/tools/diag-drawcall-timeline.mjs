// 关键诊断：prod 到底是"一直没画"还是"画了又被 context lost 抹掉"。
// 每 500ms 采样一次 draw call 累计数与 context 状态，画出时间线。
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// 在页面脚本之前埋钩子：统计所有 canvas 的 draw 调用 + 监听 context lost
await page.addInitScript(() => {
  const w = window;
  w.__dc = 0;
  w.__lost = 0;
  w.__restored = 0;
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = orig.call(this, type, attrs);
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__hooked) {
      ctx.__hooked = true;
      for (const m of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
        const fn = ctx[m];
        if (typeof fn === 'function') {
          ctx[m] = function (...a) { w.__dc++; return fn.apply(this, a); };
        }
      }
      this.addEventListener('webglcontextlost', () => { w.__lost++; });
      this.addEventListener('webglcontextrestored', () => { w.__restored++; });
    }
    return ctx;
  };
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

const timeline = [];
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({
    dc: window.__dc, lost: window.__lost, restored: window.__restored,
  }));
  timeline.push({ t: (i + 1) * 500, ...s });
}

console.log('时间线（每 500ms）:');
for (const r of timeline) {
  console.log(`  ${String(r.t).padStart(5)}ms  drawCalls=${String(r.dc).padStart(5)}  lost=${r.lost} restored=${r.restored}`);
}

const total = timeline.at(-1).dc;
console.log(`\n最终 drawCalls = ${total}`);
console.log(total === 0 ? '❌ 一帧都没画' : total < 50 ? '⚠️ 画了但极少' : '✅ 正常出帧');

await browser.close();
server.close();
