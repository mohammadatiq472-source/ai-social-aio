// 诊断：anim 状态机说"walk"，但模型看起来是站姿 —— 动画到底播了没？
//
// 三层要分别验：
//   1. 状态机状态（animator.state）—— 说是什么
//   2. mixer 里实际在播的 action（权重 > 0 的那个）—— 真的播什么
//   3. 骨骼是否在动（采样某根骨头的旋转，看帧间是否变化）
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });

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
await page.mouse.click(400, 600);
await page.waitForTimeout(300);

// 从场景里找玩家化身，检查 mixer 与骨骼
const probe = () =>
  page.evaluate(() => {
    const THREE = window.__THREE__;
    const out = { found: false };
    // 遍历场景找 avatar:p:* 的根节点
    let root = null;
    const scene = window.__worldDebug?.scene?.() ?? null;
    if (!scene) return { error: 'scene 未暴露' };
    scene.traverse((o) => {
      if (o.name && o.name.startsWith('avatar:p:')) root = o;
    });
    if (!root) return { error: '找不到玩家化身' };
    out.found = true;
    out.rootName = root.name;

    // 找 SkinnedMesh 与它的 skeleton
    let skinned = null;
    root.traverse((o) => {
      if (o.isSkinnedMesh && !skinned) skinned = o;
    });
    if (skinned?.skeleton?.bones?.length) {
      const bones = skinned.skeleton.bones;
      // 采样 3 根骨头的旋转（大腿/小腿/手臂）
      out.bones = bones.slice(0, 3).map((b) => ({
        name: b.name,
        rot: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w].map((v) => +v.toFixed(4)),
      }));
      out.boneCount = bones.length;
    }
    return out;
  });

const p1 = await probe();
console.log('=== 场景探查 ===');
console.log(JSON.stringify(p1, null, 2));

// 静止时采样两次骨骼
const s1 = await probe();
await page.waitForTimeout(500);
const s2 = await probe();
const idleMoved = JSON.stringify(s1.bones) !== JSON.stringify(s2.bones);
console.log(`\n静止 500ms 内骨骼是否变化（idle 动画应该在播）: ${idleMoved ? '✅ 在动' : '❌ 不动'}`);

// 按 W 走，采样两次骨骼
await page.keyboard.down('w');
await page.waitForTimeout(400);
const w1 = await probe();
await page.waitForTimeout(400);
const w2 = await probe();
await page.keyboard.up('w');
const walkMoved = JSON.stringify(w1.bones) !== JSON.stringify(w2.bones);
console.log(`走动 400ms 内骨骼是否变化: ${walkMoved ? '✅ 在动' : '❌ 不动'}`);

console.log('\n=== 走动时骨骼 ===');
console.log(JSON.stringify(w1.bones, null, 2));

const anim = await page.evaluate(() => window.__agentDebug?.read?.()?.hero?.anim ?? null);
console.log(`\n状态机 anim = ${anim}`);

await browser.close();
