/**
 * 只读感知（spec §6 M9 第 4 条）。
 *
 * 规格书的形状：`{ self:{p,r,anim}, nearby:[{id,name,p,dist}], bubbles:[...] }`。
 *
 * ═══════════════════ 无副作用是硬要求，不是良好愿望 ═══════════════════
 *
 * 这个模块给**外部 Agent** 读世界。它被 HTTP 每 100ms 打一次（v0.2），
 * 如果它顺手做了"清理过期气泡"或"刷新缓存"这类看起来无害的事，就会有两个后果：
 *
 * 1. **读频率改变世界状态**。Agent 读得越勤，气泡消失得越快；两个 Agent 同时读，
 *    清理被做两遍。这类 bug 只在"多 Agent + 高频读"下显形，本地单测很难撞上。
 * 2. **快照不可复现**。回放/对比时，同一 tick 读两次得到不同结果，
 *    于是"Agent 为什么做了这个决策"永远查不清。
 *
 * 所以这里的纪律是：
 * - 只调 `World` 的**读**方法（`getActor` / `listActors` / `now` / `tickCount`）。
 * - **绝不**调 `expireBubbles()`（它会写）、`say()`、`updateActor()`、`spawn()`。
 * - 返回的对象是**深拷贝**：调用方改它不会污染世界（`ActorState.transform` 是数组，
 *   浅拷贝会把同一个数组引用递出去）。
 * - 不做任何缓存/记忆化。缓存本身就是状态。
 *
 * 无副作用由 `perceive.test.ts` 里一条"世界指纹前后完全一致"的用例锁住：
 * 实体表 / 每个 transform / 每个 bubble / 事件计数 / tick / now 全部比对。
 */

import type { ActorState, AnimName, EntityId } from '../core/types';
import { distance } from '../core/types';

// ───────────────────────────── 对外形状 ─────────────────────────────

/** 自己。字段名按规格书用短名 `p` / `r` / `anim`。 */
export interface PerceivedSelf {
  id: EntityId;
  name: string;
  /** 位置 [x,y,z]。 */
  p: [number, number, number];
  /** 朝向四元数 [x,y,z,w]。 */
  r: [number, number, number, number];
  /** 当前动画名。 */
  anim: AnimName;
  /** 动画相位 0..1。 */
  animPhase: number;
  /** 朝向角（绕 Y，弧度）。四元数难读，Agent 做决策时用这个更方便。 */
  yaw: number;
}

/** 附近的一个实体。 */
export interface PerceivedNearby {
  id: EntityId;
  name: string;
  /** 位置 [x,y,z]。 */
  p: [number, number, number];
  /** 与自己的直线距离（米，三维）。 */
  dist: number;
  /** 水平距离（米，忽略 y）。判断"能不能走过去"要看这个。 */
  distXZ: number;
  kind: ActorState['kind'];
  anim: AnimName;
  /** 相对自己的方位角（弧度，绕 Y）。0 = 正 +z 方向，与 `yaw` 同一套约定。 */
  bearing: number;
  tint?: string;
}

/** 一条气泡。 */
export interface PerceivedBubble {
  id: EntityId;
  name: string;
  text: string;
  /** 世界时间（秒）——气泡到期时刻。 */
  until: number;
  /** 还剩多少秒（已过期的气泡不会出现在结果里，所以恒 > 0）。 */
  remaining: number;
}

/** 完整感知快照。 */
export interface Perception {
  self: PerceivedSelf;
  /** 附近实体，按 `dist` 升序。 */
  nearby: PerceivedNearby[];
  /** 当前所有**未过期**的气泡，按 `until` 升序（先消失的在前）。 */
  bubbles: PerceivedBubble[];
  /** 读这一帧时的世界时间（秒）。 */
  worldTime: number;
  /** 世界 tick 计数。 */
  tick: number;
}

/** 感知选项。 */
export interface PerceiveOptions {
  /**
   * 只返回这个水平距离内的实体（米）。默认 `Infinity`（全部）。
   * v0.1 房间很小，全返回更省心；给 v0.2 的"视距"留口子。
   */
  radiusXZ?: number;
  /** 最多返回多少个附近实体（按距离取最近的）。默认 32。 */
  limit?: number;
}

const DEFAULT_LIMIT = 32;

// ───────────────────────────── 只读数据源 ─────────────────────────────

/**
 * 感知只需要世界层的这几个读操作。
 *
 * 用接口而不是直接吃 `World` 实例，有两个好处：
 * 1. 单测可以传一个**不可写**的假实现，从类型上就没法调 `say()`/`updateActor()`。
 * 2. v0.2 的房间服务可以把同一个感知函数接到它的只读视图上，不用改这里。
 *
 * `World` 天然满足这个接口（结构类型），调用方直接传 `world` 即可。
 */
export interface PerceptionSource {
  getActor(id: EntityId): Readonly<ActorState> | undefined;
  listActors(): ActorState[];
  readonly now: number;
  readonly tickCount: number;
}

// ───────────────────────────── 实现 ─────────────────────────────

/**
 * 读一个 Agent 的感知。
 *
 * 返回 `null` 表示**这个 id 不在世界里**（已离场）。调用方据此返回 404，
 * 而不是伪造一个空快照——空快照会让 Agent 以为"我在一个没人的房间里"。
 *
 * 纯函数：同样的世界状态 + 同样的参数 → 逐字段相同的结果。
 */
export function perceive(
  source: PerceptionSource,
  selfId: EntityId,
  opts: PerceiveOptions = {},
): Perception | null {
  const self = source.getActor(selfId);
  if (!self) return null;

  const radiusXZ = opts.radiusXZ ?? Number.POSITIVE_INFINITY;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // 非法半径（NaN / ≤0）不抛：感知是外部每 100ms 打一次的读接口，
  // 抛错会让调用方以为"这个 Agent 没了"。降级成"只有自己"更诚实。
  if (!(radiusXZ > 0)) return emptyPerception(source, self);

  const all = source.listActors();
  const now = source.now;

  // ── nearby ──
  const nearby: PerceivedNearby[] = [];
  for (const a of all) {
    if (a.id === self.id) continue;
    const dx = a.transform.p[0] - self.transform.p[0];
    const dz = a.transform.p[2] - self.transform.p[2];
    const distXZ = Math.hypot(dx, dz);
    if (distXZ > radiusXZ) continue;
    const item: PerceivedNearby = {
      id: a.id,
      name: a.name,
      p: [a.transform.p[0], a.transform.p[1], a.transform.p[2]],
      dist: distance(self.transform.p, a.transform.p),
      distXZ,
      kind: a.kind,
      anim: a.anim,
      bearing: distXZ > 1e-9 ? Math.atan2(dx, dz) : 0,
    };
    if (a.tint !== undefined) item.tint = a.tint;
    nearby.push(item);
  }
  // 稳定排序：距离相同按 id 字典序，保证同一状态下两次读取顺序一致
  nearby.sort((x, y) => (x.dist !== y.dist ? x.dist - y.dist : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (nearby.length > limit) nearby.length = limit;

  // ── bubbles：只读过滤，**不清理**（清理是 world.tick 的职责） ──
  const bubbles: PerceivedBubble[] = [];
  for (const a of all) {
    const b = a.bubble;
    if (!b) continue;
    // 已过期的气泡"逻辑上已经没了"，但不在这里删——那属于写操作。
    // 这里只是不返回它，与 world.tick 里 expireBubbles 的结果一致。
    const remaining = b.until - now;
    if (!(remaining > 0)) continue;
    bubbles.push({ id: a.id, name: a.name, text: b.text, until: b.until, remaining });
  }
  bubbles.sort((x, y) => (x.until !== y.until ? x.until - y.until : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  return {
    self: {
      id: self.id,
      name: self.name,
      p: [self.transform.p[0], self.transform.p[1], self.transform.p[2]],
      r: [self.transform.r[0], self.transform.r[1], self.transform.r[2], self.transform.r[3]],
      anim: self.anim,
      animPhase: self.animPhase,
      yaw: quatToYaw(self.transform.r),
    },
    nearby,
    bubbles,
    worldTime: now,
    tick: source.tickCount,
  };
}

/** 半径非法时的降级：返回只有自己的空感知（而不是抛——感知不该让调用方崩）。 */
function emptyPerception(source: PerceptionSource, self: Readonly<ActorState>): Perception {
  return {
    self: {
      id: self.id,
      name: self.name,
      p: [self.transform.p[0], self.transform.p[1], self.transform.p[2]],
      r: [self.transform.r[0], self.transform.r[1], self.transform.r[2], self.transform.r[3]],
      anim: self.anim,
      animPhase: self.animPhase,
      yaw: quatToYaw(self.transform.r),
    },
    nearby: [],
    bubbles: [],
    worldTime: source.now,
    tick: source.tickCount,
  };
}

// ───────────────────────────── 数学 ─────────────────────────────

/**
 * 四元数 → 绕 Y 的朝向角。
 *
 * 约定与 `physics/character.ts#updateFacing` 一致：目标四元数是
 * `[0, sin(yaw/2), 0, cos(yaw/2)]`，所以反解是 `yaw = 2·atan2(y, w)`。
 * 用 `2*atan2` 而不是 `asin` 之类，是因为它在 w<0（转过 180° 之后）也连续。
 */
export function quatToYaw(q: readonly [number, number, number, number]): number {
  const y = q[1];
  const w = q[3];
  if (!Number.isFinite(y) || !Number.isFinite(w)) return 0;
  if (Math.abs(y) < 1e-12 && Math.abs(w) < 1e-12) return 0;
  return 2 * Math.atan2(y, w);
}

/** 把弧度归一到 (-π, π]。感知结果里给外部 Agent 看的角度都该是这个范围。 */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const twoPi = Math.PI * 2;
  let x = a % twoPi;
  if (x <= -Math.PI) x += twoPi;
  else if (x > Math.PI) x -= twoPi;
  return x;
}
