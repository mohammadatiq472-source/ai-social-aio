/**
 * 把 6 Agent 演示接到真实世界上的**一行式**接线（spec §6 M9 第 5 条）。
 *
 * 为什么单独一个文件、而不是直接改 `main.ts`：
 * `main.ts` 归 render-agent（M1/M5），M9 不该去动它。这里提供
 * `startAgentDemo(...)`，`main.ts` 只要加三行。
 *
 * ═════════════════════ 调用契约（照抄即可，别猜）═════════════════════
 *
 * ```ts
 * // ① 物理就绪之后（PhysicsWorld.create 的 await 之后）建一次：
 * const demo = startAgentDemo({
 *   world,              // core/world.ts 的 World 实例（必须与渲染层同一个）
 *   physics,            // physics/engine.ts 的 PhysicsWorld 实例
 *   RAPIER,             // await import('@dimforge/rapier3d-compat') 的 default
 *   room: DEMO_ROOM,    // 与 PhysicsWorld.create 用的是同一个 room
 * });
 *
 * // ② 每个物理步，在 physics.step 之后、world.tick 之前调一次：
 * clock.runSteps(frameDt, (fixedDt) => {
 *   physics.step(fixedDt);
 *   demo.tick();          // ← 顺序：物理先结算，系统再读结果
 *   world.tick(fixedDt);
 * });
 *
 * // ③ 卸载时：
 * demo.dispose();
 * ```
 *
 * ═════════════════════ 顺序为什么是这个（踩过坑）═════════════════════
 *
 * **`physics.step()` 必须在 `demo.tick()` 之前。**
 *
 * `demo.tick()` 内部做三件事：
 *   1. `executor.step()` 产出 `ControlInput`（方向/跑/跳）
 *   2. `controller.update(input)` → `setNextKinematicTranslation()`（**下一步**才生效）
 *   3. `controller.writeTransform()` 把**本步已结算**的位置写回 `world.updateActor()`
 *
 * 第 3 步读的是 `body.translation()`。如果 `demo.tick()` 跑在 `physics.step()`
 * **之前**，读到的就是上一步的位置，于是实体表永远比物理慢一帧。
 * 实测偏差 **0.036668m** —— 正好是 2.2m/s × 1/60 的一帧位移。
 * 这个数字在 `src/agents/e2e-physics.test.ts` 的
 * 「执行器不写 transform」用例里被断言锁死（要求 < 0.001m）。
 *
 * 注意 `main.ts` 现有的顺序就是 `physics.step()` → `world.tick()`，
 * 所以 `demo.tick()` 插在两者之间不需要改动任何现有逻辑。
 *
 * ═════════════════════ 怎么拿 6 个 Agent 的 EntityId ═════════════════════
 *
 * `demo.runtimes` 是 `readonly AgentRuntime[]`，顺序与 `buildDemoAgents(count)`
 * 一致（index 0..count-1）。每项有 `id`（`EntityId`）、`controller`、`queue`、
 * `executor`、`lastInput`。
 *
 * 渲染层建 avatar 应该这样拿（**不要**去猜 id 格式，也不要自己 spawn）：
 *
 * ```ts
 * for (const rt of demo.runtimes) {
 *   const actor = world.getActor(rt.id);   // name / tint / transform 都在这里
 *   const mesh = createAvatar({ id: rt.id, name: actor.name, tint: actor.tint });
 *   // 之后每帧从 world.getActor(rt.id).transform 读位置（已有插值链路）
 * }
 * ```
 *
 * 位置/朝向/动画**只从 `world` 读**，不要从 `rt.controller` 读：
 * 前者已经过 `updateActor` 归一化并带 `actor:update` 事件，后者是物理内部状态。
 */

import type { PhysicsWorld } from '../physics/engine';
import type { Rapier } from '../physics/bake';
import type { Room } from '../core/room';
import type { World } from '../core/world';
import type { EntityId } from '../core/types';
import { CharacterController, DEFAULT_CHARACTER } from '../physics/character';
import { AgentSystem, type AgentRuntime } from '../agents/system';
import { buildDemoAgents, loopIntents, phaseOffsetSeconds, LOOP_PERIOD } from './agents-demo';

/** `startAgentDemo` 需要的依赖。物理实例可选：不传就是"无物理模式"（只跑意图逻辑）。 */
export interface StartAgentDemoOptions {
  world: World;
  /** Rapier 命名空间（`await import('@dimforge/rapier3d-compat')` 的默认导出）。 */
  RAPIER?: Rapier;
  /** 物理世界。不传则不建胶囊控制器（意图会被消费，但角色不会动）。 */
  physics?: PhysicsWorld;
  room: Room;
  /** 参与演示的 Agent 数，默认 6。 */
  count?: number;
  /** 是否在控制台打印失败回报（默认 true）。 */
  logFailures?: boolean;
}

/** 演示句柄。 */
export interface AgentDemoHandle {
  /** 每物理步调一次（在 `physics.step()` 之前）。 */
  tick(): void;
  /** 所有 Agent 的运行时（调试面板/验收脚本用）。 */
  runtimes: readonly AgentRuntime[];
  /**
   * 渲染层建 avatar 用的**扁平清单**（顺序与 `runtimes` 一致）。
   *
   * 存在的理由：render-agent 建 avatar 需要 `id / name / tint / 初始位置`，
   * 但他不该去读 `AgentRuntime` 的内部结构（`queue` / `executor` / `controller`），
   * 也不该自己拼 `EntityId`。这里一次性给全，且都是纯数据。
   */
  avatars: readonly AgentAvatarSpec[];
  /** Agent 系统本体（perceive / submit 用）。 */
  system: AgentSystem;
  /** 当前世界时间相对演示起点的秒数。 */
  elapsed(): number;
  dispose(): void;
}

/** 渲染层建 avatar 需要的全部信息。纯数据，无方法、无物理句柄。 */
export interface AgentAvatarSpec {
  id: EntityId;
  name: string;
  /** 染色变体 key（`tint-0`..`tint-5`），直接喂 `assets/registry` 的变体。 */
  tint: string;
  /** 出生位置（脚底，y=0 平面）。avatar 建好后按这个摆即可。 */
  spawn: readonly [number, number, number];
  /** 演示用的序号 0..count-1（需要按 index 做确定性相位时可读）。 */
  index: number;
}

/**
 * 启动 6 Agent 演示。
 *
 * 相位错开靠**延迟第一次提交**实现：第 i 个 Agent 在世界时间走过
 * `i/6 × LOOP_PERIOD` 之后才提交第一圈意图。用"到点才提交"而不是
 * "提前排队等着"，是因为队列只有 8 格——提前排会占满队列，
 * 后面真正的突发意图就进不来。
 */
export function startAgentDemo(opts: StartAgentDemoOptions): AgentDemoHandle {
  const { world, room, physics } = opts;
  const count = opts.count ?? 6;
  const specs = buildDemoAgents(count);

  const capsuleCenter = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;
  const controllers = new Map<EntityId, CharacterController>();

  const system = new AgentSystem({
    world,
    room,
    ...(physics && opts.RAPIER
      ? {
          createController: (id: EntityId): CharacterController => {
            const c = new CharacterController(
              opts.RAPIER!,
              physics,
              0,
              capsuleCenter + 0.05,
              0,
            );
            controllers.set(id, c);
            return c;
          },
        }
      : {}),
  });

  if (opts.logFailures !== false) {
    system.onFailure((e) => {
      // 失败必须可见（spec §4.2）。生产环境应换成结构化日志，v0.1 打控制台。
      console.warn(`[agent] ${e.id} 意图失败：${e.reason}${e.intent ? ` @${e.intent}` : ''}`);
    });
  }

  const runtimes = specs.map((spec) => {
    const rt = system.join({ name: spec.name, tint: spec.tint, spawnPos: spec.spawn });
    // 控制器的出生点必须与 world 里的位置一致，否则第一帧会瞬移一段
    const c = controllers.get(rt.id);
    if (c) c.teleport(spec.spawn[0], capsuleCenter + 0.05, spec.spawn[2]);
    return rt;
  });

  const avatars: AgentAvatarSpec[] = specs.map((spec, i) => ({
    id: runtimes[i]!.id,
    name: spec.name,
    tint: spec.tint,
    spawn: [spec.spawn[0], spec.spawn[1], spec.spawn[2]] as const,
    index: spec.index,
  }));

  // 相位计时基准：拿到句柄那一刻的世界时间（不是 0，因为物理可能已经跑了几帧）
  const startAt = world.now;
  const started = new Set<number>();
  const laps = new Map<EntityId, number>();

  return {
    runtimes,
    avatars,
    system,
    elapsed(): number {
      return world.now - startAt;
    },
    tick(): void {
      const elapsed = world.now - startAt;
      for (let i = 0; i < runtimes.length; i++) {
        const rt = runtimes[i]!;
        if (!started.has(i)) {
          if (elapsed + 1e-9 < phaseOffsetSeconds(i, runtimes.length, LOOP_PERIOD)) continue;
          started.add(i);
        }
        if (rt.queue.isEmpty && !rt.executor.busy) {
          const lap = laps.get(rt.id) ?? 0;
          const spec = specs[i]!;
          system.submitMany(rt.id, loopIntents(spec, lap));
          laps.set(rt.id, lap + 1);
        }
      }
      system.tick();
    },
    dispose(): void {
      system.dispose();
      controllers.clear();
    },
  };
}
