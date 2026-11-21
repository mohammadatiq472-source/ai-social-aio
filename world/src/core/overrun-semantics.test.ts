import { describe, it, expect } from 'vitest';
import { Clock } from '../core/clock';
import { MAX_CATCHUP_STEPS } from '../core/types';

/**
 * `overrun` 的语义验收（解释调试面板里"物理步 0.57ms 却 overrun 29"的现象）。
 *
 * 结论先说：**overrun 不是性能问题，是 Clock 的防死亡螺旋设计**。
 * 触发条件是"单帧 dt 超过 maxSteps × fixedDt"（默认 3 × 1/60 = 50ms），
 * 也就是帧率低于 20fps 时必然触发。SwiftShader 软渲染跑 3.2fps（帧间隔 ~312ms）
 * 当然每次都 overrun —— 这是**预期行为**，不是 bug。
 *
 * 这个文件把这个语义锁死，防止后人看到 overrun 就以为物理有性能问题、
 * 去调大 maxSteps（那会让卡顿后的快进更严重）。
 */
describe('overrun 语义：掉帧丢弃，不是性能告警', () => {
  it('60fps（16.67ms）不产生 overrun', () => {
    const c = new Clock();
    for (let i = 0; i < 60; i++) {
      const info = c.runSteps(1 / 60, () => {});
      expect(info.overrun).toBe(false);
    }
    expect(c.overruns).toBe(0);
  });

  it('30fps（33.3ms）也不 overrun（2 步 < maxSteps 3）', () => {
    const c = new Clock();
    for (let i = 0; i < 30; i++) {
      const info = c.runSteps(1 / 30, () => {});
      expect(info.overrun).toBe(false);
    }
    expect(c.overruns).toBe(0);
  });

  it('20fps（50ms）刚好到边界，不 overrun（正好 3 步）', () => {
    const c = new Clock();
    const info = c.runSteps(3 / 60, () => {});
    expect(info.steps).toBe(MAX_CATCHUP_STEPS);
    expect(info.overrun).toBe(false);
  });

  it('低于 20fps 必然 overrun（4 步的量只能跑 3 步）', () => {
    const c = new Clock();
    const info = c.runSteps(4 / 60, () => {});
    expect(info.steps).toBe(MAX_CATCHUP_STEPS);
    expect(info.overrun).toBe(true);
    expect(info.droppedSeconds).toBeGreaterThan(0);
  });

  it('SwiftShader 那种 3.2fps（312ms/帧）每帧都 overrun —— 这是预期的', () => {
    const c = new Clock();
    const frameDt = 1 / 3.2;
    for (let i = 0; i < 10; i++) {
      const info = c.runSteps(frameDt, () => {});
      expect(info.steps).toBe(MAX_CATCHUP_STEPS);
      expect(info.overrun).toBe(true);
    }
    expect(c.overruns).toBe(10);
    // 关键：世界时间只按实际跑的步数推进（3 步/帧 × 10 帧 = 30 步 = 0.5s），
    // 而不是按墙钟 3.125s。这就是"宁可世界慢一拍，也不要卡顿后突然快进"。
    expect(c.worldTime).toBeCloseTo(30 / 60, 6);
  });

  it('掉帧时物理不"变慢"：每帧仍按固定 1/60 推进（只是丢时间）', () => {
    const c = new Clock();
    const dts: number[] = [];
    c.runSteps(0.2, (dt) => dts.push(dt)); // 200ms 一帧
    // 跑了 3 步，每步都是固定 1/60 —— 不是 0.2/3
    expect(dts).toEqual([1 / 60, 1 / 60, 1 / 60]);
  });

  it('overrun 后累加器清零，不会在下一帧继续补（防死亡螺旋）', () => {
    const c = new Clock();
    const info = c.runSteps(0.5, () => {});
    expect(info.overrun).toBe(true);
    expect(c.pending).toBe(0);
    // 下一帧正常 16.67ms → 1 步，不 overrun
    const next = c.runSteps(1 / 60, () => {});
    expect(next.steps).toBe(1);
    expect(next.overrun).toBe(false);
  });

  it('maxFrameDt 上限先夹住超长帧，再判 overrun', () => {
    const c = new Clock({ maxFrameDt: 0.25 });
    // 切后台 5 秒回来：先被夹到 250ms，再受 maxSteps 限制
    const info = c.runSteps(5, () => {});
    expect(info.steps).toBeLessThanOrEqual(MAX_CATCHUP_STEPS);
    expect(info.overrun).toBe(true);
    expect(c.worldTime).toBeLessThanOrEqual(MAX_CATCHUP_STEPS / 60 + 1e-9);
  });
});
