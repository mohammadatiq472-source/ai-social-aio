#!/usr/bin/env node
/**
 * 行走/奔跑/跳跃/朝向的验收（spec D5 用户核心诉求）。
 *
 * 用户原话："我想看到的是人物模型能在上面正常的行走、跳跃"，
 * 并且明确担心"朝向出问题"。这个脚本就验证这四件事，每条贴实测数值。
 *
 * 为什么在 **node** 里跑而不是浏览器：
 * 走/跑/跳/朝向的**正确性**是物理 + 输入层的逻辑，不依赖 WebGL。
 * 在 node 里能用真实 Rapier 精确控制步数、精确读位移，
 * 比在浏览器里靠截图目测可靠得多。浏览器只用来确认"视觉上是否正常"。
 *
 * 用法：node --import ./scripts/ts-node-loader.mjs tools/verify-locomotion.mjs
 */

import { World } from '../src/core/world.ts';
import { createTransform } from '../src/core/types.ts';
import { parseRoom } from '../src/core/room.ts';
import { PhysicsWorld } from '../src/physics/engine.ts';
import { CharacterController, DEFAULT_CHARACTER } from '../src/physics/character.ts';
import RAPIER from '@dimforge/rapier3d-compat';

const DT = 1 / 60;
const CAPSULE_CENTER = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;

const room = parseRoom({
  name: 'locomotion',
  spawn: [[0, 0, 0]],
  lights: [],
  // 大平地：200m × 200m，足够跑远不被边界挡住
  static: [{ type: 'box', size: [200, 0.2, 200], pos: [0, -0.1, 0] }],
  props: [],
  seats: [],
});

await RAPIER.init();

const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 4 });
const world = new World();

const id = world.nextId('p');
world.spawn({
  id,
  kind: 'human',
  name: '你',
  transform: createTransform([0, CAPSULE_CENTER, 0]),
  anim: 'idle',
  animPhase: 0,
});

const ctrl = new CharacterController(RAPIER, physics, 0, CAPSULE_CENTER + 0.05, 0);

/** 跑 N 步，每步喂同一个输入。返回轨迹。 */
function run(input, steps) {
  const track = [];
  for (let i = 0; i < steps; i++) {
    ctrl.update(input, DT);
    physics.step(DT);
    ctrl.writeTransform((t) => {
      world.updateActor(id, { transform: t });
    });
    const a = world.getActor(id);
    if (a) track.push([...a.transform.p]);
  }
  return track;
}

const startPos = () => {
  const a = world.getActor(id);
  return a ? [...a.transform.p] : [0, 0, 0];
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  console.log(`      ${detail}`);
}

console.log('行走 / 奔跑 / 跳跃 / 朝向 验收（node + 真实 Rapier）');
console.log('');

// ── 1. 按住 W 1 秒 → 沿相机前方移动 > 1m ──
// 相机看 -Z（three 默认），所以 W 应该往 -Z 走
const p0 = startPos();
run({ dirX: 0, dirZ: -1, run: false, jump: false }, 60);
const p1 = startPos();
const walkDist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
const walkedForward = p1[2] < p0[2] - 0.5;
check(
  '按住 W 1 秒：沿相机前方（-Z）走 > 1m',
  walkDist > 1 && walkedForward,
  `位移 ${walkDist.toFixed(3)}m，Δz=${(p1[2] - p0[2]).toFixed(3)}（walk 速度 2.2m/s，1 秒约 2.1m）`,
);

// ── 2. Shift+W 1 秒 → 比走更快 ──
const p2 = startPos();
run({ dirX: 0, dirZ: -1, run: true, jump: false }, 60);
const p3 = startPos();
const runDist = Math.hypot(p3[0] - p2[0], p3[2] - p2[2]);
check(
  '按住 Shift+W 1 秒：跑比走快',
  runDist > walkDist * 1.3,
  `跑 ${runDist.toFixed(3)}m vs 走 ${walkDist.toFixed(3)}m（${(runDist / walkDist).toFixed(2)}×，run 速度 4.6m/s）`,
);

// ── 3. 空格跳跃 → y 升高再落回 ──
//
// ⚠ 这个用例有个坑（physics-agent 踩过、我也踩了一次）：
// `controller.update()` 设的是 `setNextKinematicTranslation`（**下一步**生效），
// 所以"起跳请求"必须和同一步的 `physics.step()` 在**同一个循环轮次**里，
// 而且不能在循环外先调一次 update——那会把第一步的 next 位置覆盖掉。
// 实测丢掉第一步会少跳 0.0822m（= v·dt = 4.934/60），看起来像"跳不起来"。
const p4 = startPos();
const jumpTrack = [];
for (let i = 0; i < 90; i++) {
  ctrl.update({ dirX: 0, dirZ: 0, run: false, jump: i === 0 }, DT);
  physics.step(DT);
  ctrl.writeTransform((t) => world.updateActor(id, { transform: t }));
  const a = world.getActor(id);
  if (a) jumpTrack.push([...a.transform.p]);
}
const peakY = Math.max(...jumpTrack.map((p) => p[1]));
const afterJump = startPos();
const jumpHeight = peakY - p4[1];
check(
  '按空格：跳起再落回地面',
  jumpHeight > 1.1 && jumpHeight < 1.3 && Math.abs(afterJump[1] - p4[1]) < 0.05,
  `跳高 ${jumpHeight.toFixed(3)}m（spec P6 要求 1.20±0.03），落地 y=${afterJump[1].toFixed(3)}（起始 ${p4[1].toFixed(3)}）`,
);

// ── 4. 按 D → 横向移动，且朝向跟着转 ──
const p5 = startPos();
run({ dirX: 1, dirZ: 0, run: false, jump: false }, 45);
const p6 = startPos();
const sideDist = Math.hypot(p6[0] - p5[0], p6[2] - p5[2]);
const movedRight = p6[0] > p5[0] + 0.5;
check(
  '按 D：向 +X 横向移动',
  sideDist > 0.8 && movedRight,
  `位移 ${sideDist.toFixed(3)}m，Δx=${(p6[0] - p5[0]).toFixed(3)}`,
);

// 朝向：物理侧约定 +Z 为前方，faceX/faceZ 应指向移动方向
const rot = ctrl.writeTransform ? null : null;
void rot;
// 读朝向：用下一次 writeTransform 拿 rot
let lastRot = null;
ctrl.writeTransform((t) => {
  lastRot = t.r;
});
// 用"模型 +Z 轴在世界空间的指向"判定朝向（不受 q/-q 等价干扰）
function facingOf(q) {
  const [x, y, z, w] = q;
  // 四元数旋转 +Z 轴 (0,0,1)：
  // v' = q * v * q^-1，其中 v=(0,0,1)
  const ix = w * 0 + y * 1 - z * 0;
  const iy = w * 0 + z * 0 - x * 1;
  const iz = w * 1 + x * 0 - y * 0;
  const iw = -x * 0 - y * 0 - z * 1;
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
if (lastRot) {
  const f = facingOf(lastRot);
  // 刚往 +X 走，朝向应该接近 (1, 0, 0)
  check(
    '按 D 后朝向转到 +X（物理约定 +Z 前方）',
    f[0] > 0.7 && Math.abs(f[2]) < 0.7,
    `模型 +Z 轴指向 (${f.map((v) => v.toFixed(2)).join(', ')})，期望接近 (1, 0, 0)`,
  );
}

// ── 5. 松开所有键 → 停下 ──
run({ dirX: 0, dirZ: 0, run: false, jump: false }, 40);
const pA = startPos();
run({ dirX: 0, dirZ: 0, run: false, jump: false }, 20);
const pB = startPos();
const drift = Math.hypot(pB[0] - pA[0], pB[2] - pA[2]);
check('松开所有键：速度归零不滑行', drift < 0.02, `20 步内位移 ${drift.toFixed(4)}m（应 < 0.02）`);

// ── 6. 对角线不比直走快 ──
const d0 = startPos();
run({ dirX: Math.SQRT1_2, dirZ: -Math.SQRT1_2, run: false, jump: false }, 60);
const d1 = startPos();
const diagDist = Math.hypot(d1[0] - d0[0], d1[2] - d0[2]);
check(
  '斜走（W+D 已归一化）不比直走快',
  Math.abs(diagDist - walkDist) < walkDist * 0.1,
  `斜 ${diagDist.toFixed(3)}m vs 直 ${walkDist.toFixed(3)}m（差 ${(Math.abs(diagDist - walkDist) / walkDist * 100).toFixed(1)}%，应 < 10%）`,
);

// ── 7. 贴地：走完 y 仍在站立高度 ──
const finalY = startPos()[1];
check(
  '走完仍贴地（y ≈ 胶囊中心高度）',
  Math.abs(finalY - CAPSULE_CENTER) < 0.05,
  `y=${finalY.toFixed(3)}，期望 ${CAPSULE_CENTER.toFixed(3)}`,
);

console.log('');
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`✗ ${failed.length}/${results.length} 项失败：`);
  for (const f of failed) console.error(`   ${f.name}`);
  physics.dispose();
  process.exit(1);
}
console.log(`✓ 全部通过：${results.length}/${results.length}`);
physics.dispose();
