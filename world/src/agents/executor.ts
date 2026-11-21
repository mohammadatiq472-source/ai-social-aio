/**
 * 意图 → 控制输入（spec §4.2 / §6 M9 第 1、2、3 条）。
 *
 * ═══════════════════ 这个文件唯一不能违反的规则 ═══════════════════
 *
 * **执行器只产出「控制输入」，绝不写 transform。**
 *
 * 一旦执行器直接 `body.setTranslation()` 或 `world.updateActor({transform})`，
 * 物理就被绕过了：角色会穿墙、悬空、穿模，M4 的胶囊控制器（加速度限制、
 * autostep、snapToGround、坡度分支）全部白做，而**症状是"物理有 bug"**——
 * 排查会花掉一整天。所以这里连 `Transform` 都不 import，
 * 只 import 类型（`Intent`），并且 `ControlInput` 里没有任何位置字段。
 *
 * 数据流：
 *   IntentQueue → IntentExecutor.step() → ControlInput → CharacterController.update()
 *                                                          ↓（物理）
 *                                                    World.updateActor()
 *
 * ═══════════════════ 两个设计决定，理由写在这里 ═══════════════════
 *
 * **A. `say` 走「旁路车道」，不占移动的执行槽。**
 *    规格书原文是「say 不阻塞移动（可以边走边说）」。如果 say 和 move 在同一条
 *    FIFO 里排队，`[move, say]` 就变成"走到了再说"——这恰好是规格书否定的行为。
 *    所以每 tick 先 `drainSpeech()`：把队列里**所有** say 按它们彼此的先后顺序
 *    立刻执行掉（写气泡），然后才推进移动意图。结果是：
 *      - `[move, say]` → 第一 tick 就开口，同时继续走 ✔
 *      - `[say, say]` → 两句按顺序写气泡，后一句覆盖前一句（世界就是这么表现的）
 *    代价是 say 不遵守严格的全局 FIFO。这是**刻意的**：说话是叠加在运动之上的
 *    侧信道，不是运动序列里的一步。
 *
 * **B. 撞住就上报 `blocked` 并停止，不做自动绕障/自动跳跃。**
 *    规格书 §6 M9 第 2 条：「v0.1 允许直线，撞住就上报 failed 并停止」。
 *    v0.2 换 A* 时，`blocked` 就是"该重规划了"的信号；现在先把它做**准确**：
 *    判定用「水平距离在 stallSeconds 内没有改善」，而不是「位移为 0」——
 *    沿墙滑动时位移不为 0 但离目标并没有更近，那种情况也该算被挡住。
 *    自动跳跃只保留成外部可调的 `requestJump()`（给人类输入与 M10 跨障用），
 *    默认不在撞墙时触发，避免"意图失败"被自动动作掩盖。
 */

import type { Intent, IntentResult } from '../core/types';
import { FAIL_REASON, fail, isOk, type IntentQueue } from './queue';

// ───────────────────────────── 控制输入 ─────────────────────────────

/**
 * 一帧的控制输入。**没有任何位置字段**——这是本模块的核心约束（见文件头）。
 *
 * 与 `physics/character.ts` 的 `CharacterInput` 结构兼容（`dirX/dirZ/run/jump`），
 * 但这里**不 import 它**：agents 层要保持纯逻辑，能在 node 里裸跑单测，
 * 不因为引一个类型就把 Rapier WASM 拖进测试环境。
 * `src/agents/system.ts` 负责把它喂给控制器（那里已经有物理依赖了）。
 */
export interface ControlInput {
  /** 世界坐标下的水平方向，已归一化；`(0,0)` 表示不动。 */
  dirX: number;
  dirZ: number;
  /** 是否跑（否则走）。 */
  run: boolean;
  /** 本帧请求起跳（边沿位，下一帧自动清零）。 */
  jump: boolean;
  /** 是否请求坐下（M10 消费；M4 控制器不认这个位，只透传）。 */
  sit: boolean;
  /**
   * 目标朝向（绕 Y 的弧度，约定 `yaw = atan2(dx, dz)`，与 character.ts 一致）。
   * `null` 表示"不指定，由物理层按移动方向决定"。
   */
  faceYaw: number | null;
  /** 本帧要播放的表情名（瞬时位）。 */
  emote: string | null;
  /** 请求离场（宿主负责 despawn）。 */
  leave: boolean;
}

/** 全零输入。**每次返回新对象**：调用方会缓存/改它，共享常量是隐患。 */
export function idleInput(): ControlInput {
  return {
    dirX: 0,
    dirZ: 0,
    run: false,
    jump: false,
    sit: false,
    faceYaw: null,
    emote: null,
    leave: false,
  };
}

/** 兼容旧占位导出的名字（`IDLE_INPUT` 曾是一个共享常量，现在是函数）。 */
export const IDLE_INPUT: Readonly<ControlInput> = Object.freeze(idleInput());

// ───────────────────────────── 上下文与钩子 ─────────────────────────────

/** 一个座位（来自 `Room.seats`，但这里只取执行器需要的字段）。 */
export interface SeatRef {
  id: string;
  pos: readonly [number, number, number];
  /** 朝向角（弧度）。 */
  rot: number;
}

/**
 * 每 tick 由宿主（`system.ts`）填的只读上下文。
 *
 * 位置/朝向必须来自**物理算出来的结果**（`CharacterController.snapshot()`），
 * 不是执行器自己积分出来的。执行器永远不知道"我这一步会走到哪"。
 */
export interface ExecutorContext {
  /** 世界时间（秒），来自 `World.now` 或 Clock，**不是 Date.now()**。 */
  now: number;
  /** 固定步长（秒）。 */
  dt: number;
  pos: readonly [number, number, number];
  /** 当前朝向角（弧度）。 */
  yaw: number;
  grounded: boolean;
  /** 房间座位表。空数组表示房间里没有座位。 */
  seats: readonly SeatRef[];
}

/** 副作用出口。执行器自己不碰 World —— 全部经这些钩子，便于单测注入假实现。 */
export interface ExecutorHooks {
  /** 说一句话。`ms` 是显示时长（毫秒）。 */
  say(text: string, ms: number): void;
  /** 播放表情。 */
  emote(name: string): void;
  /** 坐下（`seatId` 为解析后的座位 id）。 */
  sit(seatId: string): void;
  /** 离场。 */
  leave(): void;
  /** 意图失败。**必须**接到 `world.reportIntentFailure()`，不许吞掉。 */
  fail(reason: string, intent?: Intent): void;
}

/** 执行器的可调参数。默认值都有出处，改之前先读注释。 */
export interface ExecutorOptions {
  /** 到达判定半径（米）。默认 0.25：胶囊半径 0.30，贴到 0.25 就已经"到了"。 */
  arriveRadius?: number;
  /**
   * 判定"被挡住"的停滞窗口（秒）。默认 0.5。
   * 太短会被加速度爬升期误判（walk 从 0 到 2.2m/s 要 55ms）；
   * 太长会让 Agent 顶着墙站 1 秒才报错，观感很傻。
   */
  stallSeconds?: number;
  /** 判定"有进展"的最小距离改善（米）。默认 1mm。 */
  progressEps?: number;
  /** 超时系数：允许耗时 = 直线距离/速度 × 该系数 + 兜底秒数。 */
  timeoutFactor?: number;
  /** 超时兜底（秒）。默认 2。 */
  timeoutFloorSeconds?: number;
  /** 坐下时允许的到座距离（米）。默认 0.9（M10 的交互半径是 1.2）。 */
  sitReachRadius?: number;
  /** 发出 sit 位后保持多少秒再算完成（秒）。默认 0.2。 */
  sitSettleSeconds?: number;
  /** emote 的默认时长（毫秒）。默认 1000。 */
  emoteMs?: number;
  /** wait 的默认上限（毫秒）。默认 60000：防止一条 wait 把队列堵死一小时。 */
  maxWaitMs?: number;
}

const DEFAULTS = {
  arriveRadius: 0.25,
  stallSeconds: 0.5,
  progressEps: 0.001,
  timeoutFactor: 3,
  timeoutFloorSeconds: 2,
  sitReachRadius: 0.9,
  sitSettleSeconds: 0.2,
  emoteMs: 1000,
  maxWaitMs: 60000,
} as const;

// ───────────────────────────── 执行中的意图状态 ─────────────────────────────

interface MoveState {
  target: readonly [number, number, number];
  speed: 'walk' | 'run';
  /** 起步时的距离，用于算超时预算。 */
  startDist: number;
  /** 迄今为止离目标最近的距离。 */
  bestDist: number;
  /** 上一次"有进展"的世界时间。 */
  lastProgressAt: number;
  /** 硬截止时间。 */
  deadline: number;
}

interface TimedState {
  /** 还要等多久（秒）。 */
  remaining: number;
}

interface SitState {
  seatId: string;
  seatPos: readonly [number, number, number];
  seatRot: number;
  /** 进入射程后已经等了几秒（发出 sit 位后的结算时间）。 */
  settled: number;
  inRange: boolean;
}

/** 当前正在执行的意图 + 它的私有状态。 */
type Active =
  | { kind: 'move'; intent: Extract<Intent, { t: 'move' }>; st: MoveState }
  | { kind: 'wait'; intent: Extract<Intent, { t: 'wait' }>; st: TimedState }
  | { kind: 'emote'; intent: Extract<Intent, { t: 'emote' }>; st: TimedState }
  | { kind: 'sit'; intent: Extract<Intent, { t: 'sit' }>; st: SitState }
  | { kind: 'look'; intent: Extract<Intent, { t: 'look' }>; st: { done: boolean } }
  | { kind: 'leave'; intent: Extract<Intent, { t: 'leave' }>; st: { done: boolean } };

/** 走/跑速度。必须与 `DEFAULT_CHARACTER` 的 walkSpeed/runSpeed 一致（2.2 / 4.6）。 */
const SPEED = { walk: 2.2, run: 4.6 } as const;

// ───────────────────────────── 执行器 ─────────────────────────────

/**
 * 意图执行器。一个 Agent 一个实例（状态是每 Agent 独立的）。
 *
 * 用法：
 * ```ts
 * const ex = new IntentExecutor();
 * // 每物理步：
 * const input = ex.step(queue, ctx, hooks);
 * controller.update(input, dt);
 * ```
 *
 * 返回的 `input` 是**本 tick 唯一**被允许影响身体的通道。
 */
export class IntentExecutor {
  private readonly opts: Required<ExecutorOptions>;
  private active: Active | null = null;
  private jumpQueued = false;
  /** 统计：完成 / 失败 的条数，验收脚本要贴。 */
  private completedCount = 0;
  private failedCount = 0;
  private spokenCount = 0;

  constructor(opts: ExecutorOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    if (this.opts.arriveRadius <= 0) {
      throw new RangeError('IntentExecutor: arriveRadius 必须 > 0');
    }
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** 正在执行的意图（调试/感知用，只读）。 */
  get current(): Intent | null {
    return this.active ? this.active.intent : null;
  }

  get stats(): { completed: number; failed: number; spoken: number } {
    return {
      completed: this.completedCount,
      failed: this.failedCount,
      spoken: this.spokenCount,
    };
  }

  /** 请求一次起跳（人类输入 / M10 跨障）。不改变当前意图。 */
  requestJump(): void {
    this.jumpQueued = true;
  }

  /** 丢弃当前意图（离场/换房间）。**不上报失败**——这是主动放弃，不是失败。 */
  reset(): void {
    this.active = null;
    this.jumpQueued = false;
  }

  /**
   * 推进一步，返回本 tick 的控制输入。
   *
   * 顺序（有讲究，别调换）：
   * 1. 旁路车道：把队列里的 say 全部执行掉（不占执行槽，见文件头 A）
   * 2. 没有在执行 → 从队列取一条（跳过 say，它们已在第 1 步被消费）
   * 3. 推进当前意图，产出控制输入
   * 4. 收尾：完成的意图出栈，失败的上报
   */
  step(queue: IntentQueue, ctx: ExecutorContext, hooks: ExecutorHooks): ControlInput {
    const out = idleInput();

    // ── 1. 旁路：说话不阻塞移动 ──
    this.drainSpeech(queue, ctx, hooks);

    // ── 2. 取新意图 ──
    if (!this.active) this.pullNext(queue, ctx, hooks, out);
    // 取的时候可能因为队列为空/立即完成而没有 active，这里再判一次
    if (!this.active) {
      // 起跳位仍然要透传（人类按跳时没有意图在跑）
      if (this.jumpQueued) {
        out.jump = true;
        this.jumpQueued = false;
      }
      return out;
    }

    // ── 3. 推进 ──
    const done = this.advance(this.active, ctx, hooks, out);

    // ── 4. 收尾 ──
    if (done) this.finish();

    if (this.jumpQueued) {
      out.jump = true;
      this.jumpQueued = false;
    }
    return out;
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 把队列里所有 say 取出来立刻执行。
   *
   * 为什么要遍历整个队列而不是只看队首：`[move, say]` 是"边走边说"最常见的写法，
   * 只看队首会退化成"走到了再说"（见文件头 A）。
   * `takeMatching` 保持剩余条目（move/wait/...）的原始 FIFO 顺序。
   */
  private drainSpeech(queue: IntentQueue, ctx: ExecutorContext, hooks: ExecutorHooks): void {
    void ctx;
    const taken = queue.takeMatching((i) => i.t === 'say');
    for (const it of taken) {
      const s = it.intent as Extract<Intent, { t: 'say' }>;
      const text = typeof s.text === 'string' ? s.text : '';
      if (text.length === 0) {
        hooks.fail(FAIL_REASON.INVALID_INTENT, s);
        this.failedCount += 1;
        continue;
      }
      // 默认 3000ms：规格书 §6 M9 第 3 条写死「say：设置 bubble 3s」。
      const ms = typeof s.ms === 'number' && Number.isFinite(s.ms) && s.ms > 0 ? s.ms : 3000;
      hooks.say(text, ms);
      this.spokenCount += 1;
      this.completedCount += 1;
    }
  }

  /** 从队列取一条可执行的意图并初始化它的状态。 */
  private pullNext(
    queue: IntentQueue,
    ctx: ExecutorContext,
    hooks: ExecutorHooks,
    out: ControlInput,
  ): void {
    while (!this.active) {
      const head = queue.shift();
      if (!head) return;
      const intent = head.intent;
      // say 应该已经在 drainSpeech 里被消费；这里兜底再处理一次（比如容量为 0 的边界）
      if (intent.t === 'say') {
        const ms = intent.ms && intent.ms > 0 ? intent.ms : 3000;
        hooks.say(intent.text, ms);
        this.spokenCount += 1;
        this.completedCount += 1;
        continue;
      }

      const started = this.begin(intent, ctx, hooks, out);
      if (!started) {
        // begin 已经上报过失败，继续取下一条
        continue;
      }
    }
  }

  /** 初始化一条意图。返回 false 表示立刻失败（已上报）。 */
  private begin(
    intent: Intent,
    ctx: ExecutorContext,
    hooks: ExecutorHooks,
    out: ControlInput,
  ): boolean {
    switch (intent.t) {
      case 'move': {
        const to = intent.to;
        if (!isFiniteVec3(to)) {
          this.reportFail(FAIL_REASON.UNREACHABLE, intent, hooks);
          return false;
        }
        const dx = to[0] - ctx.pos[0];
        const dz = to[2] - ctx.pos[2];
        const dist = Math.hypot(dx, dz);
        const speed = intent.speed === 'run' ? 'run' : 'walk';
        // 已经站在目标点上：立刻完成，别让它再"走 0 米"占一个 tick
        if (dist <= this.opts.arriveRadius) {
          this.completedCount += 1;
          return false;
        }
        const budget =
          (dist / SPEED[speed]) * this.opts.timeoutFactor + this.opts.timeoutFloorSeconds;
        this.active = {
          kind: 'move',
          intent,
          st: {
            target: to,
            speed,
            startDist: dist,
            bestDist: dist,
            lastProgressAt: ctx.now,
            deadline: ctx.now + budget,
          },
        };
        return true;
      }

      case 'look': {
        if (!isFiniteVec3(intent.at)) {
          this.reportFail(FAIL_REASON.UNREACHABLE, intent, hooks);
          return false;
        }
        this.active = { kind: 'look', intent, st: { done: false } };
        return true;
      }

      case 'wait': {
        if (!Number.isFinite(intent.ms) || intent.ms < 0) {
          this.reportFail(FAIL_REASON.INVALID_INTENT, intent, hooks);
          return false;
        }
        const ms = Math.min(intent.ms, this.opts.maxWaitMs);
        this.active = { kind: 'wait', intent, st: { remaining: ms / 1000 } };
        return true;
      }

      case 'emote': {
        if (typeof intent.name !== 'string' || intent.name.length === 0) {
          this.reportFail(FAIL_REASON.INVALID_INTENT, intent, hooks);
          return false;
        }
        this.active = {
          kind: 'emote',
          intent,
          st: { remaining: this.opts.emoteMs / 1000 },
        };
        hooks.emote(intent.name);
        out.emote = intent.name;
        return true;
      }

      case 'sit': {
        if (ctx.seats.length === 0) {
          this.reportFail(FAIL_REASON.NO_SEATS, intent, hooks);
          return false;
        }
        const seat = ctx.seats.find((s) => s.id === intent.seat);
        if (!seat) {
          this.reportFail(FAIL_REASON.NO_SUCH_SEAT, intent, hooks);
          return false;
        }
        this.active = {
          kind: 'sit',
          intent,
          st: {
            seatId: seat.id,
            seatPos: seat.pos,
            seatRot: seat.rot,
            settled: 0,
            inRange: false,
          },
        };
        return true;
      }

      case 'leave': {
        this.active = { kind: 'leave', intent, st: { done: false } };
        return true;
      }

      case 'say': {
        // 正常路径上 say 已经在 drainSpeech 里被旁路执行掉了（见文件头 A）。
        // 走到这里只可能是队列被外部直接 `takeMatching` 干预过；
        // 按"立刻说完"处理，而不是失败——说一句话不需要身体配合。
        const ms = typeof intent.ms === 'number' && intent.ms > 0 ? intent.ms : 3000;
        hooks.say(intent.text, ms);
        this.spokenCount += 1;
        this.completedCount += 1;
        return false;
      }

      default: {
        // 穷尽检查：Intent 加了新变体而这里没跟上时，编译期就会报错。
        // 运行期兜底上报 invalid_intent，绝不静默丢弃（spec §4.2）。
        const never: never = intent;
        this.reportFail(FAIL_REASON.INVALID_INTENT, never as Intent, hooks);
        return false;
      }
    }
  }

  /** 推进当前意图。返回 true 表示这条意图结束了（完成或失败）。 */
  private advance(
    a: Active,
    ctx: ExecutorContext,
    hooks: ExecutorHooks,
    out: ControlInput,
  ): boolean {
    switch (a.kind) {
      case 'move': {
        const st = a.st;
        const dx = st.target[0] - ctx.pos[0];
        const dz = st.target[2] - ctx.pos[2];
        const dist = Math.hypot(dx, dz);

        if (dist <= this.opts.arriveRadius) {
          this.completedCount += 1;
          return true;
        }

        // 有进展就刷新停滞计时
        if (dist < st.bestDist - this.opts.progressEps) {
          st.bestDist = dist;
          st.lastProgressAt = ctx.now;
        }

        // 停滞 → 被挡住（沿墙滑但离目标没更近，也算挡住）
        if (ctx.now - st.lastProgressAt >= this.opts.stallSeconds) {
          this.reportFail(FAIL_REASON.BLOCKED, a.intent, hooks);
          return true;
        }

        if (ctx.now >= st.deadline) {
          this.reportFail(FAIL_REASON.TIMEOUT, a.intent, hooks);
          return true;
        }

        const inv = dist > 1e-9 ? 1 / dist : 0;
        out.dirX = dx * inv;
        out.dirZ = dz * inv;
        out.run = st.speed === 'run';
        out.faceYaw = Math.atan2(dx, dz);
        return false;
      }

      case 'wait': {
        a.st.remaining -= ctx.dt;
        if (a.st.remaining <= 0) {
          this.completedCount += 1;
          return true;
        }
        return false;
      }

      case 'emote': {
        a.st.remaining -= ctx.dt;
        // 表情期间允许继续播（每 tick 都发，宿主按需处理），但不移动
        out.emote = a.intent.name;
        if (a.st.remaining <= 0) {
          this.completedCount += 1;
          return true;
        }
        return false;
      }

      case 'sit': {
        const st = a.st;
        if (st.inRange) {
          // 已经到座位边：持续发 sit 位，等结算窗口过去就算完成
          out.sit = true;
          out.faceYaw = st.seatRot;
          st.settled += ctx.dt;
          if (st.settled >= this.opts.sitSettleSeconds) {
            this.completedCount += 1;
            return true;
          }
          return false;
        }

        const dx = st.seatPos[0] - ctx.pos[0];
        const dz = st.seatPos[2] - ctx.pos[2];
        const dist = Math.hypot(dx, dz);
        if (dist <= this.opts.sitReachRadius) {
          st.inRange = true;
          hooks.sit(st.seatId);
          out.sit = true;
          out.faceYaw = st.seatRot;
          return false;
        }
        const inv = dist > 1e-9 ? 1 / dist : 0;
        out.dirX = dx * inv;
        out.dirZ = dz * inv;
        out.faceYaw = Math.atan2(dx, dz);
        return false;
      }

      case 'look': {
        if (a.st.done) {
          this.completedCount += 1;
          return true;
        }
        const dx = a.intent.at[0] - ctx.pos[0];
        const dz = a.intent.at[2] - ctx.pos[2];
        if (Math.hypot(dx, dz) < 1e-6) {
          // 目标就是脚下：没有可用的水平朝向，按"已完成"处理而不是失败
          this.completedCount += 1;
          return true;
        }
        out.faceYaw = Math.atan2(dx, dz);
        a.st.done = true;
        return false;
      }

      case 'leave': {
        out.leave = true;
        hooks.leave();
        this.completedCount += 1;
        return true;
      }
    }
  }

  private finish(): void {
    this.active = null;
  }

  /** 上报失败：既走钩子（→ world.reportIntentFailure），也本地计数。 */
  private reportFail(reason: string, intent: Intent, hooks: ExecutorHooks): void {
    this.failedCount += 1;
    hooks.fail(reason, intent);
  }
}

// ───────────────────────────── 纯函数工具 ─────────────────────────────

function isFiniteVec3(v: readonly number[] | undefined): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  );
}

/**
 * 控制输入 → 角色控制器的输入（结构兼容 `physics/character.ts#CharacterInput`）。
 *
 * 为什么不在 `src/agents/` 里 import `CharacterInput` 类型：那会把物理层的
 * 类型依赖带进纯逻辑模块。这个函数返回一个**结构上**匹配的字面量，
 * `system.ts` 里有一行 `satisfies` 断言把它钉住（改坏会编译失败）。
 */
export function toLocomotionInput(ci: ControlInput): {
  dirX: number;
  dirZ: number;
  run: boolean;
  jump: boolean;
  faceX?: number;
  faceZ?: number;
} {
  const base = {
    dirX: ci.dirX,
    dirZ: ci.dirZ,
    run: ci.run,
    jump: ci.jump,
  };
  if (ci.faceYaw === null) return base;
  // 与 character.ts 的 updateFacing 约定一致：yaw = atan2(faceX, faceZ)
  return { ...base, faceX: Math.sin(ci.faceYaw), faceZ: Math.cos(ci.faceYaw) };
}

/** 把 `IntentResult` 打平成一行日志文本（失败回报的样例输出用它）。 */
export function describeResult(r: IntentResult): string {
  if (isOk(r)) return 'ok';
  return `failed(${r.reason}${r.intent ? ` @${r.intent}` : ''})`;
}

/** 重新导出：让 `fail()` 在 executor 之外的调用方（system/HTTP）也用同一个构造器。 */
export { fail };
