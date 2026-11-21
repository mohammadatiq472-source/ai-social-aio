import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { World } from '../core/world';
import { parseRoom, type Room } from '../core/room';
import { PhysicsWorld } from '../physics/engine';
import { CharacterController, DEFAULT_CHARACTER } from '../physics/character';
import { AgentSystem } from '../agents/system';
import { FAIL_REASON, isFailure } from '../agents/queue';
import { PHYSICS_DT } from '../core/types';

/**
 * M9 端到端集成测试：**真物理** + 真意图队列 + 真感知。
 *
 * 与 `system.test.ts` 的区别：那个是"无物理模式"（不提供 `createController`），
 * 测的是意图逻辑；这里接 Rapier，测的是
 *   Intent → ControlInput → CharacterController → 实体表
 * 这条**完整链路**，以及"执行器不写 transform"这个硬约束在真物理下是否成立。
 *
 * ═══════════ 两条被实测逼出来的纪律（第一版都写错了）═══════════
 *
 * **1. 步进顺序必须与 `main.ts` 一致：`physics.step()` → `system.tick()`。**
 *    第一版写成 `system.tick() → physics.step()`，结果"控制器位置"与
 *    "实体表位置"稳定差 0.0367m —— 那正好是 2.2m/s × 1/60 的**一帧滞后**，
 *    不是 bug，是顺序错了：`controller.update()` 设的是
 *    `setNextKinematicTranslation`（下一步才生效），所以它必须在 step **之后**跑，
 *    `writeTransform()` 才能读到本步结算完的真实位置。
 *    `main.ts` 的真实顺序就是 `physics.step(fixedDt)` 然后 `world.tick(fixedDt)`
 *    （agent 系统作为 World system 在 tick 里跑），所以这里是同一个顺序。
 *
 * **2. 每个用例必须自建世界。**
 *    第一版所有用例共用一个 World，于是"落地测试"留在原点的 Agent 把
 *    "走位测试"的 Agent 挡住了：目标 (0,0,-3) 走到了，但净位移只有 2.34m。
 *    这跟 spec §7 的验收纪律是同一条（每条用例自建隔离世界、跑完 dispose）。
 */

const CAPSULE_CENTER = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;

/** 平地房间。 */
function flatRoom(): Room {
  return parseRoom({
    name: 'm9-e2e',
    spawn: [[0, 0, 0]],
    lights: [],
    static: [{ type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] }],
    props: [],
    seats: [{ id: 'seat-a', pos: [0, 0, 3], rot: 0 }],
  });
}

/** 带墙房间：墙在 z=-2（厚 0.2 → 面在 -1.9）。 */
function wallRoom(): Room {
  return parseRoom({
    name: 'm9-wall',
    spawn: [[0, 0, 0]],
    lights: [],
    static: [
      { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
      { type: 'box', size: [20, 3, 0.2], pos: [0, 1.5, -2] },
    ],
    props: [],
    seats: [],
  });
}

interface Harness {
  world: World;
  physics: PhysicsWorld;
  system: AgentSystem;
  controllers: Map<string, CharacterController>;
  /** 与 main.ts 同序：physics.step → system.tick → world.tick。 */
  step(n?: number): void;
  /** 进场并瞬移到指定水平位置（y 用胶囊中心高，落地由物理负责）。 */
  spawn(name: string, x: number, z: number): string;
  dispose(): void;
}

async function makeHarness(room: Room): Promise<Harness> {
  const world = new World();
  const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
  const controllers = new Map<string, CharacterController>();
  const system = new AgentSystem({
    world,
    room,
    createController: (id) => {
      const c = new CharacterController(RAPIER, physics, 0, CAPSULE_CENTER + 0.05, 0);
      controllers.set(id, c);
      return c;
    },
  });

  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      // 顺序与 main.ts 一致：物理先结算，系统再读结算结果并产出下一步输入
      physics.step(PHYSICS_DT);
      system.tick();
      world.tick(PHYSICS_DT);
    }
  };

  const spawn = (name: string, x: number, z: number): string => {
    const rt = system.join({ name, spawnPos: [x, 0, z] });
    controllers.get(rt.id)!.teleport(x, CAPSULE_CENTER + 0.05, z);
    return rt.id;
  };

  return {
    world,
    physics,
    system,
    controllers,
    step,
    spawn,
    dispose(): void {
      system.dispose();
      physics.dispose();
    },
  };
}

describe('M9 端到端（真物理）', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('join 后 Agent 落地到地面（y ≈ 胶囊中心高，误差 < 5cm）', async () => {
    const h = await makeHarness(flatRoom());
    try {
      const id = h.spawn('落地', 0, 0);
      h.step(60);
      const p = h.world.getActor(id)!.transform.p;
      expect(Math.abs(p[1] - CAPSULE_CENTER)).toBeLessThan(0.05);
      expect(p[1]).toBeCloseTo(CAPSULE_CENTER, 1);
    } finally {
      h.dispose();
    }
  });

  it('move 意图在真物理下把角色走到目标（误差 < 0.35m，净位移 > 2.5m）', async () => {
    const h = await makeHarness(flatRoom());
    try {
      const id = h.spawn('走位', 0, 0);
      h.step(30); // 落地稳定

      const start = h.world.getActor(id)!.transform.p;
      const rt = h.system.get(id)!;
      h.system.submit(id, { t: 'move', to: [0, 0, -3] });
      // 3m / 2.2mps ≈ 82 步；给 180 步余量（含加速度爬升）。
      // 注意不能写 `for (...; rt.executor.busy; ...)`：刚提交时意图还没被
      // 取出来，busy 仍是 false，循环会 0 次 —— 第一版就是这么错的，
      // 表现为"角色一步没走，离目标正好 3.000m"。所以先跑一步再判。
      h.step(1);
      for (let i = 0; i < 180 && rt.executor.busy; i++) h.step(1);

      const end = h.world.getActor(id)!.transform.p;
      const distToTarget = Math.hypot(end[0] - 0, end[2] - -3);
      const moved = Math.hypot(end[0] - start[0], end[2] - start[2]);

      expect(distToTarget).toBeLessThan(0.35);
      expect(moved).toBeGreaterThan(2.5);
      expect(rt.executor.stats.failed).toBe(0);
      expect(rt.executor.stats.completed).toBeGreaterThanOrEqual(1);
    } finally {
      h.dispose();
    }
  });

  it('执行器不写 transform：实体表位置与控制器快照逐步一致（差 < 1mm）', async () => {
    const h = await makeHarness(flatRoom());
    try {
      const id = h.spawn('归因', 0, 0);
      h.step(30);

      const ctrl = h.controllers.get(id)!;
      h.system.submit(id, { t: 'move', to: [0, 0, -3] });
      let maxDivergence = 0;
      for (let i = 0; i < 90; i++) {
        h.step(1);
        const snap = ctrl.snapshot();
        const p = h.world.getActor(id)!.transform.p;
        const d = Math.hypot(snap.pos[0] - p[0], snap.pos[1] - p[1], snap.pos[2] - p[2]);
        if (d > maxDivergence) maxDivergence = d;
      }
      // 允许浮点误差，不允许任何"执行器直接把意图目标写进 transform"级别的偏差
      expect(maxDivergence).toBeLessThan(0.001);
    } finally {
      h.dispose();
    }
  });

  it('撞墙 → failed(blocked)，且角色停在墙前（不穿模）', async () => {
    const h = await makeHarness(wallRoom());
    try {
      const failures: string[] = [];
      h.system.onFailure((e) => failures.push(e.reason));

      const id = h.spawn('撞墙', 0, 0);
      const rt = h.system.get(id)!;
      h.step(30);

      // 目标在墙后 5m：直线走必然撞上
      h.system.submit(id, { t: 'move', to: [0, 0, -5] });
      h.step(120);

      expect(failures).toContain(FAIL_REASON.BLOCKED);
      const p = h.world.getActor(id)!.transform.p;
      // 墙面 z=-1.9，角色半径 0.30 → 中心不该越过 -1.75（留控制器 offset 余量）
      expect(p[2]).toBeGreaterThan(-1.75);
      // 失败后不再"顶着墙继续走"：执行器已停止
      expect(rt.executor.busy).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('say 不阻塞移动：气泡与位移同时发生', async () => {
    const h = await makeHarness(flatRoom());
    try {
      const id = h.spawn('边说边笑', 0, 0);
      h.step(30);
      const start = h.world.getActor(id)!.transform.p;

      h.system.submit(id, { t: 'move', to: [0, 0, -3] });
      h.system.submit(id, { t: 'say', text: '边走边说' });

      // 只跑 10 步（远没走到）：气泡应该已经出现，人已经在动
      h.step(10);
      const a = h.world.getActor(id)!;
      expect(a.bubble?.text).toBe('边走边说');
      const moved = Math.hypot(a.transform.p[0] - start[0], a.transform.p[2] - start[2]);
      expect(moved).toBeGreaterThan(0.1);
    } finally {
      h.dispose();
    }
  });

  it('perceive 在真物理世界里也无副作用（100 次读后世界指纹不变）', async () => {
    const h = await makeHarness(flatRoom());
    try {
      h.spawn('甲', 0, 0);
      const idB = h.spawn('乙', 2, 0);
      h.step(30);

      const fp = (): string =>
        JSON.stringify({ actors: h.world.listActors(), tick: h.world.tickCount, now: h.world.now });
      const before = fp();
      for (let i = 0; i < 100; i++) h.system.perceive(idB);
      expect(fp()).toBe(before);

      const p = h.system.perceive(idB)!;
      expect(p.self.id).toBe(idB);
      expect(p.nearby.length).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });

  it('队列满：前 8 条 ok，后 2 条 failed(queue_full)，当前意图不受影响', async () => {
    const h = await makeHarness(flatRoom());
    try {
      const id = h.spawn('队列满', 0, 0);
      const rt = h.system.get(id)!;
      h.step(30);

      const results = [];
      for (let i = 0; i < 10; i++) results.push(h.system.submit(id, { t: 'wait', ms: 5000 }));
      expect(results.filter((r) => !isFailure(r))).toHaveLength(8);
      expect(results.filter((r) => isFailure(r))).toHaveLength(2);

      const firstFail = results.find((r) => isFailure(r));
      if (firstFail && isFailure(firstFail)) {
        expect(firstFail.reason).toBe(FAIL_REASON.QUEUE_FULL);
        expect(firstFail.intent).toBe('wait');
      }
      // 队列里最旧的仍在队首（拒绝新的，不是丢最旧）
      expect(rt.queue.size).toBe(8);
      expect(rt.queue.peek()!.intent.t).toBe('wait');
    } finally {
      h.dispose();
    }
  });

  it('离场：leave 意图让实体消失，且不影响其他 Agent', async () => {
    const h = await makeHarness(flatRoom());
    try {
      const a = h.spawn('要走', -2, 0);
      const b = h.spawn('留下', 2, 0);
      h.step(20);

      h.system.submit(a, { t: 'leave' });
      h.step(3);
      expect(h.world.has(a)).toBe(false);
      expect(h.world.has(b)).toBe(true);
      expect(h.system.agentCount).toBe(1);
    } finally {
      h.dispose();
    }
  });
});
