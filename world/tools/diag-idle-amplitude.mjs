// 测 idle clip 的实际动作幅度：是"幅度太小看不出"还是"根本没数据"。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });

await page.goto(`${BASE}?time=day`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__agentDebug === 'object', { timeout: 30000 });
await page.waitForTimeout(9000);

// 直接读 clip 的轨道数据：idle 到底有没有关键帧、幅度多大
const info = await page.evaluate(() => {
  const scene = window.__worldDebug.scene();
  let root = null;
  scene.traverse((o) => {
    if (o.name && o.name.startsWith('avatar:p:')) root = o;
  });
  if (!root) return { error: 'no hero' };

  // 从 mixer 拿不到 clip 列表，改从 animator 内部（已暴露 playingClips）
  // 直接采样骨骼在 1 秒内的最大角度变化
  let skinned = null;
  root.traverse((o) => {
    if (o.isSkinnedMesh && !skinned) skinned = o;
  });
  if (!skinned?.skeleton?.bones) return { error: 'no skeleton' };

  const bones = skinned.skeleton.bones;
  return {
    boneCount: bones.length,
    boneNames: bones.slice(0, 8).map((b) => b.name),
  };
});

console.log('骨骼信息:', JSON.stringify(info, null, 2));

// 连续采样 2 秒，记录每根骨头四元数的最大变化量
const track = await page.evaluate(async () => {
  const scene = window.__worldDebug.scene();
  let root = null;
  scene.traverse((o) => {
    if (o.name && o.name.startsWith('avatar:p:')) root = o;
  });
  let skinned = null;
  root.traverse((o) => {
    if (o.isSkinnedMesh && !skinned) skinned = o;
  });
  const bones = skinned.skeleton.bones;

  const baseline = bones.map((b) => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]);
  const maxDelta = new Array(bones.length).fill(0);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 33));
    bones.forEach((b, idx) => {
      const q = b.quaternion;
      const base = baseline[idx];
      const d =
        Math.abs(q.x - base[0]) +
        Math.abs(q.y - base[1]) +
        Math.abs(q.z - base[2]) +
        Math.abs(q.w - base[3]);
      if (d > maxDelta[idx]) maxDelta[idx] = d;
    });
  }

  const moving = maxDelta.filter((d) => d > 0.001).length;
  return {
    totalBones: bones.length,
    movingBones: moving,
    maxDeltaOverall: Math.max(...maxDelta),
    top5: maxDelta
      .map((d, i) => ({ name: bones[i].name, delta: +d.toFixed(5) }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 5),
  };
});

console.log('\n=== 静止 2 秒内的骨骼变化 ===');
console.log(`  骨骼总数 ${track.totalBones}，有变化的 ${track.movingBones} 根`);
console.log(`  最大变化量 ${track.maxDeltaOverall.toFixed(5)}`);
console.log('  变化最大的 5 根:', JSON.stringify(track.top5));

console.log('');
if (track.movingBones === 0) {
  console.log('❌ idle clip 完全没驱动骨骼（数据或权重问题）');
} else if (track.maxDeltaOverall < 0.01) {
  console.log('⚠️ idle 有动但幅度极小（<0.01 四元数差），肉眼几乎看不出');
} else {
  console.log('✅ idle 动画幅度正常，肉眼应该能看出呼吸/微动');
}

await browser.close();
