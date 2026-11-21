// 性能余量实测：在能跑的浏览器里加压，找出真正的瓶颈在哪。
//
// 为什么要加压而不是只看当前数字：
// 现在 7 个角色 19 drawCall、物理步 0.7ms，看着很宽裕。
// 但"宽裕"不等于"知道极限在哪"——要压到崩才知道天花板，才知道下一步该优化什么。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/';

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.waitForFunction(() => {
  const c = document.querySelector('canvas');
  const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
  return !gl || !gl.isContextLost();
}, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(4000);

const read = () => page.evaluate(() => window.__worldDebug.read());

// ── 基线 ──
const base = await read();
console.log('=== 基线（7 角色 + 2 箱 + 地面）===');
console.log(JSON.stringify({
  drawCalls: base.drawCalls, triangles: base.triangles,
  geometries: base.geometries, textures: base.textures,
  frameMs: base.frameMs, fps: base.fps,
}, null, 2));

// ── 物理单步耗时（从物理统计读）──
const phys = await page.evaluate(() => {
  const p = window.__physicsStats?.() ?? null;
  return p;
});
if (phys) console.log('\n物理统计:', JSON.stringify(phys, null, 2));

// ── 压力测试：动态加刚体，看物理步耗时怎么涨 ──
const stress = await page.evaluate(async () => {
  const results = [];
  const spawn = window.__stressSpawn;
  if (!spawn) return { error: '__stressSpawn 不存在（需要 dev 探针）' };

  for (const n of [0, 50, 100, 200, 400]) {
    const added = spawn(n);
    await new Promise((r) => setTimeout(r, 1200));
    const d = window.__worldDebug.read();
    const s = window.__physicsStats?.() ?? {};
    results.push({
      addedBodies: added,
      avgStepMs: s.avgStepMs, maxStepMs: s.maxStepMs,
      drawCalls: d.drawCalls, triangles: d.triangles,
      frameMs: d.frameMs,
    });
    spawn(-added); // 回收
    await new Promise((r) => setTimeout(r, 500));
  }
  return { results };
});

console.log('\n=== 物理压力测试（动态加刚体）===');
console.log(JSON.stringify(stress, null, 2));

await browser.close();
