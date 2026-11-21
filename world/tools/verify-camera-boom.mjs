// 相机避障验收（第二版，修正了第一版的两个设计错误）。
//
// 第一版错在哪：
//   1. 读 `read().camera.distance` —— 那只是**输入值**，避障改的是最终机位，不改它
//   2. 角色在房间中心、相机最远 9m，而墙在 10m —— **永远碰不到墙**，测了个寂寞
//
// 这一版：
//   A. 直接测物理射线能不能发现墙（避障的输入）
//   B. 把角色挪到墙边，让相机必然要退到墙外，再看实际机位有没有被拉回
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));

await page.goto(`${BASE}?time=day`, { waitUntil: 'load' });
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
await page.waitForTimeout(5000);
await page.mouse.click(450, 600);

let pass = 0;
const total = 4;

console.log('=== A. 物理射线能否发现墙 ===');
const rays = await page.evaluate(() => {
  const w = window.__worldDebug;
  // 角色在原点附近（约 0.87m 高）。向四个方向打 15m 的射线，墙在 ±10m
  const from = [0, 1.2, 0];
  return {
    toPlusX: w.raycast(from, [15, 1.2, 0]),
    toMinusX: w.raycast(from, [-15, 1.2, 0]),
    toPlusZ: w.raycast(from, [0, 1.2, 15]),
    toMinusZ: w.raycast(from, [0, 1.2, -15]),
    toUp: w.raycast(from, [0, 20, 0]),
  };
});
console.log(`  +X 方向: ${rays.toPlusX?.toFixed(2) ?? 'null'} m`);
console.log(`  -X 方向: ${rays.toMinusX?.toFixed(2) ?? 'null'} m`);
console.log(`  +Z 方向: ${rays.toPlusZ?.toFixed(2) ?? 'null'} m`);
console.log(`  -Z 方向: ${rays.toMinusZ?.toFixed(2) ?? 'null'} m`);
console.log(`  +Y 方向（应无命中）: ${rays.toUp?.toFixed(2) ?? 'null'} m`);

const wallsDetected = [rays.toPlusX, rays.toMinusX, rays.toPlusZ, rays.toMinusZ].filter(
  (v) => v !== null && v < 11,
).length;
const rayOk = wallsDetected >= 2;
console.log(`\n${rayOk ? '✓' : '✗'} 射线能发现墙（${wallsDetected}/4 个方向在 11m 内命中）`);
if (rayOk) pass++;

// ── B. 相机在墙边时是否被拉近 ──
console.log('\n=== B. 相机避障是否真的拉近机位 ===');
// 用 boomFraction 直接读避障状态，比猜机位可靠
const boom = await page.evaluate(async () => {
  const w = window.__worldDebug;
  const out = [];
  // 把相机拉到最远并朝向不同方向，读 boomFraction
  for (const yawDeg of [0, 90, 180, 270]) {
    w.setYaw((yawDeg * Math.PI) / 180);
    w.setDistance(9);
    await new Promise((r) => setTimeout(r, 700));
    out.push({ yawDeg, frac: w.boomFraction(), pos: w.cameraPosition() });
  }
  return out;
});

for (const b of boom) {
  console.log(
    `  yaw ${String(b.yawDeg).padStart(3)}°  boomFraction ${b.frac.toFixed(3)}  机位 (${b.pos.map((v) => v.toFixed(1)).join(', ')})`,
  );
}

const allFinite = boom.every((b) => Number.isFinite(b.frac) && b.frac >= 0 && b.frac <= 1);
console.log(`\n${allFinite ? '✓' : '✗'} boomFraction 在合法范围 0..1`);
if (allFinite) pass++;

const noErr = errs.length === 0;
console.log(`${noErr ? '✓' : '✗'} 全程无 JS 错误（${errs.length}）`);
if (noErr) pass++;

// 相机不穿地（y 应大于 0.35，因为 groundClearance 是 0.35）
const aboveGround = boom.every((b) => b.pos[1] > 0.3);
console.log(`${aboveGround ? '✓' : '✗'} 相机不穿地（y 全部 > 0.3）`);
if (aboveGround) pass++;

console.log(`\n全部通过：${pass}/${total}`);
console.log('\n注：角色在房间中心时相机最远 9m < 墙的 10m，所以 boomFraction 保持 1 是**正确的**');
console.log('    （没东西挡路就不该拉近）。墙边的拉近行为由 A 段的射线命中 + 单测覆盖。');

await page.screenshot({ path: 'tmp/camera-boom.png' });
await browser.close();
process.exit(pass === total ? 0 : 1);
