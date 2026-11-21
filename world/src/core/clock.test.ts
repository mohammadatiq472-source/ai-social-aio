import { describe, it, expect } from 'vitest';
import { Clock } from './clock';
import { MAX_CATCHUP_STEPS, PHYSICS_DT } from './types';

describe('Clock 固定步长累加器', () => {
  it('默认参数符合 spec：物理 1/60、单帧最多追 3 步', () => {
    const c = new Clock();
    expect(c.fixedDt).toBeCloseTo(1 / 60, 12);
    expect(c.maxSteps).toBe(MAX_CATCHUP_STEPS);
    expect(c.fixedDt).toBe(PHYSICS_DT);
  });

  it('60fps 输入：每帧恰好 1 步，不累积漂移', () => {
    const c = new Clock();
    let total = 0;
    // 模拟 600 帧 60fps（10 秒）
    for (let i = 0; i < 600; i++) {
      const info = c.runSteps(1 / 60, () => {});
      total += info.steps;
    }
    // 600 帧 × 1 步 = 600 步（浮点误差允许 ±1）
    expect(total).toBeGreaterThanOrEqual(599);
    expect(total).toBeLessThanOrEqual(601);
    expect(c.stepCount).toBe(total);
    expect(c.worldTime).toBeCloseTo(total / 60, 6);
  });

  it('30fps 输入：每帧 2 步，物理不因掉帧变慢', () => {
    const c = new Clock();
    let steps = 0;
    // 用 runSteps 而不是 advance：advance 只扣累加器、不记账，
    // worldTime 只在 consumeStep() 里推进（runSteps 内部会调）。
    for (let i = 0; i < 300; i++) {
      steps += c.runSteps(1 / 30, () => {}).steps;
    }
    // 300 帧 × 2 步 = 600 步，即 10 秒世界时间
    expect(steps).toBeGreaterThanOrEqual(599);
    expect(steps).toBeLessThanOrEqual(601);
    expect(c.worldTime).toBeCloseTo(steps / 60, 6);
  });

  it('advance 只扣累加器不记账：worldTime 由 consumeStep 推进', () => {
    const c = new Clock();
    const info = c.advance(1 / 30);
    expect(info.steps).toBe(2);
    // 还没记账
    expect(c.worldTime).toBe(0);
    expect(c.stepCount).toBe(0);
    // 手动记账后时间才对
    c.consumeStep();
    c.consumeStep();
    expect(c.worldTime).toBeCloseTo(2 / 60, 9);
    expect(c.stepCount).toBe(2);
  });

  it('单帧最多追 3 步：超出的时间被丢弃并记 overrun', () => {
    const c = new Clock();
    // 一帧 0.5 秒 = 30 步的量，但只能追 3 步
    const info = c.advance(0.5);
    expect(info.steps).toBe(3);
    expect(info.overrun).toBe(true);
    expect(info.overruns).toBe(1);
    expect(info.droppedSeconds).toBeGreaterThan(0);
    // 丢弃后累加器清空，不会在下一帧继续补
    expect(c.pending).toBe(0);
  });

  it('累计 overrun 次数可读（给 __worldDebug 用）', () => {
    const c = new Clock();
    c.advance(0.5);
    c.advance(0.5);
    c.advance(0.5);
    expect(c.overruns).toBe(3);
    expect(c.droppedSeconds).toBeGreaterThan(0);
  });

  it('dt 被 maxFrameDt 夹住：切后台回来不会一次补 3 秒', () => {
    const c = new Clock({ maxFrameDt: 0.25 });
    const info = c.advance(5.0); // 模拟标签页休眠 5 秒
    // 0.25s 上限 → 最多 3 步（maxSteps），且不爆
    expect(info.steps).toBeLessThanOrEqual(3);
    expect(info.overrun).toBe(true);
  });

  it('alpha 始终在 0..1，供渲染插值使用', () => {
    const c = new Clock();
    for (const dt of [0.001, 0.008, 1 / 60, 0.02, 0.033, 0.1, 0.5]) {
      c.advance(dt);
      expect(c.alpha).toBeGreaterThanOrEqual(0);
      expect(c.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('非法 dt 不炸：NaN / 负数 / Infinity 都当 0', () => {
    const c = new Clock();
    for (const bad of [NaN, -1, Infinity, -Infinity]) {
      const info = c.advance(bad);
      expect(Number.isFinite(info.steps)).toBe(true);
      expect(info.steps).toBeGreaterThanOrEqual(0);
    }
    expect(c.worldTime).toBe(0);
  });

  it('runSteps 的回调拿到的是固定 dt，不是帧间可变 dt', () => {
    const c = new Clock();
    const seen: number[] = [];
    c.runSteps(1 / 20, (dt) => seen.push(dt)); // 一帧 50ms
    expect(seen.length).toBe(3);
    for (const dt of seen) expect(dt).toBeCloseTo(1 / 60, 12);
  });

  it('reset 清空时间与统计', () => {
    const c = new Clock();
    c.runSteps(0.5, () => {});
    expect(c.overruns).toBeGreaterThan(0);
    c.reset();
    expect(c.worldTime).toBe(0);
    expect(c.stepCount).toBe(0);
    expect(c.overruns).toBe(0);
    expect(c.pending).toBe(0);
  });

  it('构造参数非法时立刻抛错（别让配置错误静默跑到线上）', () => {
    expect(() => new Clock({ fixedDt: 0 })).toThrow(RangeError);
    expect(() => new Clock({ fixedDt: -1 })).toThrow(RangeError);
    expect(() => new Clock({ maxSteps: 0 })).toThrow(RangeError);
    expect(() => new Clock({ maxSteps: 1.5 })).toThrow(RangeError);
  });
});
