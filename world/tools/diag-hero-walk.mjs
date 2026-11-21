// 诊断两个用户报告的问题：
//   1. 模型朝向反了（按 W 向前走，但身体朝后）
//   2. 动画卡在 idle（走路时不播 walk）
//
// 方法：真实按键驱动，同时读 hero 的 anim / speed / 朝向四元数，逐帧记录。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

await page.goto(`${BASE}?time=day`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__agentDebug === 'object', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.waitForFunction(
  () => {
    const c = document.querySelector('canvas');
    const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
    return !gl || !gl.isContextLost();
  },
  { timeout: 15000 },
).catch(() => {});
await page.waitForTimeout(5000);
await page.mouse.click(450, 600);
await page.waitForTimeout(300);

const hero = () =>
  page.evaluate(() => {
    const ad = window.__agentDebug?.read?.() ?? {};
    return ad.hero ?? null;
  });

const h0 = await hero();
console.log('=== 初始状态 ===');
console.log(JSON.stringify(h0, null, 2));

// 记录角色朝向（从场景里读 root.rotation.y）
const facing = () =>
  page.evaluate(() => {
    const d = window.__worldDebug;
    return d.heroFacing ? d.heroFacing() : null;
  });

console.log('\n=== 按 W 走 1.2 秒，逐帧采样 ===');
await page.keyboard.down('w');
const samples = [];
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(100);
  const h = await hero();
  const f = await facing();
  samples.push({
    i,
    anim: h?.anim,
    speed: h?.speed !== undefined ? +h.speed.toFixed(3) : null,
    pos: h?.pos?.map((v) => +v.toFixed(2)),
    facingY: f !== null ? +(f * 180 / Math.PI).toFixed(1) : null,
  });
}
await page.keyboard.up('w');
await page.waitForTimeout(400);

for (const s of samples) {
  console.log(
    `  t=${String(s.i * 100).padStart(4)}ms  anim=${String(s.anim).padEnd(5)}  speed=${String(s.speed).padStart(7)}  ` +
      `pos=${JSON.stringify(s.pos)}  facingY=${s.facingY}°`,
  );
}

const anyWalk = samples.some((s) => s.anim === 'walk' || s.anim === 'run');
const maxSpeed = Math.max(...samples.map((s) => s.speed ?? 0));
console.log('');
console.log(`${anyWalk ? '✓' : '✗'} 走动时动画切到 walk/run（实际采样到的 anim: ${[...new Set(samples.map((s) => s.anim))].join(', ')}）`);
console.log(`   最大 speed = ${maxSpeed.toFixed(3)}（moveThreshold 是 0.15）`);

await browser.close();
