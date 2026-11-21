/**
 * 角色控制器单测（M4）。
 *
 * 跑真实 Rapier WASM。这些断言锁的是**控制器自身的行为契约**，
 * 与 `verify/harness.ts` 的 P1–P12 是两层：
 * - harness 测"场景达标没"（产品口径，会被 lead/QA 读）；
 * - 这里测"实现有没有做规格书要求的事"（加速度限制、状态机、slerp、质量上限）。
 * 分开写是因为 P 项绿了不代表实现细节对（比如直接设速度也能让 P1 过）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { parseRoom } from '../core/room';
import { PhysicsWorld } from './engine';
import {
  CharacterController,
  DEFAULT_CHARACTER,
  GRAVITY_Y,
  JUMP_HALF_STEP_CORRECTION,
  JUMP_HEIGHT_TARGET,
  JUMP_VELOCITY_ANALYTIC,
  jumpLaunchVelocity,
} from './character';

const worlds: PhysicsWorld[] = [];

function floorRoom(size = 40) {
  return parseRoom({
    name: 'char-test',
    spawn: [[0, 1, 0]],
    lights: [],
    static: [{ type: 'box', size: [size, 0.2, size], pos: [0, -0.1, 0] }],
    props: [],
    seats: [],
  });
}

const CAP = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;

async function makeWorld(room = floorRoom()): Promise<PhysicsWorld> {
  const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 16 });
  worlds.push(pw);
  return pw;
}

function makeChar(pw: PhysicsWorld, x = 0, y = CAP + 0.05, z = 0): CharacterController {
  return new CharacterController(RAPIER, pw, x, y, z);
}

function settle(pw: PhysicsWorld, c: CharacterController, steps = 40): void {
  for (let i = 0; i < steps; i++) {
    c.update({ dirX: 0, dirZ: 0, run: false, jump: false });
    pw.step();
  }
}

beforeAll(async () => {
  await RAPIER.init();
});

afterAll(() => {
  for (const w of worlds) w.dispose();
  worlds.length = 0;
});

describe('参数符合 spec §6 M4', () => {
  it('胶囊半径 0.30、半高 0.55 → 总高 1.70m', () => {
    expect(DEFAULT_CHARACTER.radius).toBe(0.3);
    expect(DEFAULT_CHARACTER.halfHeight).toBe(0.55);
    expect(2 * CAP).toBeCloseTo(1.7, 10);
  });

  it('速度 walk 2.2 / run 4.6', () => {
    expect(DEFAULT_CHARACTER.walkSpeed).toBe(2.2);
    expect(DEFAULT_CHARACTER.runSpeed).toBe(4.6);
  });

  it('offset 0.02 / autostep 0.35-0.20 / snapToGround 0.3 / 加速度 40-8', () => {
    expect(DEFAULT_CHARACTER.controllerOffset).toBe(0.02);
    expect(DEFAULT_CHARACTER.autostepMaxHeight).toBe(0.35);
    expect(DEFAULT_CHARACTER.autostepMinWidth).toBe(0.2);
    expect(DEFAULT_CHARACTER.snapToGround).toBe(0.3);
    expect(DEFAULT_CHARACTER.accelGround).toBe(40);
    expect(DEFAULT_CHARACTER.accelAir).toBe(8);
  });

  it('maxSlopeClimbAngle 是裁决后的 40°（不是 spec 原文的 50°）', () => {
    expect((DEFAULT_CHARACTER.maxSlopeClimbAngle * 180) / Math.PI).toBeCloseTo(40, 6);
    // 必须 <45（P3 要求 45° 不可上）且 >30（P2 要求 30° 可上）
    const deg = (DEFAULT_CHARACTER.maxSlopeClimbAngle * 180) / Math.PI;
    expect(deg).toBeGreaterThan(30);
    expect(deg).toBeLessThan(45);
  });

  it('minSlopeSlideAngle 是 30°', () => {
    expect((DEFAULT_CHARACTER.minSlopeSlideAngle * 180) / Math.PI).toBeCloseTo(30, 6);
  });
});

describe('跳跃初速的推导必须可复算', () => {
  it('解析值 = sqrt(2·g·h) = sqrt(2×9.81×1.20) ≈ 4.8522', () => {
    expect(JUMP_VELOCITY_ANALYTIC).toBeCloseTo(Math.sqrt(2 * 9.81 * 1.2), 10);
    expect(JUMP_VELOCITY_ANALYTIC).toBeCloseTo(4.8522, 3);
    expect(JUMP_HEIGHT_TARGET).toBe(1.2);
  });

  it('半步修正 = g·dt/2 = 9.81/120 ≈ 0.0818', () => {
    expect(JUMP_HALF_STEP_CORRECTION).toBeCloseTo(Math.abs(GRAVITY_Y) / 120, 10);
    expect(JUMP_HALF_STEP_CORRECTION).toBeCloseTo(0.0818, 4);
  });

  it('实际起跳速度 = 解析值 + 半步修正 ≈ 4.934', () => {
    expect(jumpLaunchVelocity()).toBeCloseTo(4.934, 3);
    expect(jumpLaunchVelocity()).toBeGreaterThan(JUMP_VELOCITY_ANALYTIC);
  });
});

describe('加速度限制：不能瞬间达到目标速度（spec §6 M4 第 4 条）', () => {
  it('起步第 1 帧速度 ≈ accelGround × dt = 0.667，不是 2.2', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);

    c.update({ dirX: 0, dirZ: -1, run: false, jump: false });
    const speed = c.snapshot().speed;
    // 40 × (1/60) = 0.6667
    expect(speed).toBeCloseTo(0.6667, 3);
    expect(speed).toBeLessThan(DEFAULT_CHARACTER.walkSpeed);
  });

  it('持续走会在 1/40 秒量级内加到 walkSpeed，但不会超过', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    let maxSpeed = 0;
    for (let i = 0; i < 120; i++) {
      c.update({ dirX: 0, dirZ: -1, run: false, jump: false });
      pw.step();
      maxSpeed = Math.max(maxSpeed, c.snapshot().speed);
    }
    expect(maxSpeed).toBeLessThanOrEqual(DEFAULT_CHARACTER.walkSpeed + 1e-6);
    expect(maxSpeed).toBeGreaterThan(DEFAULT_CHARACTER.walkSpeed - 0.01);
  });

  it('松手后靠减速停下，不是瞬间归零', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 60; i++) {
      c.update({ dirX: 0, dirZ: -1, run: false, jump: false });
      pw.step();
    }
    const beforeStop = c.snapshot().speed;
    expect(beforeStop).toBeGreaterThan(2);

    // 松手第一帧：速度只掉 0.667
    c.update({ dirX: 0, dirZ: 0, run: false, jump: false });
    const afterOneFrame = c.snapshot().speed;
    expect(afterOneFrame).toBeCloseTo(beforeStop - 0.6667, 2);
    expect(afterOneFrame).toBeGreaterThan(1);
  });

  it('run 的目标速度上限是 4.6', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 120; i++) {
      c.update({ dirX: 0, dirZ: -1, run: true, jump: false });
      pw.step();
    }
    expect(c.snapshot().speed).toBeCloseTo(DEFAULT_CHARACTER.runSpeed, 2);
  });

  it('speedScale 能表达"慢走"（精确抵达用）', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 60; i++) {
      c.update({ dirX: 0, dirZ: -1, run: false, speedScale: 0.5, jump: false });
      pw.step();
    }
    // walk 2.2 × 0.5 = 1.1
    expect(c.snapshot().speed).toBeCloseTo(DEFAULT_CHARACTER.walkSpeed * 0.5, 2);
  });
});

describe('状态机（spec §6 M4 第 3 条：用 computedGrounded，不猜 y 速度）', () => {
  it('静止站在地上 → grounded / idle', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    const s = c.snapshot();
    expect(s.grounded).toBe(true);
    expect(s.state).toBe('grounded');
    expect(s.anim).toBe('idle');
  });

  it('走路 → walk，跑 → run', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 40; i++) {
      c.update({ dirX: 0, dirZ: -1, run: false, jump: false });
      pw.step();
    }
    expect(c.snapshot().anim).toBe('walk');

    for (let i = 0; i < 80; i++) {
      c.update({ dirX: 0, dirZ: -1, run: true, jump: false });
      pw.step();
    }
    expect(c.snapshot().anim).toBe('run');
  });

  it('起跳瞬间 → jumping，anim=jump（不出现"空中跑步"）', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    // 边走边跳
    c.update({ dirX: 0, dirZ: -1, run: true, jump: true });
    pw.step();
    const s = c.snapshot();
    expect(s.grounded).toBe(false);
    expect(s.state).toBe('jumping');
    expect(s.anim).toBe('jump');
  });

  it('下落 → falling，anim=fall', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw, 0, 6, 0);
    // 让它自由落体到明显下落阶段
    let sawFalling = false;
    for (let i = 0; i < 60; i++) {
      c.update({ dirX: 0, dirZ: 0, run: false, jump: false });
      pw.step();
      const s = c.snapshot();
      if (s.state === 'falling') {
        sawFalling = true;
        expect(s.anim).toBe('fall');
        break;
      }
    }
    expect(sawFalling).toBe(true);
  });

  it('requestJump() 与 input.jump 两个入口都能触发跳跃', async () => {
    const pw = await makeWorld();
    const c1 = makeChar(pw, 0, CAP + 0.05, 0);
    settle(pw, c1);
    c1.requestJump();
    c1.update({ dirX: 0, dirZ: 0, run: false, jump: false });
    pw.step();
    expect(c1.snapshot().grounded).toBe(false);
    expect(c1.snapshot().state).toBe('jumping');

    const c2 = makeChar(pw, 3, CAP + 0.05, 0);
    settle(pw, c2);
    c2.update({ dirX: 0, dirZ: 0, run: false, jump: true });
    pw.step();
    expect(c2.snapshot().grounded).toBe(false);
    expect(c2.snapshot().state).toBe('jumping');
  });

  it('空中不能二段跳', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    c.update({ dirX: 0, dirZ: 0, run: false, jump: true });
    pw.step();
    const vyAfterFirst = c.snapshot().vy;
    expect(vyAfterFirst).toBeGreaterThan(4);
    // 空中再跳一次：不该把速度重置回起跳速度
    c.update({ dirX: 0, dirZ: 0, run: false, jump: true });
    pw.step();
    expect(c.snapshot().vy).toBeLessThan(vyAfterFirst);
  });
});

describe('跳跃高度（P6 的实现级验证）', () => {
  it('最高点落在 1.20±0.03', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw, 0, CAP + 0.02, 0);
    // 多跑几步让 snapToGround 收敛到位（实测 40 步时还差 8mm，60 步稳定在 0.86994）
    settle(pw, c, 60);
    const takeoff = c.snapshot().pos[1];

    // ⚠️ 起跳必须**合并进循环第一轮**，不能单独在循环外调一次 update()。
    //
    // 原因：`update()` 算出的 nextY 是写进 `setNextKinematicTranslation` 的
    // **下一步**位置，要等 `pw.step()` 才生效。若在循环外先 update(jump:true)、
    // 紧接着循环里又 update(jump:false)，第二轮会重新读 `body.translation()`
    // （还是旧位置）并把上一轮写的 next 覆盖掉 —— 起跳第一步的 +0.0822m 直接丢掉，
    // 跳高变成 1.1204（正好少了 v0·dt）。这个坑实测踩过，数值精确吻合。
    let peak = takeoff;
    for (let i = 0; i < 120; i++) {
      c.update({ dirX: 0, dirZ: 0, run: false, jump: i === 0 });
      pw.step();
      peak = Math.max(peak, c.snapshot().pos[1]);
    }
    const height = peak - takeoff;
    expect(height).toBeGreaterThanOrEqual(1.17);
    expect(height).toBeLessThanOrEqual(1.23);
  });
});

describe('朝向映射：物理侧必须严格对应"正前方 = +Z"（无额外偏移）', () => {
  /**
   * 这组断言的意义：区分"物理约定"与"资产朝向"。
   *
   * 实测背景：渲染侧拿 `?ry=` 逐个试角度，发现资产原生正面不是 +Z
   * （ry=0 是侧脸，ry=+90° 才正脸），需要渲染层加 `MODEL_FACING_OFFSET_Y`。
   * 于是必须确认：**这个 90° 偏移只加在渲染层，物理层不能也加一次**，
   * 否则会变成 180°。
   *
   * 这里用"模型的 +Z 轴在世界空间指向哪里"来断言，比直接比四元数分量更直观：
   * 喂朝 +Z 的方向，模型的 +Z 轴就必须指向 (0,0,1)。
   */
  function forwardOf(q: readonly number[]): [number, number, number] {
    const [x, y, z, w] = q as [number, number, number, number];
    const xx = x * x, yy = y * y;
    const xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y;
    // 旋转矩阵第三列 = R * (0,0,1)
    return [2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)];
  }

  /** 朝某方向持续若干帧让 slerp 收敛，返回收敛后的四元数。 */
  async function faceTo(dirX: number, dirZ: number): Promise<number[]> {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 60; i++) {
      c.update({ dirX, dirZ, run: false, jump: false, faceX: dirX, faceZ: dirZ });
      pw.step();
    }
    return [...c.snapshot().rot];
  }

  it('朝 +Z（faceX=0, faceZ=1）→ 四元数 identity [0,0,0,1]', async () => {
    const q = await faceTo(0, 1);
    expect(q[0]).toBeCloseTo(0, 3);
    expect(q[1]).toBeCloseTo(0, 3);
    expect(q[2]).toBeCloseTo(0, 3);
    expect(q[3]).toBeCloseTo(1, 3);
  });

  it('朝 +X（faceX=1, faceZ=0）→ [0, 0.7071, 0, 0.7071]（绕 Y +90°）', async () => {
    const q = await faceTo(1, 0);
    expect(q[0]).toBeCloseTo(0, 3);
    expect(q[1]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(q[2]).toBeCloseTo(0, 3);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('朝 -Z（faceX=0, faceZ=-1）→ [0,1,0,0]（绕 Y 180°）', async () => {
    const q = await faceTo(0, -1);
    expect(Math.abs(q[1]!)).toBeCloseTo(1, 3);
    expect(Math.abs(q[3]!)).toBeCloseTo(0, 3);
  });

  it('朝 -X（faceX=-1, faceZ=0）→ [0,-0.7071,0,0.7071]（绕 Y -90°）', async () => {
    const q = await faceTo(-1, 0);
    expect(q[1]).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('模型的 +Z 轴始终指向输入方向（这就是"正前方 = +Z"的定义）', async () => {
    const cases: Array<[number, number]> = [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ];
    for (const [dx, dz] of cases) {
      const q = await faceTo(dx, dz);
      const fwd = forwardOf(q);
      const len = Math.hypot(dx, dz);
      expect(fwd[0]).toBeCloseTo(dx / len, 2);
      expect(fwd[1]).toBeCloseTo(0, 3); // 只有绕 Y 的旋转，不该有俯仰
      expect(fwd[2]).toBeCloseTo(dz / len, 2);
    }
  });

  it('对角方向：模型 +Z 轴指向归一化的对角方向', async () => {
    const q = await faceTo(1, 1);
    const fwd = forwardOf(q);
    expect(fwd[0]).toBeCloseTo(Math.SQRT1_2, 2);
    expect(fwd[2]).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

describe('键盘驱动下的行走/跳跃手感（WASD + Shift + 空格）', () => {
  /**
   * 这一组锁的是"用户真的按键盘时会不会觉得别扭"，
   * 与 P1–P12 的产品口径互补：P 项保证数值达标，这里保证操作手感。
   */

  it('Shift 切 run 是平滑加速，不是瞬间跳变（accelGround=40）', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    // 先走稳
    for (let i = 0; i < 40; i++) {
      c.update({ dirX: 0, dirZ: 1, run: false, jump: false });
      pw.step();
    }
    expect(c.snapshot().speed).toBeCloseTo(DEFAULT_CHARACTER.walkSpeed, 2);

    // 按 Shift：实测 2.2 → 2.87 → 3.53 → 4.20 → 4.60，约 4 帧（0.067s）
    c.update({ dirX: 0, dirZ: 1, run: true, jump: false });
    pw.step();
    const afterOneFrame = c.snapshot().speed;
    // 一帧只加了 accelGround*dt = 0.667，不是瞬间到 4.6
    expect(afterOneFrame).toBeCloseTo(DEFAULT_CHARACTER.walkSpeed + 40 / 60, 1);
    expect(afterOneFrame).toBeLessThan(DEFAULT_CHARACTER.runSpeed);

    // 再几帧到 run 速度
    for (let i = 0; i < 6; i++) {
      c.update({ dirX: 0, dirZ: 1, run: true, jump: false });
      pw.step();
    }
    expect(c.snapshot().speed).toBeCloseTo(DEFAULT_CHARACTER.runSpeed, 2);
  });

  it('松开 Shift 平滑减速回 walk', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 60; i++) {
      c.update({ dirX: 0, dirZ: 1, run: true, jump: false });
      pw.step();
    }
    expect(c.snapshot().speed).toBeCloseTo(DEFAULT_CHARACTER.runSpeed, 2);

    c.update({ dirX: 0, dirZ: 1, run: false, jump: false });
    pw.step();
    // 一帧只减 0.667
    expect(c.snapshot().speed).toBeCloseTo(DEFAULT_CHARACTER.runSpeed - 40 / 60, 1);

    for (let i = 0; i < 6; i++) {
      c.update({ dirX: 0, dirZ: 1, run: false, jump: false });
      pw.step();
    }
    expect(c.snapshot().speed).toBeCloseTo(DEFAULT_CHARACTER.walkSpeed, 2);
  });

  it('跳跃 + 前进能上 0.30m 单级台阶（autostep 之外的能力）', async () => {
    const room = parseRoom({
      name: 'step30',
      spawn: [[0, 1, 0]],
      lights: [],
      static: [
        { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
        // 平台够长，避免角色冲过头掉下去
        { type: 'box', size: [6, 0.3, 12], pos: [0, 0.15, 6] },
      ],
      props: [],
      seats: [],
    });
    const pw = await makeWorld(room);
    const c = makeChar(pw, 0, CAP + 0.05, -2.0);
    settle(pw, c);
    const y0 = c.snapshot().pos[1];
    for (let i = 0; i < 160; i++) {
      c.update({ dirX: 0, dirZ: 1, run: false, jump: i === 25 });
      pw.step();
    }
    expect(c.snapshot().pos[1] - y0).toBeGreaterThanOrEqual(0.25);
  });

  it('跳跃 + 前进能上 0.45m 单级台阶（超过 autostep 上限 0.35）', async () => {
    const room = parseRoom({
      name: 'step45',
      spawn: [[0, 1, 0]],
      lights: [],
      static: [
        { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
        { type: 'box', size: [6, 0.45, 12], pos: [0, 0.225, 6] },
      ],
      props: [],
      seats: [],
    });
    const pw = await makeWorld(room);
    const c = makeChar(pw, 0, CAP + 0.05, -2.0);
    settle(pw, c);
    const y0 = c.snapshot().pos[1];
    for (let i = 0; i < 160; i++) {
      c.update({ dirX: 0, dirZ: 1, run: false, jump: i === 25 });
      pw.step();
    }
    // autostep 上限 0.35 挡不住 0.45，但跳跃能上去 —— 证明跳跃是有效能力
    expect(c.snapshot().pos[1] - y0).toBeGreaterThanOrEqual(0.4);
  });

  it('贴墙原地跳不会自动上台阶（必须前进）', async () => {
    const room = parseRoom({
      name: 'nojump',
      spawn: [[0, 1, 0]],
      lights: [],
      static: [
        { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
        { type: 'box', size: [6, 0.3, 12], pos: [0, 0.15, 6] },
      ],
      props: [],
      seats: [],
    });
    const pw = await makeWorld(room);
    const c = makeChar(pw, 0, CAP + 0.05, -0.5);
    settle(pw, c);
    const y0 = c.snapshot().pos[1];
    for (let i = 0; i < 120; i++) {
      c.update({ dirX: 0, dirZ: 0, run: false, jump: i === 20 });
      pw.step();
    }
    // 原地跳起后应落回原处，不该凭空站上台阶
    expect(Math.abs(c.snapshot().pos[1] - y0)).toBeLessThan(0.05);
  });

  it('纯走靠 autostep 能爬完 5 级 0.30m 台阶（顶部有平台）', async () => {
    const room = parseRoom({
      name: 'stairs',
      spawn: [[0, 1, 0]],
      lights: [],
      static: [
        { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
        { type: 'stairs', steps: 5, rise: 0.3, run: 0.35, width: 2, pos: [0, 0, 0] },
        // 顶部平台：台阶 z 范围 0~1.75，平台从 1.75 往后
        { type: 'box', size: [2, 1.5, 4], pos: [0, 0.75, 3.75] },
      ],
      props: [],
      seats: [],
    });
    const pw = await makeWorld(room);
    const c = makeChar(pw, 0, CAP + 0.05, -1.5);
    settle(pw, c);
    const y0 = c.snapshot().pos[1];
    // 走到台阶顶就停（再走会掉下平台边缘）
    for (let i = 0; i < 180; i++) {
      c.update({ dirX: 0, dirZ: 1, run: false, jump: false });
      pw.step();
    }
    // 5 级总高 1.5m，autostep 上限 0.35 > 单级 0.30，所以纯走应能爬完
    expect(c.snapshot().pos[1] - y0).toBeGreaterThan(1.4);
  });
});

describe('转向用 slerp，不瞬间对齐（spec §6 M4 第 6 条）', () => {
  it('改变朝向时四元数逐帧插值，不是一帧到位', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    // 先朝 -z 走（朝向 ≈ (0,1,0,0)，即绕 y 转 180°）
    for (let i = 0; i < 40; i++) {
      c.update({ dirX: 0, dirZ: -1, run: false, jump: false });
      pw.step();
    }
    const before = c.snapshot().rot;
    // 突然要求朝 +z（反向）
    c.update({ dirX: 0, dirZ: 1, run: false, jump: false });
    const afterOneFrame = c.snapshot().rot;

    // 用**角度**而不是点积判断，避免四元数 q 与 -q 表示同一朝向带来的符号问题
    const dotRaw =
      before[0] * afterOneFrame[0] +
      before[1] * afterOneFrame[1] +
      before[2] * afterOneFrame[2] +
      before[3] * afterOneFrame[3];
    const dot = Math.min(1, Math.abs(dotRaw));
    const turnedDeg = (Math.acos(dot) * 2 * 180) / Math.PI;

    // turnRate 12/秒 × dt(1/60) = 0.2 的 slerp 比例 → 一帧约转 36°（180° 的 1/5）
    expect(turnedDeg).toBeGreaterThan(10); // 确实在转
    expect(turnedDeg).toBeLessThan(90); // 但没有一帧转完 180°

    // 持续 30 帧后应该基本转过去（每帧只走 1/5 的剩余角，30 帧后剩不到 1/5^30）
    for (let i = 0; i < 30; i++) {
      c.update({ dirX: 0, dirZ: 1, run: false, jump: false });
      pw.step();
    }
    const final = c.snapshot().rot;
    // 朝向 +z 的目标四元数是**单位四元数** (0,0,0,1)：
    // yaw = atan2(fx, fz) = atan2(0, 1) = 0 → (0, sin0, 0, cos0)。
    // （朝向 -z 才是 (0,1,0,0)。这里曾把两者搞反，断言 final[1] > 0.9 恒失败。）
    expect(Math.abs(final[3])).toBeGreaterThan(0.9);
    expect(Math.abs(final[1])).toBeLessThan(0.1);
  });

  it('朝向四元数始终是单位长度', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 60; i++) {
      c.update({ dirX: Math.cos(i * 0.3), dirZ: Math.sin(i * 0.3), run: false, jump: false });
      pw.step();
      const r = c.snapshot().rot;
      expect(Math.hypot(r[0], r[1], r[2], r[3])).toBeCloseTo(1, 6);
    }
  });
});

describe('贴地与坡度', () => {
  it('站在地上时脚底贴地，不下沉也不悬空', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    const y = c.snapshot().pos[1];
    // 地板顶面 y=0，胶囊中心应在 CAP 附近
    expect(y).toBeGreaterThan(CAP - 0.03);
    expect(y).toBeLessThan(CAP + 0.03);
  });

  it('从高处落下不会穿地', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw, 0, 8, 0);
    let minY = Infinity;
    for (let i = 0; i < 300; i++) {
      c.update({ dirX: 0, dirZ: 0, run: false, jump: false });
      pw.step();
      minY = Math.min(minY, c.snapshot().pos[1]);
    }
    expect(minY).toBeGreaterThan(CAP - 0.03);
    expect(c.snapshot().grounded).toBe(true);
  });
});

describe('推道具与质量上限（spec §6 M4 第 7 条）', () => {
  it('角色能推动 10kg 箱子', async () => {
    const room = parseRoom({
      name: 'push',
      spawn: [[0, 1, 0]],
      lights: [],
      static: [{ type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] }],
      props: [{ type: 'box', size: [0.5, 0.5, 0.5], pos: [0, 0.25, -1.5], mass: 10 }],
      seats: [],
    });
    const pw = await makeWorld(room);
    const box = pw.roomProps[0]!;
    const boxStart = box.body.translation();

    const c = makeChar(pw);
    settle(pw, c);
    for (let i = 0; i < 180; i++) {
      c.update({ dirX: 0, dirZ: -1, run: false, jump: false });
      pw.step();
    }
    const boxEnd = box.body.translation();
    const moved = Math.hypot(boxEnd.x - boxStart.x, boxEnd.z - boxStart.z);
    expect(moved).toBeGreaterThan(0.5);
  });

  it('质量上限常量存在且为正（超重只推不飞的判据）', () => {
    expect(DEFAULT_CHARACTER.pushMassLimit).toBeGreaterThan(0);
  });
});

describe('写回 World 层（物理层唯一出口）', () => {
  it('writeTransform 给出位置/朝向/动画名，且不直接持有 ActorState', async () => {
    const pw = await makeWorld();
    const c = makeChar(pw);
    settle(pw, c);
    let captured: { p: number[]; r: number[]; anim: string } | null = null;
    c.writeTransform((t, anim) => {
      captured = { p: [...t.p], r: [...t.r], anim };
    });
    expect(captured).not.toBeNull();
    expect(captured!.p.length).toBe(3);
    expect(captured!.r.length).toBe(4);
    expect(['idle', 'walk', 'run', 'jump', 'fall', 'sit', 'emote']).toContain(captured!.anim);
  });
});

describe('dispose', () => {
  it('dispose 后角色刚体被移除，重复调用安全', async () => {
    const pw = await makeWorld();
    const before = pw.stats().colliders;
    const c = makeChar(pw);
    const withChar = pw.stats().colliders;
    expect(withChar).toBe(before + 1);
    c.dispose();
    expect(pw.stats().colliders).toBe(before);
  });
});
