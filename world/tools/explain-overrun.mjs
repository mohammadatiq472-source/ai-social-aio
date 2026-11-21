#!/usr/bin/env node
/**
 * overrun 的解释工具：给定帧率，算出 overrun 的理论次数与时间丢弃率。
 *
 * 为什么需要这个：
 * 调试面板上的 `overrun 55` 看起来像性能问题，其实它是 **Clock 的防死亡螺旋设计**，
 * 触发条件纯粹是帧率：单帧 dt 超过 `maxSteps × fixedDt`（默认 3 × 1/60 = 50ms，
 * 即低于 20fps）就必然丢弃时间并计一次 overrun。
 *
 * 所以：
 * - SwiftShader 软渲染 4fps（250ms/帧）→ **每帧必 overrun**，55 次 ≈ 13.8 秒运行
 * - 真机 60fps（16.67ms/帧）→ **永远 0 次**
 *
 * 这个数字与物理性能无关（实测物理步均 0.57ms，远低于 4ms 预算）。
 *
 * 用法：
 *   node tools/explain-overrun.mjs              # 跑默认的几档帧率
 *   node tools/explain-overrun.mjs 4 55         # 指定 fps 与实测 overrun 次数，反推运行时长
 */

const MAX_STEPS = 3;
const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.25;

const args = process.argv.slice(2);

function explain(fps, observedOverruns) {
  const rawDt = 1 / fps;
  const clamped = Math.min(rawDt, MAX_FRAME_DT);
  const stepsWanted = clamped / FIXED_DT;
  const willOverrun = stepsWanted > MAX_STEPS;
  const dropped = willOverrun ? clamped - MAX_STEPS * FIXED_DT : 0;

  console.log(`  ${String(fps).padStart(5)} fps  (${(rawDt * 1000).toFixed(1).padStart(7)} ms/帧)`);
  console.log(`         需要 ${stepsWanted.toFixed(1).padStart(5)} 步 → 实际跑 ${Math.min(stepsWanted, MAX_STEPS).toFixed(0)} 步`);

  if (willOverrun) {
    const dropRatio = dropped / clamped;
    console.log(`         ⚠ 每帧 overrun，丢弃 ${(dropped * 1000).toFixed(1)} ms（占该帧 ${(dropRatio * 100).toFixed(0)}%）`);
    console.log(`         → 世界时间推进速度 = 墙钟 × ${(1 - dropRatio).toFixed(2)}`);
    if (observedOverruns !== undefined) {
      console.log(`         实测 overrun ${observedOverruns} → 约跑了 ${(observedOverruns / fps).toFixed(1)} 秒墙钟`);
    }
  } else {
    console.log(`         ✓ 不 overrun（${(stepsWanted).toFixed(1)} 步 ≤ maxSteps ${MAX_STEPS}）`);
  }
  console.log('');
}

console.log('overrun 解释器（Clock 的防死亡螺旋设计，不是性能告警）');
console.log('');
console.log(`  参数：maxSteps=${MAX_STEPS}，fixedDt=1/60，maxFrameDt=${MAX_FRAME_DT}s`);
console.log(`  触发条件：单帧 dt > ${(MAX_STEPS * FIXED_DT * 1000).toFixed(1)}ms（即低于 ${(1 / (MAX_STEPS * FIXED_DT)).toFixed(0)}fps）`);
console.log('');

if (args.length >= 2) {
  const fps = Number(args[0]);
  const observed = Number(args[1]);
  if (!Number.isFinite(fps) || fps <= 0) {
    console.error('fps 必须是正数');
    process.exit(1);
  }
  console.log(`反推：实测 overrun ${observed}，假定 ${fps}fps`);
  console.log('');
  explain(fps, Number.isFinite(observed) ? observed : undefined);
} else {
  console.log('各帧率下的理论结果：');
  console.log('');
  for (const fps of [4, 10, 15, 20, 30, 60, 120]) {
    explain(fps);
  }
  console.log('结论：');
  console.log('  - overrun 只在 <20fps 时出现，与物理性能无关（物理步均 0.57ms / 预算 4ms）');
  console.log('  - 它是"宁可世界慢一拍，也不要卡顿后突然快进"的实现');
  console.log('  - 看到 overrun 先看 fps：软渲染低帧率是必然，真机 60fps 应为 0');
  console.log('  - **不要**为了消除 overrun 去调大 maxSteps，那会让卡顿后的快进更严重');
}
