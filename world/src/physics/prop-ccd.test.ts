import { describe, it, expect } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from './engine';
import { parseRoom } from '../core/room';

/** 一面薄墙 + 地板。墙在 z = -3，厚 0.2（薄墙最容易穿）。 */
function thinWallRoom() {
  return parseRoom({
    name: 'thinwall',
    spawn: [[0, 1, 0]],
    lights: [],
    static: [
      { type: 'box', size: [20, 0.2, 20], pos: [0, -0.1, 0], mat: 'floor' },
      { type: 'box', size: [20, 2, 0.2], pos: [0, 1, -3], mat: 'wall' },
    ],
    props: [],
    seats: [],
  });
}

async function fling(ccd: boolean, speed: number): Promise<number> {
  const pw = await PhysicsWorld.create(RAPIER, thinWallRoom(), { propPoolSize: 8 });
  try {
    const prop = pw.spawnProp(0.25, 0.25, 0.25, 10, 0, 0.5, 0, ccd);
    prop.body.enableCcd(ccd);
    prop.body.setLinvel({ x: 0, y: 0, z: -speed }, true);
    for (let i = 0; i < 90; i++) pw.step();
    return prop.body.translation().z;
  } finally {
    pw.dispose();
  }
}

describe('道具 CCD', () => {
  it('房间道具创建时 CCD 是开的（配置层面）', async () => {
    const room = parseRoom({
      name: 'props',
      spawn: [[0, 1, 0]],
      lights: [],
      static: [{ type: 'box', size: [20, 0.2, 20], pos: [0, -0.1, 0], mat: 'floor' }],
      props: [{ type: 'box', size: [0.5, 0.5, 0.5], pos: [0, 0.3, 0], mass: 10 }],
      seats: [],
    });
    const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    try {
      expect(pw.roomProps.length).toBe(1);
      expect(pw.roomProps[0]!.body.isCcdEnabled()).toBe(true);
    } finally {
      pw.dispose();
    }
  });

  it('60m/s 撞薄墙不穿过（无论 CCD 开关）', async () => {
    expect(await fling(true, 60)).toBeGreaterThan(-3);
    expect(await fling(false, 60)).toBeGreaterThan(-3);
  });

  /**
   * 这条用例记录了一个**实测出来的反直觉事实**，防止后人重复调查：
   *
   * 我在 30 / 60 / 100 / 150 / 200 / 300 / 500 / 800 / 1200 m/s 九个速度上
   * 对比了 CCD 开与关的最终位置 —— **两者完全相同**。
   *
   * 说明：在这个场景（10kg、0.5m 立方、0.2m 薄墙、1/60 定步）下，
   * Rapier 的离散检测已经足够，CCD 没有带来可观测的差异。
   *
   * 那为什么还给房间道具开 CCD？
   * - 它是**防御性配置**：真实场景里箱子可能被角色推 + 被其他箱子撞 + 叠在斜坡上，
   *   速度方向不是单一轴向，此时离散检测的采样间隔更容易漏。
   * - 开销可忽略：CCD 只在高速时激活，静止/慢速箱子不产生额外成本。
   * - 规格书 §6 M3 第 3 条本来就要求"快速道具开 CCD"。
   *
   * **但必须诚实标注：这次改动没有修复任何已观测到的 bug。**
   * 不要因为看到这条用例就以为"我们修了一个穿墙 bug"。
   */
  it('记录：极端速度下 CCD 开关无差异（防御性配置，非 bug 修复）', async () => {
    const off = await fling(false, 300);
    const on = await fling(true, 300);
    // 两者都不穿墙。断言它们行为一致，而不是断言"关 CCD 会穿"。
    expect(off).toBeGreaterThan(-3);
    expect(on).toBeGreaterThan(-3);
    expect(Math.abs(off - on)).toBeLessThan(0.01);
  });
});
