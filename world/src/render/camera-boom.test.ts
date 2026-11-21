import { describe, it, expect } from 'vitest';
import { resolveBoomDistance } from './camera';

describe('相机避障：resolveBoomDistance', () => {
  it('无遮挡时比例保持 1，距离不变', () => {
    const r = resolveBoomDistance(4, null, 0.32, 1, 1 / 60);
    expect(r.fraction).toBeCloseTo(1, 6);
    expect(r.distance).toBeCloseTo(4, 6);
  });

  it('命中时把距离拉到命中点前 padding 处', () => {
    // 理想 4m，2m 处有墙，padding 0.32 → 可用 1.68m
    // 拉近要快（rate*3），跑很多帧后应接近目标
    let frac = 1;
    for (let i = 0; i < 200; i++) {
      frac = resolveBoomDistance(4, 2, 0.32, frac, 1 / 60).fraction;
    }
    expect(frac).toBeCloseTo(1.68 / 4, 3);
  });

  it('命中距离小于 padding 时夹到 0 附近（相机不跑到注视点后面）', () => {
    let frac = 1;
    for (let i = 0; i < 200; i++) {
      frac = resolveBoomDistance(4, 0.1, 0.32, frac, 1 / 60).fraction;
    }
    // 指数平滑是渐近的，永远到不了精确 0（1.8e-35 这种），所以断言"接近 0"
    expect(frac).toBeLessThan(1e-6);
    expect(frac).toBeGreaterThanOrEqual(0);
  });

  it('拉近比推远快（贴墙时要立刻反应，离墙时要慢）', () => {
    // 同样一帧，从 1 收到 0.5 vs 从 0.5 推到 1
    const inOne = resolveBoomDistance(4, 2, 0, 1, 1 / 60).fraction;
    const outOne = resolveBoomDistance(4, null, 0, 0.5, 1 / 60).fraction;
    // 拉近的位移量应大于推远的位移量
    expect(1 - inOne).toBeGreaterThan(outOne - 0.5);
  });

  it('dt 非法时直接跳到目标（不做平滑）', () => {
    const r = resolveBoomDistance(4, 2, 0, 1, NaN);
    expect(r.fraction).toBeCloseTo(0.5, 6);
    const r0 = resolveBoomDistance(4, 2, 0, 1, 0);
    expect(r0.fraction).toBeCloseTo(0.5, 6);
  });

  it('理想距离为 0 时不会除零', () => {
    const r = resolveBoomDistance(0, 1, 0.32, 1, 1 / 60);
    expect(Number.isFinite(r.fraction)).toBe(true);
    expect(r.distance).toBe(0);
  });

  it('返回的距离始终非负（负距离会让相机翻到注视点背面）', () => {
    for (const hit of [0, 0.1, 0.32, 1, 2, 100]) {
      const r = resolveBoomDistance(4, hit, 0.32, 1, 1 / 60);
      expect(r.distance).toBeGreaterThanOrEqual(0);
      expect(r.fraction).toBeGreaterThanOrEqual(0);
      expect(r.fraction).toBeLessThanOrEqual(1);
    }
  });

  it('命中距离大于理想距离时视为无遮挡（比例 1）', () => {
    // 射线打到 10m 外的墙，但相机只在 4m 处 → 不该拉近
    const r = resolveBoomDistance(4, 10, 0.32, 1, 1 / 60);
    expect(r.fraction).toBeCloseTo(1, 6);
  });

  it('平滑是单调的：连续多帧收敛到目标，不来回抖', () => {
    let frac = 1;
    const seq: number[] = [];
    for (let i = 0; i < 60; i++) {
      frac = resolveBoomDistance(4, 2, 0.32, frac, 1 / 60).fraction;
      seq.push(frac);
    }
    // 每帧都应该比上一帧小（或相等），不能反弹
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeLessThanOrEqual(seq[i - 1]! + 1e-9);
    }
  });
});
