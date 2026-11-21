// 验收用户报告的真实 bug：「跳一下之后动画就永久卡死」。
//
// 判据：真实按键跳一次，落地后再走动/静止，看 anim 状态与骨骼是否恢复。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));

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

const anim = () => page.evaluate(() => window.__agentDebug.read().hero?.anim ?? null);

/** 采样骨骼变化，判断动画是否真的在动。 */
const bonesMoving = () =>
  page.evaluate(async () => {
    const scene = window.__worldDebug.scene();
    let root = null;
    scene.traverse((o) => {
      if (o.name && o.name.startsWith('avatar:p:')) root = o;
    });
    if (!root) return { error: 'no hero' };
    let skinned = null;
    root.traverse((o) => {
      if (o.isSkinnedMesh && !skinned) skinned = o;
    });
    if (!skinned?.skeleton?.bones) return { error: 'no skeleton' };
    const bones = skinned.skeleton.bones;
    const base = bones.map((b) => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]);
    const maxDelta = new Array(bones.length).fill(0);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 33));
      bones.forEach((b, idx) => {
        const q = b.quaternion;
        const bs = base[idx];
        const d =
          Math.abs(q.x - bs[0]) + Math.abs(q.y - bs[1]) + Math.abs(q.z - bs[2]) + Math.abs(q.w - bs[3]);
        if (d > maxDelta[idx]) maxDelta[idx] = d;
      });
    }
    return {
      moving: maxDelta.filter((d) => d > 0.001).length,
      max: Math.max(...maxDelta),
    };
  });

let pass = 0;
const total = 5;

console.log('=== 1. 跳跃前的基线 ===');
const a0 = await anim();
const b0 = await bonesMoving();
console.log(`  anim=${a0}  骨骼移动 ${b0.moving}/41  最大变化 ${b0.max?.toFixed(3)}`);
if (a0 === 'idle' && b0.moving > 0) pass++;

console.log('\n=== 2. 按空格跳一次 ===');
await page.keyboard.press('Space');
await page.waitForTimeout(400);
const aJump = await anim();
console.log(`  跳跃中 anim=${aJump}`);

console.log('\n=== 3. 落地后等 5 秒（超过兜底时长 4s）===');
await page.waitForTimeout(5000);
const aAfter = await anim();
const bAfter = await bonesMoving();
console.log(`  anim=${aAfter}  骨骼移动 ${bAfter.moving}/41  最大变化 ${bAfter.max?.toFixed(3)}`);
const recovered = aAfter === 'idle' || aAfter === 'walk';
console.log(`  ${recovered ? '✓' : '✗'} 落地后回到正常状态（不是卡在 jump）`);
if (recovered) pass++;
const stillMoving = bAfter.moving > 0;
console.log(`  ${stillMoving ? '✓' : '✗'} 落地后骨骼仍在动（动画没冻住）`);
if (stillMoving) pass++;

console.log('\n=== 4. 跳完再走（关键：能不能恢复走路）===');
await page.keyboard.down('w');
await page.waitForTimeout(1200);
const aWalk = await anim();
await page.keyboard.up('w');
console.log(`  走动中 anim=${aWalk}`);
const canWalk = aWalk === 'walk' || aWalk === 'run';
console.log(`  ${canWalk ? '✓' : '✗'} 跳完能正常走路`);
if (canWalk) pass++;

console.log('\n=== 5. 连跳三次后再走 ===');
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
}
await page.keyboard.down('w');
await page.waitForTimeout(1200);
const aWalk3 = await anim();
await page.keyboard.up('w');
console.log(`  连跳三次后走动 anim=${aWalk3}`);
const ok3 = aWalk3 === 'walk' || aWalk3 === 'run';
console.log(`  ${ok3 ? '✓' : '✗'} 连跳三次后仍能正常走路`);
if (ok3) pass++;

console.log(`\nJS 错误: ${errs.length}`);
console.log(`\n全部通过：${pass}/${total}`);
await browser.close();
process.exit(pass === total ? 0 : 1);
