/**
 * Debug draw 单测（spec §6 M3 第 7 条：按层着色、D 键切换）。
 *
 * three 在 node 里可以跑（不需要 WebGL 上下文，只要构造 BufferGeometry / LineSegments），
 * 所以这些断言是**真的在读顶点缓冲**，不是 mock。
 * 但 Rapier 形状类要注入：本文件不硬依赖 WASM 包。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsDebugDraw, bindDebugDrawRapier } from './debug-draw';
import { LAYER_COLORS, LAYERS, interactionGroups } from './layers';
import { PhysicsWorld } from './engine';
import { parseRoom } from '../core/room';

const worlds: PhysicsWorld[] = [];

function floorRoom() {
  return parseRoom({
    name: 'dd',
    spawn: [[0, 1, 0]],
    lights: [],
    static: [{ type: 'box', size: [10, 0.2, 10], pos: [0, -0.1, 0] }],
    props: [],
    seats: [],
  });
}

beforeAll(async () => {
  await RAPIER.init();
  bindDebugDrawRapier(RAPIER);
});

function makeScene(): THREE.Scene {
  return new THREE.Scene();
}

describe('debug draw：按层着色', () => {
  it('静态几何用 WORLD_STATIC 的颜色，角色用 CHARACTER 的颜色', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    worlds.push(pw);
    pw.createCharacter(0, 2, 0);

    const scene = makeScene();
    const dd = new PhysicsDebugDraw(scene, { visible: true, capacity: 64, bindKey: false });
    const stats = dd.sync(pw.world);
    expect(stats.drawn).toBeGreaterThanOrEqual(2);

    // 从颜色缓冲里找出两种不同颜色，确认都在预期集合里
    const colors = dd.geometry.getAttribute('color').array as Float32Array;
    const seen = new Set<string>();
    for (let i = 0; i < stats.segments * 2; i++) {
      const r = Math.round(colors[i * 3]! * 255);
      const g = Math.round(colors[i * 3 + 1]! * 255);
      const b = Math.round(colors[i * 3 + 2]! * 255);
      seen.add(`${r},${g},${b}`);
    }

    const hexToRgb = (hex: number) =>
      `${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff}`;

    expect(seen.has(hexToRgb(LAYER_COLORS.WORLD_STATIC))).toBe(true);
    expect(seen.has(hexToRgb(LAYER_COLORS.CHARACTER))).toBe(true);
    // 没有不该出现的颜色（比如把角色画成了静态灰）
    expect(seen.has(hexToRgb(LAYER_COLORS.SENSOR))).toBe(false);

    dd.dispose();
  });

  it('道具用 PROP 的颜色', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 4 });
    worlds.push(pw);
    pw.spawnProp(0.25, 0.25, 0.25, 10, 0, 2, 0);

    const dd = new PhysicsDebugDraw(makeScene(), { visible: true, capacity: 64, bindKey: false });
    dd.sync(pw.world);

    const colors = dd.geometry.getAttribute('color').array as Float32Array;
    const want = `${(LAYER_COLORS.PROP >> 16) & 0xff},${(LAYER_COLORS.PROP >> 8) & 0xff},${LAYER_COLORS.PROP & 0xff}`;
    let found = false;
    for (let i = 0; i < dd.stats().segments * 2; i++) {
      const key = `${Math.round(colors[i * 3]! * 255)},${Math.round(colors[i * 3 + 1]! * 255)},${Math.round(colors[i * 3 + 2]! * 255)}`;
      if (key === want) found = true;
    }
    expect(found).toBe(true);
    dd.dispose();
  });

  it('传感器用 SENSOR 的颜色', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    worlds.push(pw);
    pw.addSensor('zone', 0.5, 0.5, 0.5, 0, 1, 0);

    const dd = new PhysicsDebugDraw(makeScene(), { visible: true, capacity: 32, bindKey: false });
    dd.sync(pw.world);
    const colors = dd.geometry.getAttribute('color').array as Float32Array;
    const want = `${(LAYER_COLORS.SENSOR >> 16) & 0xff},${(LAYER_COLORS.SENSOR >> 8) & 0xff},${LAYER_COLORS.SENSOR & 0xff}`;
    let found = false;
    for (let i = 0; i < dd.stats().segments * 2; i++) {
      const key = `${Math.round(colors[i * 3]! * 255)},${Math.round(colors[i * 3 + 1]! * 255)},${Math.round(colors[i * 3 + 2]! * 255)}`;
      if (key === want) found = true;
    }
    expect(found).toBe(true);
    dd.dispose();
  });
});

describe('debug draw：几何正确性', () => {
  it('盒子画 12 条边 = 24 个顶点', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    worlds.push(pw);

    const dd = new PhysicsDebugDraw(makeScene(), { visible: true, capacity: 16, bindKey: false });
    const stats = dd.sync(pw.world);
    // 房间只有一块地板 → 一个 cuboid → 12 段 → 24 顶点
    expect(stats.drawn).toBe(1);
    expect(stats.segments).toBe(12);
    dd.dispose();
  });

  it('顶点在包围盒内（变换没算错）', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    worlds.push(pw);
    const dd = new PhysicsDebugDraw(makeScene(), { visible: true, capacity: 16, bindKey: false });
    dd.sync(pw.world);

    const pos = dd.geometry.getAttribute('position').array as Float32Array;
    const n = dd.stats().segments * 2;
    // 地板 size 10x0.2x10 @ y=-0.1 → x/z ∈ [-5,5]，y ∈ [-0.2,0]
    for (let i = 0; i < n; i++) {
      expect(pos[i * 3]!).toBeGreaterThanOrEqual(-5.01);
      expect(pos[i * 3]!).toBeLessThanOrEqual(5.01);
      expect(pos[i * 3 + 1]!).toBeGreaterThanOrEqual(-0.21);
      expect(pos[i * 3 + 1]!).toBeLessThanOrEqual(0.01);
      expect(pos[i * 3 + 2]!).toBeGreaterThanOrEqual(-5.01);
      expect(pos[i * 3 + 2]!).toBeLessThanOrEqual(5.01);
    }
    dd.dispose();
  });

  it('旋转过的盒子顶点确实转过去了（斜坡不是平的）', async () => {
    const room = parseRoom({
      name: 'ramp',
      spawn: [[0, 1, 0]],
      lights: [],
      static: [
        // 绕 z 轴转 30°：顶点 y 范围应被拉高
        { type: 'ramp', size: [2, 0.15, 3], pos: [0, 1, 0], rot: [0, 0, -0.52] },
      ],
      props: [],
      seats: [],
    });
    const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 2 });
    worlds.push(pw);
    const dd = new PhysicsDebugDraw(makeScene(), { visible: true, capacity: 16, bindKey: false });
    dd.sync(pw.world);

    const pos = dd.geometry.getAttribute('position').array as Float32Array;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < dd.stats().segments * 2; i++) {
      minY = Math.min(minY, pos[i * 3 + 1]!);
      maxY = Math.max(maxY, pos[i * 3 + 1]!);
    }
    // 未旋转时 y 跨度只有 0.15；转了 30° 后 x 方向的 2m 会带来 ~1.0m 的 y 跨度
    expect(maxY - minY).toBeGreaterThan(0.5);
    dd.dispose();
  });

  it('胶囊画出的顶点数合理（不是空也不是爆量）', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    worlds.push(pw);
    pw.createCharacter(0, 2, 0);

    const dd = new PhysicsDebugDraw(makeScene(), { visible: true, capacity: 64, bindKey: false });
    dd.sync(pw.world);
    // 地板 12 段 + 胶囊若干段
    expect(dd.stats().segments).toBeGreaterThan(12);
    expect(dd.stats().segments).toBeLessThan(64 * 8);
    dd.dispose();
  });
});

describe('debug draw：开关与容量', () => {
  it('默认不可见，且不可见时 sync 不画任何东西（不浪费帧）', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    worlds.push(pw);
    const dd = new PhysicsDebugDraw(makeScene(), { capacity: 32, bindKey: false });
    expect(dd.visible).toBe(false);
    const stats = dd.sync(pw.world);
    expect(stats.visible).toBe(false);
    expect(stats.drawn).toBe(0);
    expect(stats.segments).toBe(0);
    expect(dd.lines.visible).toBe(false);
    dd.dispose();
  });

  it('toggle 切换可见性并返回新状态', () => {
    const dd = new PhysicsDebugDraw(makeScene(), { capacity: 8, bindKey: false });
    expect(dd.toggle()).toBe(true);
    expect(dd.visible).toBe(true);
    expect(dd.lines.visible).toBe(true);
    expect(dd.toggle()).toBe(false);
    expect(dd.visible).toBe(false);
    dd.dispose();
  });

  it('D 键切换（模拟 keydown 事件）', () => {
    const handlers: Array<(e: unknown) => void> = [];
    const fakeTarget = {
      addEventListener: (_t: string, h: (e: unknown) => void) => handlers.push(h),
      removeEventListener: () => {},
    };
    const dd = new PhysicsDebugDraw(makeScene(), {
      capacity: 8,
      bindKey: true,
      keyTarget: fakeTarget as never,
    });
    expect(handlers.length).toBe(1);
    expect(dd.visible).toBe(false);
    handlers[0]!({ key: 'd', target: { tagName: 'BODY' } });
    expect(dd.visible).toBe(true);
    handlers[0]!({ key: 'D', target: { tagName: 'BODY' } });
    expect(dd.visible).toBe(false);
    dd.dispose();
  });

  it('输入框里按 D 不切换（不抢输入）', () => {
    const handlers: Array<(e: unknown) => void> = [];
    const dd = new PhysicsDebugDraw(makeScene(), {
      capacity: 8,
      bindKey: true,
      keyTarget: {
        addEventListener: (_t: string, h: (e: unknown) => void) => handlers.push(h),
        removeEventListener: () => {},
      } as never,
    });
    handlers[0]!({ key: 'd', target: { tagName: 'INPUT' } });
    expect(dd.visible).toBe(false);
    dd.dispose();
  });

  it('容量不足时报告 skipped，而不是越界写坏缓冲', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 8 });
    worlds.push(pw);
    for (let i = 0; i < 10; i++) pw.spawnProp(0.2, 0.2, 0.2, 5, i, 2, 0);

    const dd = new PhysicsDebugDraw(makeScene(), { visible: true, capacity: 2, bindKey: false });
    const stats = dd.sync(pw.world);
    expect(stats.skipped).toBeGreaterThan(0);
    // 写进去的顶点数不超过容量
    const pos = dd.geometry.getAttribute('position').array as Float32Array;
    const maxVerts = 2 * 64 * 2;
    expect(pos.length).toBeGreaterThanOrEqual(maxVerts * 3);
    expect(dd.geometry.drawRange.count).toBeLessThanOrEqual(maxVerts);
    dd.dispose();
  });

  it('dispose 把线框从场景摘掉并释放资源', () => {
    const scene = makeScene();
    const dd = new PhysicsDebugDraw(scene, { capacity: 8, bindKey: false });
    expect(scene.children.length).toBe(1);
    dd.dispose();
    expect(scene.children.length).toBe(0);
  });
});

describe('debug draw：line segments 对象本身', () => {
  it('是 THREE.LineSegments，且关掉了视锥剔除（顶点每帧变）', () => {
    const dd = new PhysicsDebugDraw(makeScene(), { capacity: 8, bindKey: false });
    expect(dd.lines).toBeInstanceOf(THREE.LineSegments);
    expect(dd.lines.frustumCulled).toBe(false);
    expect(dd.material.vertexColors).toBe(true);
    dd.dispose();
  });

  it('每层都有独立配色（没有两层撞色）', () => {
    const values = Object.values(LAYER_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('层号与配色表的键完全对应', () => {
    expect(Object.keys(LAYER_COLORS).sort()).toEqual(Object.keys(LAYERS).sort());
  });

  it('interactionGroups 能被 layerOfGroups 反解（着色依赖这条）', () => {
    const dd = new PhysicsDebugDraw(makeScene(), { capacity: 8, bindKey: false });
    // 只验证不抛；具体反解由 layers.test.ts 覆盖
    expect(interactionGroups('PROP')).toBeGreaterThan(0);
    dd.dispose();
  });
});
