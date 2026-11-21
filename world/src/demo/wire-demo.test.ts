import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { World } from '../core/world';
import { parseRoom, type Room } from '../core/room';
import { PhysicsWorld } from '../physics/engine';
import { DEFAULT_CHARACTER } from '../physics/character';
import { PHYSICS_DT } from '../core/types';
import { startAgentDemo, type AgentDemoHandle } from './wire-demo';
import { buildDemoAgents, LOOP_PERIOD } from './agents-demo';

/**
 * `startAgentDemo` 的**接线契约**测试。
 *
 * 这些用例存在的理由：`main.ts` 的接线是 render-agent 做的（task-9），
 * 他只能靠 `wire-demo.ts` 文件头的契约来写。所以契约里承诺的每一条
 * （参数、步进顺序、`avatars` 清单、`elapsed()`、`dispose()`）
 * 都必须在这里被断言，否则"文件头说一套、代码做另一套"没人发现。
 */

const CAPSULE_CENTER = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;

function demoRoom(): Room {
  return parseRoom({
    name: 'wire-test',
    spawn: [[0, 0, 0]],
    lights: [],
    static: [{ type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] }],
    props: [],
    seats: [],
  });
}

/** 按文件头契约里的顺序跑 n 步：physics.step → demo.tick → world.tick。 */
function run(demo: AgentDemoHandle, physics: PhysicsWorld, world: World, n: number): void {
  for (let i = 0; i < n; i++) {
    physics.step(PHYSICS_DT);
    demo.tick();
    world.tick(PHYSICS_DT);
  }
}

describe('startAgentDemo 接线契约（main.ts 照这个接）', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('返回句柄含 runtimes / avatars / system / elapsed / tick / dispose', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
    try {
      expect(Array.isArray(demo.runtimes)).toBe(true);
      expect(Array.isArray(demo.avatars)).toBe(true);
      expect(typeof demo.tick).toBe('function');
      expect(typeof demo.elapsed).toBe('function');
      expect(typeof demo.dispose).toBe('function');
      expect(demo.system).toBeDefined();
    } finally {
      demo.dispose();
      physics.dispose();
    }
  });

  it('默认 6 个 Agent，全部出现在 world 里且 kind=agent', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
    try {
      expect(demo.runtimes).toHaveLength(6);
      expect(demo.avatars).toHaveLength(6);
      for (const rt of demo.runtimes) {
        const a = world.getActor(rt.id);
        expect(a).toBeDefined();
        expect(a!.kind).toBe('agent');
      }
    } finally {
      demo.dispose();
      physics.dispose();
    }
  });

  it('avatars 清单是纯数据：id/name/tint/spawn/index 齐全，且与 runtimes 同序', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
    try {
      const specs = buildDemoAgents(6);
      for (let i = 0; i < demo.avatars.length; i++) {
        const av = demo.avatars[i]!;
        // id 与 runtimes 同序
        expect(av.id).toBe(demo.runtimes[i]!.id);
        // name / tint 与 buildDemoAgents 一致（渲染层按这个取资产变体）
        expect(av.name).toBe(specs[i]!.name);
        expect(av.tint).toBe(specs[i]!.tint);
        expect(av.index).toBe(i);
        // spawn 是 3 个有限数
        expect(av.spawn).toHaveLength(3);
        for (const v of av.spawn) expect(Number.isFinite(v)).toBe(true);
        // 纯数据：没有方法、没有物理句柄泄漏
        expect(Object.values(av).every((v) => typeof v !== 'function')).toBe(true);
      }
    } finally {
      demo.dispose();
      physics.dispose();
    }
  });

  it('契约顺序（physics.step → demo.tick → world.tick）下 Agent 真的动起来', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
    try {
      // 落地 + 跑过第一轮相位（6 号要等到 2.5s）
      run(demo, physics, world, 30 + 300);

      let moved = 0;
      for (const rt of demo.runtimes) {
        const a = world.getActor(rt.id);
        expect(a).toBeDefined();
        // 所有 Agent 都该离开出生点（相位错开也要在 2.5s 后开始走）
        const sp = demo.avatars.find((v) => v.id === rt.id)!.spawn;
        const d = Math.hypot(a!.transform.p[0] - sp[0], a!.transform.p[2] - sp[2]);
        if (d > 0.3) moved += 1;
      }
      expect(moved).toBeGreaterThanOrEqual(5);
    } finally {
      demo.dispose();
      physics.dispose();
    }
  });

  it('elapsed() 随物理步推进，且从 0 附近开始（不是绝对 world.now）', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    try {
      // 先空跑一些世界时间，验证 elapsed 是相对的
      for (let i = 0; i < 60; i++) world.tick(PHYSICS_DT);
      const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
      try {
        expect(demo.elapsed()).toBeCloseTo(0, 6);
        run(demo, physics, world, 60);
        expect(demo.elapsed()).toBeCloseTo(1, 2);
      } finally {
        demo.dispose();
      }
    } finally {
      physics.dispose();
    }
  });

  it('dispose 后所有 Agent 从 world 消失（不留孤儿实体）', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
    run(demo, physics, world, 60);
    const ids = demo.runtimes.map((r) => r.id);
    expect(world.actorCount).toBe(6);

    demo.dispose();
    expect(world.actorCount).toBe(0);
    for (const id of ids) expect(world.has(id)).toBe(false);
    physics.dispose();
  });

  it('不传 physics/RAPIER 时降级为无物理模式（不抛，Agent 仍在世界里）', async () => {
    const world = new World();
    const room = demoRoom();
    const demo = startAgentDemo({ world, room, logFailures: false });
    try {
      expect(demo.runtimes).toHaveLength(6);
      expect(world.actorCount).toBe(6);
      // 无控制器 → 不该抛
      expect(() => {
        for (let i = 0; i < 30; i++) {
          demo.tick();
          world.tick(PHYSICS_DT);
        }
      }).not.toThrow();
    } finally {
      demo.dispose();
    }
  });

  it('count 可调（3 个），相位间隔随之变成 LOOP_PERIOD/3', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, count: 3, logFailures: false });
    try {
      expect(demo.runtimes).toHaveLength(3);
      expect(demo.avatars).toHaveLength(3);

      // 记录首次开口时刻
      const first = new Map<string, number>();
      world.events.on('actor:say', (e) => {
        if (!first.has(e.id)) first.set(e.id, world.now);
      });
      run(demo, physics, world, 30 + 300);

      expect(first.size).toBe(3);
      const times = [...first.values()].sort((a, b) => a - b);
      const gap = LOOP_PERIOD / 3;
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeCloseTo(gap, 1);
      }
    } finally {
      demo.dispose();
      physics.dispose();
    }
  });

  it('渲染层需要的动画状态能从 world 读到（不是从 controller 读）', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
    try {
      run(demo, physics, world, 30 + 120);
      let sawWalkOrIdle = false;
      for (const rt of demo.runtimes) {
        const a = world.getActor(rt.id)!;
        // anim 必须是协议里的 7 个之一
        expect(['idle', 'walk', 'run', 'jump', 'fall', 'sit', 'emote']).toContain(a.anim);
        // 位置是有限数（渲染层直接拿去插值，NaN 会让整个场景消失）
        for (const v of a.transform.p) expect(Number.isFinite(v)).toBe(true);
        for (const v of a.transform.r) expect(Number.isFinite(v)).toBe(true);
        // 朝向四元数已归一化
        const len = Math.hypot(...a.transform.r);
        expect(len).toBeCloseTo(1, 3);
        if (a.anim === 'walk' || a.anim === 'idle') sawWalkOrIdle = true;
      }
      expect(sawWalkOrIdle).toBe(true);
    } finally {
      demo.dispose();
      physics.dispose();
    }
  });

  it('Agent 贴地不悬空（y ≈ 胶囊中心高，误差 < 6cm）', async () => {
    const world = new World();
    const room = demoRoom();
    const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 8 });
    const demo = startAgentDemo({ world, physics, RAPIER, room, logFailures: false });
    try {
      run(demo, physics, world, 30 + 200);
      for (const rt of demo.runtimes) {
        const y = world.getActor(rt.id)!.transform.p[1];
        expect(Math.abs(y - CAPSULE_CENTER)).toBeLessThan(0.06);
      }
    } finally {
      demo.dispose();
      physics.dispose();
    }
  });
});
