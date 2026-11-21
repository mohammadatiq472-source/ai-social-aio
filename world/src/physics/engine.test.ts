/**
 * 物理层单测（M3）。
 *
 * 这些用例跑**真实 Rapier WASM**，不是 mock：spec 第 7 节的判定口径
 * （"跳了 1.20m"、"掉帧仍推进 2 步"）只有在真引擎上才有意义。
 * 实测本机 node 22 + rapier 0.21.0 可直接 `await RAPIER.init()`，无需浏览器。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { Clock } from '../core/clock';
import { PHYSICS_DT, MAX_CATCHUP_STEPS } from '../core/types';
import { parseRoom, type Room } from '../core/room';
import { GRAVITY, PhysicsWorld, createPhysicsPump, CHARACTER_CAPSULE } from './engine';
import { LAYERS, interactionGroups, layersCollide } from './layers';

/** 一个空房间：只有地板，供物理用例自建隔离世界。 */
function floorRoom(): Room {
  return parseRoom({
    name: 'test-floor',
    spawn: [[0, 1, 0]],
    lights: [],
    static: [{ type: 'box', size: [20, 0.2, 20], pos: [0, -0.1, 0], mat: 'floor' }],
    props: [],
    seats: [],
  });
}

const worlds: PhysicsWorld[] = [];

async function makeWorld(room: Room = floorRoom(), pool = 32): Promise<PhysicsWorld> {
  const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: pool });
  worlds.push(pw);
  return pw;
}

beforeAll(async () => {
  await RAPIER.init();
});

afterAll(() => {
  for (const w of worlds) w.dispose();
  worlds.length = 0;
});

describe('物理世界：初始化与常量（spec §6 M3 第 3 条）', () => {
  it('重力是 (0, -9.81, 0)', () => {
    expect(GRAVITY).toEqual({ x: 0, y: -9.81, z: 0 });
  });

  it('world.timestep 固定 1/60', async () => {
    const pw = await makeWorld();
    // Rapier 内部用 f32 存 timestep，1/60 读回来是 0.01666666753590107。
    // 所以断言"足够接近 1/60"，不能要求逐位相等——这不是我们引入的误差。
    expect(pw.world.timestep).toBeCloseTo(PHYSICS_DT, 7);
    expect(pw.world.timestep).toBeCloseTo(1 / 60, 7);
  });

  it('角色胶囊尺寸：半径 0.30、半高 0.55 → 总高 1.70m', () => {
    expect(CHARACTER_CAPSULE.radius).toBe(0.3);
    expect(CHARACTER_CAPSULE.halfHeight).toBe(0.55);
    const total = 2 * (CHARACTER_CAPSULE.halfHeight + CHARACTER_CAPSULE.radius);
    expect(total).toBeCloseTo(1.7, 10);
  });

  it('create 会 await RAPIER.init()，之后世界可用', async () => {
    const pw = await makeWorld();
    expect(pw.stats().colliders).toBeGreaterThan(0);
  });
});

describe('固定步长：拒绝可变 dt（spec §2.2 第 1 条）', () => {
  it('传 1/60 正常推进', async () => {
    const pw = await makeWorld();
    expect(() => pw.step()).not.toThrow();
    expect(pw.stats().steps).toBe(1);
  });

  it('传渲染帧 dt（1/30、1/144）一律抛 RangeError', async () => {
    const pw = await makeWorld();
    expect(() => pw.step(1 / 30)).toThrow(RangeError);
    expect(() => pw.step(1 / 144)).toThrow(RangeError);
    expect(() => pw.step(0.016)).toThrow(RangeError);
    expect(() => pw.step(0)).toThrow(RangeError);
    // 抛了之后不能有副作用：步数不该变
    expect(pw.stats().steps).toBe(0);
  });

  it('抛错信息说明了为什么（可变 dt 会让轨迹随帧率改变）', async () => {
    const pw = await makeWorld();
    expect(() => pw.step(0.033)).toThrow(/可变 dt|固定步长/);
  });
});

describe('掉帧不掉物理速度（spec §6 M3 验收第 1 条）', () => {
  it('30fps 时每帧推进 2 步，10 秒世界时间对齐', async () => {
    const clock = new Clock();
    const pw = await makeWorld();
    const pump = createPhysicsPump(clock, pw);

    let steps = 0;
    for (let i = 0; i < 300; i++) {
      steps += pump.pump(1 / 30).steps;
    }
    // 300 帧 × 1/30s = 10s 墙钟；物理应推进 600 步
    expect(steps).toBeGreaterThanOrEqual(599);
    expect(steps).toBeLessThanOrEqual(601);
    expect(pw.stats().steps).toBe(steps);
    expect(clock.worldTime).toBeCloseTo(10, 1);
  });

  it('掉帧（一帧 1/6 秒 = 10 步的量）只追 3 步并记 overrun', async () => {
    const clock = new Clock();
    const pw = await makeWorld();
    const pump = createPhysicsPump(clock, pw);

    const info = pump.pump(1 / 6);
    expect(info.steps).toBe(MAX_CATCHUP_STEPS); // 3，不是 10
    expect(info.overrun).toBe(true);
    expect(pw.stats().overruns).toBe(1);
    expect(pw.stats().droppedSeconds).toBeGreaterThan(0);
  });

  it('物理轨迹不因帧率改变：60fps 与 30fps 跑同样墙钟后自由落体高度一致', async () => {
    // 两个世界、同样时长（2 秒）、不同帧率喂法
    const a = await makeWorld();
    const b = await makeWorld();

    const boxA = a.spawnProp(0.25, 0.25, 0.25, 10, 0, 20, 0);
    const boxB = b.spawnProp(0.25, 0.25, 0.25, 10, 0, 20, 0);

    // A: 60fps，每帧 1 步
    const clockA = new Clock();
    const pumpA = createPhysicsPump(clockA, a);
    for (let i = 0; i < 120; i++) pumpA.pump(1 / 60);

    // B: 30fps，每帧 2 步
    const clockB = new Clock();
    const pumpB = createPhysicsPump(clockB, b);
    for (let i = 0; i < 60; i++) pumpB.pump(1 / 30);

    // 两个世界都推进了 120 步 = 2 秒物理时间 → 位置应完全一致（同一引擎、同样步数）
    expect(a.stats().steps).toBe(120);
    expect(b.stats().steps).toBe(120);
    expect(boxA.body.translation().y).toBeCloseTo(boxB.body.translation().y, 10);
  });

  it('overrun 计数与 Clock 的记账一致', async () => {
    const clock = new Clock();
    const pw = await makeWorld();
    const pump = createPhysicsPump(clock, pw);
    for (let i = 0; i < 5; i++) pump.pump(1); // 每次 60 步的量 → 每次 overrun
    expect(pw.stats().overruns).toBe(clock.overruns);
    expect(pw.stats().overruns).toBe(5);
  });
});

describe('碰撞层矩阵（spec §6 M3 第 4 条）', () => {
  it('层号是 spec 规定的 1/2/4/8/16', () => {
    expect(LAYERS.WORLD_STATIC).toBe(1);
    expect(LAYERS.CHARACTER).toBe(2);
    expect(LAYERS.PROP).toBe(4);
    expect(LAYERS.SENSOR).toBe(8);
    expect(LAYERS.AGENT).toBe(16);
  });

  it('character 与 world-static / prop / character 碰撞', () => {
    expect(layersCollide('CHARACTER', 'WORLD_STATIC')).toBe(true);
    expect(layersCollide('CHARACTER', 'PROP')).toBe(true);
    expect(layersCollide('CHARACTER', 'CHARACTER')).toBe(true);
  });

  it('character 不与 sensor 产生物理响应', () => {
    expect(layersCollide('CHARACTER', 'SENSOR')).toBe(false);
  });

  it('interactionGroups 高 16 位是 membership、低 16 位是 filter', () => {
    const g = interactionGroups('CHARACTER');
    expect((g >>> 16) & 0xffff).toBe(LAYERS.CHARACTER);
    expect(g & 0xffff).toBeGreaterThan(0);
  });

  it('矩阵双向一致：不存在"单方面愿意碰"', () => {
    const names = Object.keys(LAYERS) as Array<keyof typeof LAYERS>;
    for (const a of names) {
      for (const b of names) {
        expect(layersCollide(a, b)).toBe(layersCollide(b, a));
      }
    }
  });
});

describe('房间烘焙（spec §6 M3 第 5 条）', () => {
  it('demo 房间烘焙出 9 个碰撞体、0 个失败', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const url = new URL('../../rooms/demo-room.json', import.meta.url);
    const room = parseRoom(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')));

    const pw = await makeWorld(room, 8);
    const baked = pw.bakedRoom!;
    expect(baked.stats.colliders).toBe(9);
    expect(baked.stats.failed).toEqual([]);
    expect(baked.colliders.length).toBe(9);
  });

  it('烘焙出的碰撞体在 WORLD_STATIC 层', async () => {
    const pw = await makeWorld();
    const baked = pw.bakedRoom!;
    for (const c of baked.colliders) {
      expect((c.collider.collisionGroups() >>> 16) & 0xffff).toBe(LAYERS.WORLD_STATIC);
    }
  });

  it('dispose() 后碰撞体被清掉（重复调用安全）', async () => {
    const pw = await makeWorld();
    const before = pw.stats().colliders;
    expect(before).toBeGreaterThan(0);
    pw.bakedRoom!.dispose();
    expect(pw.stats().colliders).toBe(0);
    expect(() => pw.bakedRoom!.dispose()).not.toThrow();
  });

  it('箱子会落在地板上而不是穿下去（烘焙出来的地面真的在挡）', async () => {
    const pw = await makeWorld();
    const box = pw.spawnProp(0.25, 0.25, 0.25, 10, 0, 3, 0);
    for (let i = 0; i < 180; i++) pw.step();
    const y = box.body.translation().y;
    // 地板顶面 y=0，箱子半高 0.25 → 静止时中心应在 0.25 附近
    expect(y).toBeGreaterThan(0.2);
    expect(y).toBeLessThan(0.3);
    expect(box.body.translation().y).toBeLessThan(3); // 确实落了
  });
});

describe('传感器只与角色产生事件（spec §6 M3 第 4 条）', () => {
  it('角色穿过传感器 → 收到 enter 与 exit', async () => {
    const pw = await makeWorld();
    pw.addSensor('seat:s1', 0.6, 0.5, 0.6, 0, 1, 0);

    const events: Array<{ tag: string; entered: boolean }> = [];
    pw.onSensor((tag, _other, entered) => events.push({ tag, entered }));

    const body = pw.createCharacter(0, 1, 3);
    for (let i = 0; i < 90; i++) {
      const t = body.translation();
      body.setNextKinematicTranslation({ x: t.x, y: 1, z: t.z - 0.05 });
      pw.step();
    }

    const entered = events.filter((e) => e.entered);
    const exited = events.filter((e) => !e.entered);
    expect(entered.length).toBe(1);
    expect(entered[0]!.tag).toBe('seat:s1');
    expect(exited.length).toBe(1);
  });

  it('箱子穿过传感器不产生事件（sensor 只认 character）', async () => {
    const pw = await makeWorld();
    pw.addSensor('zone', 0.6, 0.5, 0.6, 0, 1, 0);
    let hits = 0;
    pw.onSensor(() => {
      hits += 1;
    });
    // 箱子从传感器上方掉下来穿过
    pw.spawnProp(0.2, 0.2, 0.2, 5, 0, 3, 0);
    for (let i = 0; i < 120; i++) pw.step();
    expect(hits).toBe(0);
  });
});

describe('对象池：热路径零 new（spec §6 M3 第 6 条）', () => {
  it('acquire/release 循环不增加池的创建数', async () => {
    const pw = await makeWorld(floorRoom(), 16);
    const pool = pw.pool;
    const createdAfterInit = pool.createdCount;
    expect(createdAfterInit).toBe(16);

    for (let i = 0; i < 200; i++) {
      const p = pw.spawnProp(0.2, 0.2, 0.2, 5, 0, 5, 0);
      pw.step();
      pw.releaseProp(p);
    }
    // 循环 200 次，池一个都没新建
    expect(pool.createdCount).toBe(createdAfterInit);
  });

  it('池耗尽且 allowGrowth=false 时明确抛错（而不是悄悄 new）', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), {
      propPoolSize: 2,
      allowPoolGrowth: false,
    });
    worlds.push(pw);
    pw.spawnProp(0.2, 0.2, 0.2, 5, 0, 5, 0);
    pw.spawnProp(0.2, 0.2, 0.2, 5, 0, 5, 0);
    expect(() => pw.spawnProp(0.2, 0.2, 0.2, 5, 0, 5, 0)).toThrow(/池已耗尽/);
  });

  it('复用出来的箱子不带上一任的动量', async () => {
    const pw = await makeWorld(floorRoom(), 4);
    const first = pw.spawnProp(0.2, 0.2, 0.2, 5, 0, 5, 0);
    // 给一个很大的水平速度
    first.body.setLinvel({ x: 50, y: 0, z: 0 }, true);
    pw.step();
    pw.releaseProp(first);

    const second = pw.spawnProp(0.2, 0.2, 0.2, 5, 0, 5, 0);
    const v = second.body.linvel();
    expect(Math.abs(v.x)).toBeLessThan(0.001);
    expect(Math.abs(v.y)).toBeLessThan(0.001);
    expect(Math.abs(v.z)).toBeLessThan(0.001);
  });

  it('复用后质量是新的，不是上一任的残留', async () => {
    const pw = await makeWorld(floorRoom(), 2);
    const a = pw.spawnProp(0.2, 0.2, 0.2, 50, 0, 5, 0);
    pw.step();
    pw.releaseProp(a);
    const b = pw.spawnProp(0.2, 0.2, 0.2, 2, 0, 5, 0);
    pw.step(); // setMass 要到 step 之后才反映到 body.mass()
    expect(b.body.mass()).toBeCloseTo(2, 5);
    expect(b.mass).toBe(2);
  });
});

describe('角色刚体', () => {
  it('角色是 kinematic，不会被重力拉走', async () => {
    const pw = await makeWorld();
    const body = pw.createCharacter(0, 5, 0);
    const before = body.translation().y;
    for (let i = 0; i < 60; i++) pw.step();
    expect(body.translation().y).toBeCloseTo(before, 6);
  });

  it('角色胶囊带 CCD（spec：角色胶囊开 CCD）', async () => {
    const pw = await makeWorld();
    const body = pw.createCharacter(0, 2, 0);
    expect(body.isCcdEnabled()).toBe(true);
  });
});

describe('dispose 之后不可再用', () => {
  it('step 抛错', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    pw.dispose();
    expect(() => pw.step()).toThrow(/dispose/);
  });

  it('重复 dispose 安全', async () => {
    const pw = await PhysicsWorld.create(RAPIER, floorRoom(), { propPoolSize: 2 });
    pw.dispose();
    expect(() => pw.dispose()).not.toThrow();
  });
});
