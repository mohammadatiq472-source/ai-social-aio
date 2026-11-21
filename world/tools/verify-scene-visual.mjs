// 场景优化验收：房间是否成立、接触阴影是否生效、性能是否退化。
// 独立于 scene-agent 的脚本，避免"自己验自己"。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';
import { statSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());

async function shot(tag, query) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(`${BASE}?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
      return !gl || !gl.isContextLost();
    },
    { timeout: 15000 },
  ).catch(() => {});
  await page.waitForTimeout(5500);
  await page.mouse.click(500, 650);
  await page.waitForTimeout(800);

  const stats = await page.evaluate(() => window.__worldDebug.read());
  const f = `tmp/scene-${tag}.png`;
  await page.screenshot({ path: f });
  await page.close();
  return { f, kb: Math.round(statSync(f).size / 1024), stats, errs };
}

console.log('=== 场景验收 ===');
for (const [tag, q] of [
  ['day', 'time=day'],
  ['night', 'time=night'],
  ['storm', 'time=storm'],
  ['face', 'time=day&cam=face'],
]) {
  const r = await shot(tag, q);
  console.log(
    `${tag.padEnd(6)} drawCall ${String(r.stats.drawCalls).padStart(3)}  ` +
      `triangles ${String(r.stats.triangles).padStart(7)}  ` +
      `geometries ${String(r.stats.geometries).padStart(3)}  ` +
      `贴图 ${String(r.stats.textures).padStart(3)}  ` +
      `${r.kb}KB  错误 ${r.errs.length}`,
  );
  if (r.errs.length) console.log('   ', r.errs.slice(0, 2).join(' | '));
}

await browser.close();
