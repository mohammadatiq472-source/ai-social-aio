/**
 * Agent 系统接线（spec §6 M9 落地）。
 *
 * 这个文件是 `queue / executor / perceive` 与 `World / CharacterController` 之间
 * 唯一被允许的桥。三个模块本身都不碰物理，物理也不知道 Agent 的存在——
 * 全部耦合集中在这里，改接口时只需要改一个文件。
 *
 * ═══════════════ 一个 tick 里的顺序（不要调换） ═══════════════
 *
 *   1. executor.step()     意图 → ControlInput（纯逻辑，不写世界）
 *   2. controller.update() ControlInput → 物理位移（Rapier 算碰撞）
 *   3. world.updateActor() 物理结果 → 实体表（**物理层唯一出口**）
 *
 * 第 3 步的位置/朝向**只能来自 `controller.snapshot()`**。执行器没有能力
 * 提供位置，它只提供方向——这是 spec §4.2 的硬要求，也是"物理不被绕过"的
 * 具体含义。任何人在这个文件里写 `updateActor({transform: {p: 意图目标}})` 都是 bug。
 *
 * ═══════════════ 系统注册顺序 ═══════════════
 *
 * World 的 systems 按 `order` 升序跑，而物理步进（`physics.step()`）在
 * `main.ts` 里由 Clock 驱动、**不在** World 的 systems 里。所以 Agent 系统的
 * 位置必须和物理步进对齐：
 *
 *   物理步进（Clock）→ world.tick() 内部按 order 跑 systems
 *
 * 这意味着 Agent 的 `controller.update()` 在物理 `step()` **之后**执行，
 * 位移会在下一 tick 的 `step()` 里才被 Rapier 结算。这是**正确**的：
 * Rapier 的 kinematic 刚体本来就是 `setNextKinematicTranslation` 下一帧生效。
 * 所以一个 tick 的观感延迟是物理固有的，不是这里引入的。
 */

import type { EntityId, Intent, IntentResult } from '../core/types';
import type { World } from '../core/world';
import type { CharacterController } from '../physics/character';
import type { Room } from '../core/room';
import { FAIL_REASON, IntentQueue, fail, isOk, type IntentQueueStats } from './queue';
import {
  IntentExecutor,
  toLocomotionInput,
  type ControlInput,
  type ExecutorOptions,
  type SeatRef,
} from './executor';
import { perceive, type Perception, type PerceiveOptions, type PerceptionSource } from './perceive';

/** 一个 Agent 的运行时（队列 + 执行器 + 物理控制器）。 */
export interface AgentRuntime {
  readonly id: EntityId;
  readonly queue: IntentQueue;
  readonly executor: IntentExecutor;
  /** 物理控制器。`null` 表示这个 Agent 是"无物理模式"（单测/降级）。 */
  readonly controller: CharacterController | null;
  /** 累计物理步数（本 Agent）。 */
  steps: number;
  /** 上一帧的控制输入（调试面板要看"它到底在按什么"）。 */
  lastInput: ControlInput;
}

/** 宿主提供的能力。物理相关的东西全部从这里注入，`AgentSystem` 不 import Rapier。 */
export interface AgentSystemDeps {
  world: World;
  /** 房间（座位表来自这里）。 */
  room: Room;
  /**
   * 为某个 Agent 建物理控制器。返回 `null` 表示这个世界没有物理
   * （纯逻辑单测，或物理初始化失败后的降级模式）。
   */
  createController?(id: EntityId, spawnIndex: number): CharacterController | null;
  /** 物理步进器。Agent 系统自己**不**步进物理（那是 Clock 的职责）。 */
  executorOptions?: ExecutorOptions;
  /** 感知默认选项。 */
  perceiveOptions?: PerceiveOptions;
}

/** 事件：一次意图失败。宿主可以把它转成日志/HTTP 响应。 */
export interface AgentFailureEvent {
  id: EntityId;
  reason: string;
  intent?: Intent['t'];
}

/**
 * Agent 系统。一个房间一个实例，内部持有 `id → AgentRuntime` 表。
 *
 * 对外 API 就是 M9 要暴露的三件事：`join` / `submit` / `perceive`。
 * v0.2 的 HTTP 层（`POST /agent/join`、`POST /agent/:id/intent`、
 * `GET /agent/:id/perceive`）只需要这三个方法，不许绕过它们去碰 queue。
 */
export class AgentSystem {
  readonly world: World;
  readonly room: Room;

  private readonly agents = new Map<EntityId, AgentRuntime>();
  private readonly deps: AgentSystemDeps;
  private readonly seats: readonly SeatRef[];
  private readonly perceiveOpts: PerceiveOptions;
  /** 失败回调（宿主接 world.reportIntentFailure 或自己的日志）。 */
  private readonly failureListeners = new Set<(e: AgentFailureEvent) => void>();
  private spawnCounter = 0;

  constructor(deps: AgentSystemDeps) {
    this.world = deps.world;
    this.room = deps.room;
    this.deps = deps;
    this.seats = deps.room.seats.map((s) => ({ id: s.id, pos: s.pos, rot: s.rot }));
    this.perceiveOpts = deps.perceiveOptions ?? {};
  }

  get agentCount(): number {
    return this.agents.size;
  }

  listAgentIds(): EntityId[] {
    return [...this.agents.keys()];
  }

  get(id: EntityId): AgentRuntime | undefined {
    return this.agents.get(id);
  }

  /**
   * 一个 Agent 进场。
   *
   * 规格书 §6 M9 的 HTTP 形状是 `POST /agent/join {id,name,tint}`；
   * 这里保留同样的语义但把 `id` 改成可选——不传就由 `world.nextId('a')` 分配，
   * 因为"调用方指定 id"在 v0.1 的本地 demo 里没有收益，反而容易撞 id。
   *
   * 返回的 `AgentRuntime` 里 `controller` 可能是 `null`（无物理模式）。
   */
  join(opts: {
    id?: EntityId;
    name: string;
    tint?: string;
    /** 出生点下标；不传则按进场顺序分配（环绕复用，见 room.spawnPoint）。 */
    spawnIndex?: number;
    /** 显式出生位置（优先于 spawnIndex）。 */
    spawnPos?: readonly [number, number, number];
  }): AgentRuntime {
    const id = opts.id ?? this.world.nextId('a');
    if (this.agents.has(id)) {
      throw new Error(`AgentSystem.join: Agent ${id} 已在场（id 不许复用）`);
    }
    if (this.world.has(id)) {
      throw new Error(`AgentSystem.join: 实体 ${id} 已被占用`);
    }

    const spawnIndex = opts.spawnIndex ?? this.spawnCounter;
    this.spawnCounter += 1;
    const p = opts.spawnPos ?? spawnPointOf(this.room, spawnIndex);
    // y 抬高一点：胶囊中心在地面之上，落地由物理负责（不写死"贴地"，
    // 否则斜坡/台阶上出生会半埋进几何体）。
    const spawnY = p[1] + CAPSULE_CENTER_HEIGHT + 0.05;

    this.world.spawn({
      id,
      kind: 'agent',
      name: opts.name,
      transform: { p: [p[0], spawnY, p[2]], r: [0, 0, 0, 1] },
      anim: 'idle',
      animPhase: 0,
      ...(opts.tint === undefined ? {} : { tint: opts.tint }),
    });

    const controller = this.deps.createController?.(id, spawnIndex) ?? null;

    const runtime: AgentRuntime = {
      id,
      queue: new IntentQueue(),
      executor: new IntentExecutor(this.deps.executorOptions ?? {}),
      controller,
      steps: 0,
      lastInput: {
        dirX: 0,
        dirZ: 0,
        run: false,
        jump: false,
        sit: false,
        faceYaw: null,
        emote: null,
        leave: false,
      },
    };
    this.agents.set(id, runtime);
    return runtime;
  }

  /** 一个 Agent 离场（despawn + 释放控制器）。 */
  leave(id: EntityId): boolean {
    const rt = this.agents.get(id);
    if (!rt) return false;
    rt.queue.close();
    rt.executor.reset();
    rt.controller?.dispose();
    this.agents.delete(id);
    this.world.despawn(id);
    return true;
  }

  /**
   * 提交一条意图。
   *
   * 返回 `IntentResult`：**队列满会返回 `{t:'failed',reason:'queue_full'}`**，
   * 不是静默丢弃（spec §4.2 最后一条）。同时也会经失败回调广播一次，
   * 因为 HTTP 层可能不读返回值（比如 fire-and-forget 的脚本）。
   */
  submit(id: EntityId, intent: Intent): IntentResult {
    const rt = this.agents.get(id);
    if (!rt) {
      const r = fail(FAIL_REASON.NO_SUCH_AGENT, intent);
      this.emitFailure({ id, reason: r.reason, ...(r.intent ? { intent: r.intent } : {}) });
      return r;
    }
    const result = rt.queue.push(intent, this.world.now);
    if (!isOk(result)) {
      this.emitFailure({
        id,
        reason: result.reason,
        ...(result.intent ? { intent: result.intent } : {}),
      });
    }
    return result;
  }

  /** 批量提交：返回每条的结果，顺序与输入一致（demo 用）。 */
  submitMany(id: EntityId, intents: readonly Intent[]): IntentResult[] {
    return intents.map((i) => this.submit(id, i));
  }

  /** 只读感知。**不产生任何副作用**（见 perceive.ts 文件头）。 */
  perceive(id: EntityId, opts?: PerceiveOptions): Perception | null {
    const source: PerceptionSource = this.world;
    return perceive(source, id, opts ?? this.perceiveOpts);
  }

  /** 订阅失败事件。返回退订函数。 */
  onFailure(fn: (e: AgentFailureEvent) => void): () => void {
    this.failureListeners.add(fn);
    return () => this.failureListeners.delete(fn);
  }

  /** 队列统计（验收脚本贴数字用）。 */
  queueStats(id: EntityId): IntentQueueStats | null {
    return this.agents.get(id)?.queue.stats() ?? null;
  }

  /**
   * 每 tick 跑一次：把每个 Agent 的意图翻译成控制输入，喂给物理控制器，
   * 再把物理算出来的位置写回 World。
   *
   * 由宿主注册成 World system（`world.addSystem('agents', ...)`）。
   * 不在这里步进物理——物理由 Clock 驱动，两件事混在一起会让
   * "单帧最多追 3 步"的纪律失效。
   */
  tick(): void {
    for (const rt of this.agents.values()) {
      const actor = this.world.getActor(rt.id);
      if (!actor) continue; // 已被外部 despawn

      const snap = rt.controller?.snapshot();
      const ctx = {
        now: this.world.now,
        dt: PHYSICS_STEP,
        pos: snap ? snap.pos : (actor.transform.p as [number, number, number]),
        yaw: snap ? quatToYawOf(snap.rot) : quatToYawOf(actor.transform.r),
        grounded: snap ? snap.grounded : true,
        seats: this.seats,
      };

      const input = rt.executor.step(rt.queue, ctx, {
        say: (text, ms) => this.world.say(rt.id, text, ms),
        emote: () => {
          /* M5 的化身动画会消费这个；v0.1 只把它透传到 ControlInput */
        },
        sit: () => {
          /* M10 的座位吸附会消费；M9 只负责走到位并发出 sit 位 */
        },
        leave: () => {
          // 离场延到 tick 末尾做：这里正在遍历 map，边遍历边删会漏掉后面的 Agent
          this.pendingLeave.add(rt.id);
        },
        fail: (reason, intent) => {
          this.emitFailure({ id: rt.id, reason, ...(intent ? { intent: intent.t } : {}) });
        },
      });

      rt.lastInput = input;
      rt.steps += 1;

      // ── 物理：控制输入 → 位移 ──
      if (rt.controller) {
        rt.controller.update(toLocomotionInput(input), PHYSICS_STEP);
        // ── 物理结果 → 实体表（唯一出口） ──
        rt.controller.writeTransform((t, anim) => {
          this.world.updateActor(rt.id, { transform: t, anim, animPhase: 0 });
        });
      }
    }

    // 离场与进场的延迟处理：不能在遍历中改 map
    if (this.pendingLeave.size > 0) {
      const ids = [...this.pendingLeave];
      this.pendingLeave.clear();
      for (const id of ids) this.leave(id);
    }
  }

  private readonly pendingLeave = new Set<EntityId>();

  private emitFailure(e: AgentFailureEvent): void {
    // 统一出口：world 的事件总线（渲染层/调试面板订阅）+ 本地订阅者
    this.world.reportIntentFailure(e.id, e.reason);
    for (const fn of this.failureListeners) fn(e);
  }

  /** 清空所有 Agent（换房间）。 */
  dispose(): void {
    for (const id of [...this.agents.keys()]) this.leave(id);
    this.failureListeners.clear();
  }
}

// ───────────────────────────── 内部常量与工具 ─────────────────────────────

/** 物理步长。与 core/types.ts 的 PHYSICS_DT 同值，但这里不从 physics 层 import（保持零物理依赖）。 */
const PHYSICS_STEP = 1 / 60;

/** 胶囊中心离脚底的高度 = halfHeight + radius = 0.55 + 0.30。 */
const CAPSULE_CENTER_HEIGHT = 0.85;

/** 出生点。与 `core/room.ts#spawnPoint` 同语义，这里内联一份避免 agents→room 的循环依赖。 */
function spawnPointOf(room: Room, index: number): readonly [number, number, number] {
  if (room.spawn.length === 0) return [0, 0, 0];
  const base = room.spawn[index % room.spawn.length]!;
  const lap = Math.floor(index / room.spawn.length);
  if (lap === 0) return base;
  return [base[0] + lap * 0.6, base[1], base[2]];
}

/** 四元数 → yaw。与 perceive.ts 的 quatToYaw 同一公式，内联避免多一次函数跳。 */
function quatToYawOf(q: readonly [number, number, number, number]): number {
  const y = q[1];
  const w = q[3];
  if (!Number.isFinite(y) || !Number.isFinite(w)) return 0;
  return 2 * Math.atan2(y, w);
}

export { FAIL_REASON };
