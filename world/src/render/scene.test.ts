import { describe, it, expect } from 'vitest';
import { detectQualityTier } from './scene';

/**
 * 移动端降级规则（spec §6 M1 验收：移动端 DPR 与阴影按规则降级）。
 * 这里只测纯函数，不碰 WebGL——判定逻辑与渲染器构造是分开的，正是为了能这样测。
 */
describe('detectQualityTier 质量档判定', () => {
  it('桌面（精细指针 + 大屏）：DPR 上限 2、开阴影、2048 贴图', () => {
    const t = detectQualityTier({ coarsePointer: false, minSide: 1080 });
    expect(t.kind).toBe('desktop');
    expect(t.maxDpr).toBe(2);
    expect(t.shadows).toBe(true);
    expect(t.shadowMapSize).toBe(2048);
  });

  it('移动端（触屏 + 短边 < 900）：DPR ≤ 1.6、关阴影', () => {
    const t = detectQualityTier({ coarsePointer: true, minSide: 390 });
    expect(t.kind).toBe('mobile');
    expect(t.maxDpr).toBeLessThanOrEqual(1.6);
    expect(t.shadows).toBe(false);
  });

  it('触屏但大屏（如触控笔记本）：仍按桌面处理', () => {
    const t = detectQualityTier({ coarsePointer: true, minSide: 1080 });
    expect(t.kind).toBe('desktop');
    expect(t.shadows).toBe(true);
  });

  it('精细指针但小窗口（窄桌面窗口）：不误判成移动端', () => {
    const t = detectQualityTier({ coarsePointer: false, minSide: 600 });
    expect(t.kind).toBe('desktop');
  });

  it('短边 900 是边界：899 移动、900 桌面', () => {
    expect(detectQualityTier({ coarsePointer: true, minSide: 899 }).kind).toBe('mobile');
    expect(detectQualityTier({ coarsePointer: true, minSide: 900 }).kind).toBe('desktop');
  });

  it('移动端阴影贴图更小（512），进一步省显存', () => {
    const t = detectQualityTier({ coarsePointer: true, minSide: 400 });
    expect(t.shadowMapSize).toBe(512);
  });
});
