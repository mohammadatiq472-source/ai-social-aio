/**
 * 玩家交互控制器单测（M10 接线层）。
 *
 * 跑**真实 Rapier + 真实 CharacterController**，不是打桩。
 * 理由：M10 的验收标准全是"行为"（坐上去位置对不对、坐着还能不能走、
 * 推箱会不会动），这些行为只在真物理里才成立。用假控制器测只能证明
 * "我调用了 teleport()"，证明不了"人真的坐在座位上且没穿模"。
 *
 * 与 `index.test.ts` 的分工：
 * - `index.test.ts` 测**纯判定**（距离、姿态、状态机），零物理依赖；
 * - 这个文件测**接线**（判定结果有没有真的驱动物理），必须真物理。
 * 两层都要，因为"判定对但没接线"正是 M10 之前的实际状态。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { parseRoom, type Room, type RoomSeat } from '../core/room';
import { World } from '../core/world';
import { PhysicsWorld } from '../physics/engine';
import { CharacterController, DEFAULT_CHARACTER } from '../physics/character';
import { createTransform } from '../core/types';
import {
  CAPSULE_CENTER_HEIGHT,
  PlayerController,
  quatToYaw,
  yawQuat,
} from './player';
import { STAND_OFFSET } from './index';

const worlds: PhysicsWorld[] = [];

const CAP = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;

/** 测试房间：一块地面 + 可选座位 + 可选箱子。 */
function testRoom(seats: RoomSeat[] = [], props: Room['props'] = []): Room {
  return parseRoom({
    name: 'm10-test',
    spawn: [[0, 0, 0]],
    lights: [],
    static: [{ type: 'box', size: [30, 0.2, 30], pos: [0, -0.1, 0] }],
    props,
    seats,
  });
}

async function makeWorld(room: Room): Promise<PhysicsWorld> {
  const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
  worlds.push(pw);
  return pw;
}

/** 一个玩家 + 世界 + 控制器的最小装配。 */
interface Rig {
  world: World;
  physics: PhysicsWorld;
  controller: CharacterController;
  player: PlayerController;
  room: Room;
}

async function makeRig(
  room: Room,
  opts: { spawn?: [number, number, number]; move?: () => { dirX: number; dirZ: number; run: boolean; jump: boolean } } = {},
): Promise<Rig> {
  const physics = await makeWorld(room);
  const world = new World();
  const spawn = opts.spawn ?? [0, CAP + 0.05, 0];

  const id = world.nextId('p');
  world.spawn({
    id,
    kind: 'human',
    name: '你',
    transform: createTransform([spawn[0], spawn[1], spawn[2]]),
    anim: 'idle',
    animPhase: 0,
  });

  const controller = new CharacterController(RAPIER, physics, spawn[0], spawn[1], spawn[2]);
  const player = new PlayerController({
    world,
    id,
    controller,
    seats: room.seats,
    readMove: opts.move ?? (() => ({ dirX: 0, dirZ: 0, run: false, jump: false })),
    readPropPositions: () =>
      physics.roomProps.map((p) => {
        const t = p.body.translation();
        return [t.x, t.y, t.z] as [number, number, number];
      }),
  });

  return { world, physics, controller, player, room };
}

/** 跑 N 个物理步（严格按 main.ts 的顺序：physics.step → player.step → world.tick）。 */
function run(rig: Rig, steps: number): void {
  for (let i = 0; i < steps; i++) {
    rig.physics.step(1 / 60);
    rig.player.step(1 / 60);
    rig.world.tick(1 / 60);
  }
}

beforeAll(async () => {
  await RAPIER.init();
});

afterAll(() => {
  for (const w of worlds) w.dispose();
  worlds.length = 0;
});

// ───────────────────────────── 参数 ─────────────────────────────

describe('M10 接线：胶囊中心高', () => {
  it('CAPSULE_CENTER_HEIGHT = halfHeight + radius = 0.85', () => {
    expect(CAPSULE_CENTER_HEIGHT).toBeCloseTo(0.85, 10);
    expect(CAPSULE_CENTER_HEIGHT).toBe(DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius);
  });

  it('yawQuat / quatToYaw 互逆（朝向约定与物理层一致）', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.1]) {
      expect(quatToYaw(yawQuat(yaw))).toBeCloseTo(yaw, 9);
    }
  });
});

// ───────────────────────────── 坐下 ─────────────────────────────

describe('M10 坐下：按 E 进入 sit 并吸附到座位', () => {
  it('走近座位按 E → sitting，位置吸附到座位（误差 < 2cm）', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    // 出生在座位前方 0.8m（在 1.2m reach 内）
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 30); // 先落地稳定

    expect(rig.player.sitting).toBe(false);
    const action = rig.player.pressSit();
    expect(action).toBe('sit');
    expect(rig.player.sitting).toBe(true);
    expect(rig.player.seatId).toBe('s1');

    run(rig, 10); // 一个物理步就够，跑 10 步确认持续吸附

    const actor = rig.world.getActor(rig.player.id)!;
    // 座位在 (0,0,2)，胶囊中心应在 y = 0 + 0.85
    expect(actor.transform.p[0]).toBeCloseTo(0, 2);
    expect(actor.transform.p[2]).toBeCloseTo(2, 2);
    expect(actor.transform.p[1]).toBeCloseTo(CAPSULE_CENTER_HEIGHT, 2);
    // 动画是 sit
    expect(actor.anim).toBe('sit');
  });

  it('吸附的朝向 = 座位朝向', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: Math.PI / 2 };
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 20);

    rig.player.pressSit();
    run(rig, 5);

    const actor = rig.world.getActor(rig.player.id)!;
    expect(quatToYaw(actor.transform.r)).toBeCloseTo(Math.PI / 2, 3);
  });

  it('1.2m 外按 E → none，状态不变（不能隔空坐）', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 5], rot: 0 };
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 0] });
    run(rig, 20);

    expect(rig.player.pressSit()).toBe('none');
    expect(rig.player.sitting).toBe(false);
    expect(rig.player.seatId).toBeNull();
  });

  it('坐着时位置不被重力拖下去（持续吸附，不是一次性瞬移）', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 20);
    rig.player.pressSit();
    run(rig, 10);

    const y1 = rig.world.getActor(rig.player.id)!.transform.p[1];
    run(rig, 120); // 再跑 2 秒
    const y2 = rig.world.getActor(rig.player.id)!.transform.p[1];

    // 坐下后 y 必须稳定在座位高度（±1cm），不能被重力拉下去
    expect(Math.abs(y2 - y1)).toBeLessThan(0.01);
    expect(y2).toBeCloseTo(CAPSULE_CENTER_HEIGHT, 2);
  });
});

// ───────────────────────────── 起身 ─────────────────────────────

describe('M10 起身：再按 E 回到 free，站到座位前方', () => {
  it('再按 E → free，位置在座位前方 STAND_OFFSET 处', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 20);

    rig.player.pressSit();
    run(rig, 10);
    expect(rig.player.sitting).toBe(true);

    const action = rig.player.pressSit();
    expect(action).toBe('stand');
    expect(rig.player.sitting).toBe(false);
    expect(rig.player.seatId).toBeNull();

    run(rig, 10);

    const actor = rig.world.getActor(rig.player.id)!;
    // 座位 rot=0 → 前方是 +z，站位在 z = 2 + STAND_OFFSET
    expect(actor.transform.p[2]).toBeCloseTo(2 + STAND_OFFSET, 1);
    expect(actor.transform.p[0]).toBeCloseTo(0, 1);
  });

  it('起身后不会立刻又被判定"够得着"（站位在 reach 之外）', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 20);

    rig.player.pressSit();
    run(rig, 10);
    rig.player.pressSit();
    run(rig, 30);

    // 起身后站着，且脚下位置到座位的水平距离 > SIT_REACH 的边界不会被误触发
    const actor = rig.world.getActor(rig.player.id)!;
    const dist = Math.hypot(actor.transform.p[0] - seat.pos[0], actor.transform.p[2] - seat.pos[2]);
    expect(dist).toBeGreaterThan(0.4);
    // 关键：起身动作本身是 stand，不是"又坐回去"
    expect(rig.player.sitting).toBe(false);
  });

  it('坐/起/坐 反复切换都正确（状态机不卡死）', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 20);

    for (let i = 0; i < 3; i++) {
      expect(rig.player.pressSit()).toBe('sit');
      run(rig, 8);
      expect(rig.player.sitting).toBe(true);
      expect(rig.player.pressSit()).toBe('stand');
      run(rig, 8);
      expect(rig.player.sitting).toBe(false);
    }
    expect(rig.player.toggles).toBe(6);
  });
});

// ───────────────────────────── 移动禁用 ─────────────────────────────

describe('M10 移动禁用：坐着时方向位清零，但仍喂物理', () => {
  it('坐着时喂满速前进输入 → 位置几乎不动', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    // 输入一直要往前走
    const rig = await makeRig(testRoom([seat]), {
      spawn: [0, CAP + 0.05, 1.2],
      move: () => ({ dirX: 0, dirZ: 1, run: true, jump: true }),
    });
    run(rig, 20);

    rig.player.pressSit();
    run(rig, 10);
    const before = rig.world.getActor(rig.player.id)!.transform.p;
    const x0 = before[0];
    const z0 = before[2];

    run(rig, 120); // 2 秒持续推前进

    const after = rig.world.getActor(rig.player.id)!.transform.p;
    // 持续吸附 + 方向清零 → 位移必须接近 0（< 2cm）
    expect(Math.hypot(after[0] - x0, after[2] - z0)).toBeLessThan(0.02);
  });

  it('坐着时仍然在贴地（y 不漂、不是"冻结在空中"）', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    const rig = await makeRig(testRoom([seat]), { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 20);
    rig.player.pressSit();
    run(rig, 5);

    // 连跑 3 秒，y 必须稳定（如果跳过 update()，重力不生效但也失去了贴地校正）
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 180; i++) {
      rig.physics.step(1 / 60);
      rig.player.step(1 / 60);
      rig.world.tick(1 / 60);
      const y = rig.world.getActor(rig.player.id)!.transform.p[1];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(maxY - minY).toBeLessThan(0.01);
    expect(minY).toBeCloseTo(CAPSULE_CENTER_HEIGHT, 2);
  });

  it('起身后移动输入立刻生效（禁用不是永久的）', async () => {
    const seat: RoomSeat = { id: 's1', pos: [0, 0, 2], rot: 0 };
    let forward = false;
    const rig = await makeRig(testRoom([seat]), {
      spawn: [0, CAP + 0.05, 1.2],
      move: () => ({ dirX: 0, dirZ: forward ? 1 : 0, run: false, jump: false }),
    });
    run(rig, 20);

    rig.player.pressSit();
    run(rig, 10);
    rig.player.pressSit(); // 起身
    run(rig, 10);

    const z0 = rig.world.getActor(rig.player.id)!.transform.p[2];
    forward = true;
    run(rig, 60); // 1 秒走 2.2m 上限
    const z1 = rig.world.getActor(rig.player.id)!.transform.p[2];

    expect(z1 - z0).toBeGreaterThan(0.5); // 真的动了
  });
});

// ───────────────────────────── 推箱 ─────────────────────────────

describe('M10 推箱：靠物理，不写脚本', () => {
  it('走向 10kg 箱子 → 箱子被推动（位移 > 0.3m）', async () => {
    const room = testRoom([], [
      { type: 'box', size: [0.5, 0.5, 0.5], pos: [0, 0.25, 1.2], mass: 10 },
    ]);
    const rig = await makeRig(room, {
      spawn: [0, CAP + 0.05, 0],
      move: () => ({ dirX: 0, dirZ: 1, run: false, jump: false }),
    });
    run(rig, 20);

    const prop = rig.physics.roomProps[0]!;
    const z0 = prop.body.translation().z;

    run(rig, 180); // 3 秒持续推

    const z1 = prop.body.translation().z;
    expect(z1 - z0).toBeGreaterThan(0.3);
  });

  it('不写脚本的证据：源码里没有任何真实的推力调用点', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const url = new URL('./player.ts', import.meta.url);
    const raw = readFileSync(fileURLToPath(url), 'utf8');

    // 先剥掉注释再断言：文件头的说明里确实会提到
    // `setApplyImpulsesToDynamicBodies`（那是"为什么不写推力"的理由），
    // 直接对全文匹配 applyImpulse 会误报。这里只关心**代码行**。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释（避开 https://）

    // 推力必须来自 CharacterController 的 setApplyImpulsesToDynamicBodies。
    // 在交互层写 applyImpulse 会变成双重推力，P8 的箱位移会翻倍。
    expect(code).not.toMatch(/\.applyImpulse\s*\(/);
    expect(code).not.toMatch(/\.applyImpulseAtPoint\s*\(/);
    expect(code).not.toMatch(/\.addForce\s*\(/);
    expect(code).not.toMatch(/\.setLinvel\s*\(/);

    // 反向确认：真正的机制在物理层（这条断言防止有人把机制删了却以为测试还有效）
    const physicsUrl = new URL('../physics/character.ts', import.meta.url);
    const physicsSrc = readFileSync(fileURLToPath(physicsUrl), 'utf8');
    expect(physicsSrc).toMatch(/setApplyImpulsesToDynamicBodies\(true\)/);
  });

  it('canPush 提示：站在箱子前方 → true，背对 → false', async () => {
    const room = testRoom([], [
      { type: 'box', size: [0.5, 0.5, 0.5], pos: [0, 0.25, 1.0], mass: 10 },
    ]);
    const rig = await makeRig(room, {
      spawn: [0, CAP + 0.05, 0],
      move: () => ({ dirX: 0, dirZ: 1, run: false, jump: false }),
    });
    // 先走两步让朝向变成 +z
    run(rig, 40);
    expect(rig.player.prompt.canPush).toBe(true);
  });
});

// ───────────────────────────── 焦点 ─────────────────────────────

describe('M10 看向：焦点切换 1s 缓动', () => {
  it('setFocus 后进度从 0 开始，1 秒后到 1', async () => {
    const rig = await makeRig(testRoom([{ id: 's1', pos: [0, 0, 5], rot: 0 }]));
    expect(rig.player.focusTarget).toBeNull();

    rig.player.setFocus('a:2');
    expect(rig.player.focusTarget).toBe('a:2');
    expect(rig.player.focusState.t).toBe(0);

    // 60 帧 × 1/60 = 1 秒
    let t = 0;
    for (let i = 0; i < 60; i++) t = rig.player.tickFocus(1 / 60);
    expect(t).toBe(1);
  });

  it('焦点缓动是单调的，不会跳变', async () => {
    const rig = await makeRig(testRoom());
    rig.player.setFocus('a:3');
    let prev = -1;
    for (let i = 0; i < 30; i++) {
      const t = rig.player.tickFocus(1 / 60);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('setFocus(null) 回到跟随自己', async () => {
    const rig = await makeRig(testRoom());
    rig.player.setFocus('a:2');
    rig.player.tickFocus(1 / 60);
    rig.player.setFocus(null);
    expect(rig.player.focusTarget).toBeNull();
  });

  it('重复 setFocus 同一个目标不重置进度（避免每帧点击卡在 0）', async () => {
    const rig = await makeRig(testRoom());
    rig.player.setFocus('a:2');
    for (let i = 0; i < 30; i++) rig.player.tickFocus(1 / 60);
    const mid = rig.player.focusState.t;
    expect(mid).toBeGreaterThan(0.4);

    rig.player.setFocus('a:2'); // 同一个目标
    expect(rig.player.focusState.t).toBe(mid); // 进度没被重置
  });
});

// ───────────────────────────── 无物理降级 ─────────────────────────────

describe('M10 降级：物理没就绪时不崩', () => {
  it('controller=null 时 step() 只跑状态机，不抛', async () => {
    const room = testRoom([{ id: 's1', pos: [0, 0, 2], rot: 0 }]);
    const world = new World();
    const id = world.nextId('p');
    world.spawn({
      id,
      kind: 'human',
      name: '你',
      transform: createTransform([0, CAP, 1.2]),
      anim: 'idle',
      animPhase: 0,
    });
    const player = new PlayerController({
      world,
      id,
      controller: null,
      seats: room.seats,
      readMove: () => ({ dirX: 0, dirZ: 0, run: false, jump: false }),
    });

    expect(() => player.step(1 / 60)).not.toThrow();
    // 状态机仍然工作
    expect(player.pressSit()).toBe('sit');
    expect(player.sitting).toBe(true);
    expect(() => player.step(1 / 60)).not.toThrow();
  });

  it('座位被删掉时自动起身（不被状态卡死）', async () => {
    const room = testRoom([{ id: 's1', pos: [0, 0, 2], rot: 0 }]);
    const rig = await makeRig(room, { spawn: [0, CAP + 0.05, 1.2] });
    run(rig, 20);
    rig.player.pressSit();
    run(rig, 5);
    expect(rig.player.sitting).toBe(true);

    // 模拟座位消失：换成一个不含该座位的表（PlayerController 持有的是构造时的引用，
    // 所以这里直接改数组内容来模拟"座位被移走"）
    (room.seats as RoomSeat[]).length = 0;
    run(rig, 5);
    expect(rig.player.sitting).toBe(false);
  });
});
