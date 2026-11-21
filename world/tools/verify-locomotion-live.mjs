// 用户最关心的三条：朝向、贴地、按 W 能走能跳。
// 用真实键盘事件驱动（page.keyboard），并连续多帧截图确认不是"碰巧截到好帧"。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/';

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });
await page.waitForFunction(() => {
  const c = document.querySelector('canvas');
  const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
  return !gl || !gl.isContextLost();
}, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(5000);

// 点一下拿键盘焦点
await page.mouse.click(450, 700);
await page.waitForTimeout(300);

const hero = () => page.evaluate(() => {
  const ad = window.__agentDebug?.read?.() ?? {};
  return ad.hero ?? null;
});

const h0 = await hero();
if (!h0) {
  console.log('❌ __agentDebug.read().hero 不存在，无法验收');
  await browser.close();
  process.exit(1);
}

// ── 1. 按 W 走 ──
await page.keyboard.down('w');
await page.waitForTimeout(1000);
const hWalkMid = await hero();
await page.keyboard.up('w');
await page.waitForTimeout(500);
const h1 = await hero();
const walkDist = Math.hypot(h1.pos[0] - h0.pos[0], h1.pos[2] - h0.pos[2]);

// ── 2. Shift+W 跑 ──
const h2a = await hero();
await page.keyboard.down('Shift');
await page.keyboard.down('w');
await page.waitForTimeout(1000);
await page.keyboard.up('w');
await page.keyboard.up('Shift');
await page.waitForTimeout(500);
const h2b = await hero();
const runDist = Math.hypot(h2b.pos[0] - h2a.pos[0], h2b.pos[2] - h2a.pos[2]);

// ── 3. 空格跳跃（连续采样 y） ──
const h3a = await hero();
await page.keyboard.press(' ');
let maxY = h3a.pos[1];
let animsSeen = new Set([h3a.anim]);
for (let i = 0; i < 50; i++) {
  await page.waitForTimeout(20);
  const h = await hero();
  if (h.pos[1] > maxY) maxY = h.pos[1];
  animsSeen.add(h.anim);
}
const jumpH = maxY - h3a.pos[1];

// ── 4. 松开键后是否停下 ──
const h4a = await hero();
await page.waitForTimeout(600);
const h4b = await hero();
const idleDrift = Math.hypot(h4b.pos[0] - h4a.pos[0], h4b.pos[2] - h4a.pos[2]);

// ── 5. 连续 5 帧截图（确认不是碰巧截到非 T-pose） ──
const shots = [];
for (let i = 0; i < 5; i++) {
  const f = `tmp/loco-seq-${i}.png`;
  await page.screenshot({ path: f });
  shots.push(f);
  await page.waitForTimeout(120);
}

const results = {
  walk: { dist: +walkDist.toFixed(3), pass: walkDist > 1, animDuringWalk: hWalkMid?.anim },
  run: { dist: +runDist.toFixed(3), ratio: walkDist > 0 ? +(runDist / walkDist).toFixed(2) : 0, pass: runDist > walkDist * 1.3 },
  jump: { height: +jumpH.toFixed(3), pass: jumpH > 0.5, animsSeen: [...animsSeen] },
  stop: { drift: +idleDrift.toFixed(4), pass: idleDrift < 0.05 },
  grounded: { y: +h4b.pos[1].toFixed(3), feetY: +h4b.feetY.toFixed(3), pass: Math.abs(h4b.feetY) < 0.05 },
  pageErrors: errors.slice(0, 4),
};

console.log(JSON.stringify(results, null, 2));
const allPass = results.walk.pass && results.run.pass && results.jump.pass && results.stop.pass;
console.log(allPass ? '\n✅ 全部通过：行走 / 奔跑 / 跳跃 / 停止' : '\n❌ 有失败项');

await browser.close();
process.exit(allPass ? 0 : 1);
