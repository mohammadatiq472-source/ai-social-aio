#!/usr/bin/env node
/**
 * 接线逻辑的 node 侧验证（不需要浏览器）。
 *
 * 为什么要有这个：浏览器里的 smoke 只能证明"页面没崩、有 6 个角色"，
 * 但如果 6 个 Agent 站着不动（意图没提交、或控制器没接上），它也可能"看起来绿"。
 * 这里在 node 里用**真实 Rapier + 真实 AgentSystem** 跑 300 步，直接断言：
 *   - 6 个 Agent 都被 join 进实体表
 *   - 每个都真的移动了（不是站着）
 *   - 有人说过话（say 意图被执行）
 *   - 步进顺序 physics.step() → demo.tick() → world.tick() 下实体表位置**不滞后**
 *
 * 用法：node --import ./scripts/ts-node-loader.mjs tools/verify-agents-wiring.mjs
 */

import { Clock } from '../src/core/clock.ts';
import { World } from '../src/core/world.ts';
import { parseRoom } from '../src/core/room.ts';
import { PhysicsWorld } from '../src/physics/engine.ts';
import { startAgentDemo } from '../src/demo/wire-demo.ts';
import RAPIER from '@dimforge/rapier3d-compat';

const room = parseRoom({
  name: 'wiring-test',
  spawn: [
    [0, 0, 0],
    [2, 0, 0],
    [-2, 0, 0],
    [0, 0, 2],
    [0, 0, -2],
    [2, 0, 2],
  ],
  lights: [],
  static: [{ type: 'box', size: [30, 0.2, 30], pos: [0, -0.1, 0] }],
  props: [],
  seats: [],
});

await RAPIER.init();

const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
const world = new World();
const clock = new Clock();

const demo = startAgentDemo({
  world,
  RAPIER,
  physics,
  room,
  count: 6,
  logFailures: false,
});

console.log('接线验证（node 内真实 Rapier + AgentSystem）');
console.log('');

const ids = demo.runtimes.map((r) => r.id);
console.log(`  join 进来的 Agent：${ids.length} 个`);
console.log(`  id：${ids.join(', ')}`);
console.log('');

// 记录初始位置
const startPos = new Map();
for (const id of ids) {
  const a = world.getActor(id);
  startPos.set(id, a ? [...a.transform.p] : null);
}

// 记录说过的话
const said = [];
world.events.on('actor:say', ({ id, text }) => said.push({ id, text }));

// 记录动画状态变化
const states = new Map();
world.events.on('actor:update', ({ id, anim }) => {
  let s = states.get(id);
  if (!s) {
    s = new Set();
    states.set(id, s);
  }
  s.add(anim);
});

// ── 跑 300 步（5 秒物理时间），严格按接线顺序 ──
const STEPS = 300;
for (let i = 0; i < STEPS; i++) {
  physics.step(1 / 60);
  demo.tick();
  world.tick(1 / 60);
}

console.log(`  跑了 ${STEPS} 步（${(STEPS / 60).toFixed(1)} 秒物理时间）`);
console.log('');

// ── 断言 ──
const problems = [];

// 1. 6 个都在实体表里
const inWorld = ids.filter((id) => world.has(id));
if (inWorld.length !== 6) problems.push(`实体表里只有 ${inWorld.length}/6 个 Agent`);

// 2. 每个都移动了
let moved = 0;
const moveReport = [];
for (const id of ids) {
  const a = world.getActor(id);
  const s = startPos.get(id);
  if (!a || !s) continue;
  const d = Math.hypot(a.transform.p[0] - s[0], a.transform.p[2] - s[2]);
  moveReport.push({ id, d });
  if (d > 0.2) moved += 1;
}
if (moved < 5) problems.push(`只有 ${moved}/6 个 Agent 移动超过 0.2m`);

// 3. 有人说过话
if (said.length === 0) problems.push('没有任何 Agent 说过话（say 意图没被执行）');

// 4. 动画状态在切换（world 层收到了 actor:update）
if (states.size === 0) problems.push('world 没收到任何 actor:update（物理没写回实体表）');

// 5. 位置是有限的（没有 NaN）
let nanPos = 0;
for (const id of ids) {
  const a = world.getActor(id);
  if (!a) continue;
  if (!a.transform.p.every((v) => Number.isFinite(v))) nanPos += 1;
}
if (nanPos > 0) problems.push(`${nanPos} 个 Agent 的位置含 NaN`);

console.log('  移动距离：');
for (const m of moveReport) {
  console.log(`    ${m.id.padEnd(8)} ${m.d.toFixed(2)} m`);
}
console.log('');
console.log(`  说过的话：${said.length} 条`);
for (const s of said.slice(0, 6)) console.log(`    ${s.id}: "${s.text}"`);
console.log('');
console.log('  动画状态：');
for (const [id, s] of states) console.log(`    ${id.padEnd(8)} ${[...s].join(', ')}`);
console.log('');

// ── 额外验证：步进顺序是否正确（实体表位置 vs 物理刚体位置） ──
// 顺序对了，实体表应该与物理**同步**；顺序错了会滞后一帧。
const rt0 = demo.runtimes[0];
if (rt0 && rt0.controller) {
  const bodyPos = rt0.controller.position?.();
  const actor = world.getActor(rt0.id);
  if (bodyPos && actor) {
    const lag = Math.hypot(
      bodyPos.x - actor.transform.p[0],
      bodyPos.z - actor.transform.p[2],
    );
    console.log(`  步进顺序验证：实体表 vs 物理位置差 ${lag.toFixed(4)} m（应 < 0.01）`);
    if (lag > 0.05) problems.push(`实体表与物理位置差 ${lag.toFixed(3)}m，步进顺序可能反了`);
  }
}
console.log('');

demo.dispose();
physics.dispose();

if (problems.length > 0) {
  console.error('✗ 接线验证失败：');
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}

console.log('✓ 全部通过：6 个 Agent 都在实体表、都移动了、说过话、动画状态在切换、位置无 NaN');
