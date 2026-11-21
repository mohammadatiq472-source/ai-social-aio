/**
 * 最小交互（spec §6 M10）。
 *
 * 三件事：**坐下 / 推动 / 看向**。这个文件只做"判定与状态"，不碰渲染也不碰物理——
 * 物理推动已经是 M3/M4 的能力（`setApplyImpulsesToDynamicBodies(true)`），
 * 这里不写脚本推箱子，只负责"玩家按了 E，该不该进 sit"。
 *
 * ═══════════════ 三个设计决定 ═══════════════
 *
 * **1. 坐下是"状态 + 吸附"，不是"瞬移"。**
 *    进入 sit 后角色位置由座位决定（`seat.pos` + 座位朝向），期间禁用移动输入。
 *    但吸附发生在**物理步里**（`controller.teleport()`），不是直接写 transform——
 *    直接写 transform 会让角色嵌进椅子/地面（椅子碰撞体是静态的）。
 *
 * **2. 推箱不写脚本。**
 *    spec 原文「靠物理，不要写脚本；给箱子 mass 10，角色 applyImpulsesToDynamicBodies」。
 *    M4 的 `CharacterController` 已经 `cc.setApplyImpulsesToDynamicBodies(true)`，
 *    所以这里**什么都不用做**。这个文件只提供 `canPush()` 判定给 HUD 提示用，
 *    以及一个"别在这里写推力"的注释。
 *
 * **3. 看向是"相机意图"，不是"角色朝向"。**
 *    点角色切焦点 → 相机在 1s 内缓动过去。角色本身不转（除非它在走）。
 *    把两者混起来会让"看向某人"变成"某人被我的角色盯着"，观感很怪。
 */

import type { EntityId } from '../core/types';
import type { RoomSeat } from '../core/room';

// ───────────────────────────── 参数 ─────────────────────────────

/** 坐下的最大交互距离（米）。spec §6 M10：距离 < 1.2m 按 E。 */
export const SIT_REACH = 1.2;

/** 起身后的位置：座位前方多远（米）。太近会立刻又触发坐下。 */
export const STAND_OFFSET = 0.55;

/** 相机焦点切换的缓动时长（秒）。spec §6 M10：1s 缓动。 */
export const FOCUS_EASE_SECONDS = 1;

/** 推箱判定：角色前方多远内算"够得着"（米）。 */
export const PUSH_REACH = 0.85;

// ───────────────────────────── 座位 ─────────────────────────────

/** 交互状态。 */
export type InteractMode = 'free' | 'sitting';

export interface InteractState {
  mode: InteractMode;
  /** 正在坐的座位 id（mode==='sitting' 时有效）。 */
  seatId: string | null;
  /** 相机焦点目标（null = 跟随自己）。 */
  focusId: EntityId | null;
  /** 焦点缓动的进度 0..1（1 = 已到位）。 */
  focusT: number;
}

export function initialInteractState(): InteractState {
  return { mode: 'free', seatId: null, focusId: null, focusT: 0 };
}

/** 座位判定结果。 */
export interface SeatCandidate {
  seat: RoomSeat;
  /** 水平距离（米）。 */
  dist: number;
}

/**
 * 找**最近的、够得着的**座位。
 *
 * 只比水平距离：椅子高度差（比如吧台凳）不该影响"能不能坐下"，
 * 而且角色胶囊中心在 y≈0.85，跟座位 pos 的 y（通常 0）本来就不同。
 */
export function nearestSeat(
  seats: readonly RoomSeat[],
  pos: readonly [number, number, number],
  reach = SIT_REACH,
): SeatCandidate | null {
  let best: SeatCandidate | null = null;
  for (const seat of seats) {
    const d = Math.hypot(seat.pos[0] - pos[0], seat.pos[2] - pos[2]);
    if (d > reach) continue;
    if (!best || d < best.dist) best = { seat, dist: d };
  }
  return best;
}

/**
 * 按 E 的结果。`toggle` 是"同一个键既坐下又起身"的语义（spec §6 M10 第 1 条）。
 */
export type SitToggle =
  | { action: 'sit'; seat: RoomSeat }
  | { action: 'stand'; from: string }
  | { action: 'none'; reason: 'no_seat_in_reach' };

/**
 * 处理一次 E 键。
 *
 * - 坐着 → 起身（永远允许，哪怕座位被移走了）
 * - 站着 → 找最近座位；够得着就坐，够不着就 `none`（由 HUD 提示"附近没有座位"）
 */
export function toggleSit(
  state: InteractState,
  seats: readonly RoomSeat[],
  pos: readonly [number, number, number],
  reach = SIT_REACH,
): SitToggle {
  if (state.mode === 'sitting' && state.seatId !== null) {
    return { action: 'stand', from: state.seatId };
  }
  const found = nearestSeat(seats, pos, reach);
  if (!found) return { action: 'none', reason: 'no_seat_in_reach' };
  return { action: 'sit', seat: found.seat };
}

/**
 * 坐姿的吸附目标：座位位置 + 座位朝向。
 *
 * 返回的 `p` 是**角色胶囊中心**该在的位置（座位 y + 胶囊中心高），
 * 不是脚底位置。写错会让角色半埋进椅子。
 */
export function sitPose(
  seat: RoomSeat,
  capsuleCenterHeight: number,
): { p: [number, number, number]; yaw: number } {
  return {
    p: [seat.pos[0], seat.pos[1] + capsuleCenterHeight, seat.pos[2]],
    yaw: seat.rot,
  };
}

/** 起身位置：座位前方 `STAND_OFFSET` 米（沿座位朝向）。 */
export function standPose(
  seat: RoomSeat,
  capsuleCenterHeight: number,
  offset = STAND_OFFSET,
): { p: [number, number, number]; yaw: number } {
  // 座位朝向 rot 的"前方"与 yaw=atan2(fx,fz) 约定一致：(sin, cos)
  const fx = Math.sin(seat.rot);
  const fz = Math.cos(seat.rot);
  return {
    p: [seat.pos[0] + fx * offset, seat.pos[1] + capsuleCenterHeight, seat.pos[2] + fz * offset],
    yaw: seat.rot,
  };
}

/**
 * 坐着时是否允许移动。
 *
 * spec §6 M10 第 1 条：「期间禁用移动输入」。
 * 返回 false 时调用方应把 `ControlInput` 的方向位清零（但**保留** say/emote，
 * 坐着也能说话，这不违反规格书）。
 */
export function movementAllowed(state: InteractState): boolean {
  return state.mode === 'free';
}

// ───────────────────────────── 推动 ─────────────────────────────

/**
 * 推箱判定（**只用于 HUD 提示**，不产生推力）。
 *
 * 真正的推力来自 `CharacterController` 的 `setApplyImpulsesToDynamicBodies(true)`：
 * Rapier 的角色控制器在 `computeColliderMovement` 里会把角色对动态刚体的接触
 * 换算成冲量。所以这里**不要**写任何 `applyImpulse`——
 * 那会变成"双重推力"，箱子被推飞，P8 验收会红。
 */
export function canPush(
  pos: readonly [number, number, number],
  yaw: number,
  propPositions: readonly (readonly [number, number, number])[],
  reach = PUSH_REACH,
): boolean {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  for (const p of propPositions) {
    const dx = p[0] - pos[0];
    const dz = p[2] - pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist > reach) continue;
    // 必须在**前方**（点积 > 0），背后的箱子不算"够得着"
    if (dx * fx + dz * fz > 0) return true;
  }
  return false;
}

// ───────────────────────────── 看向 ─────────────────────────────

/** 相机焦点的缓动状态机。 */
export interface FocusState {
  /** 当前焦点（null = 跟随自己）。 */
  target: EntityId | null;
  /** 0..1，1 表示已到位。 */
  t: number;
}

export function initialFocus(): FocusState {
  return { target: null, t: 1 };
}

/** 点击一个角色：开始缓动到它。`null` 表示回到跟随自己。 */
export function focusOn(target: EntityId | null): FocusState {
  return { target, t: 0 };
}

/**
 * 推进焦点缓动。返回新的进度（0..1）。
 *
 * 用**线性 + smoothstep** 而不是弹簧：焦点切换是"意图明确的一次转场"，
 * 弹簧会有过冲，观感像镜头撞了一下。
 */
export function advanceFocus(state: FocusState, dt: number, duration = FOCUS_EASE_SECONDS): number {
  if (state.t >= 1) return 1;
  const step = duration > 0 ? dt / duration : 1;
  return Math.min(1, state.t + step);
}

/** smoothstep 缓动：t=0→0, t=0.5→0.5, t=1→1，两端速度为 0。 */
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * 焦点插值：从 `from` 到 `to` 按 smoothstep 缓动。
 *
 * 用于相机看向的位置（不是相机位置本身——相机位置由 `render/camera.ts` 的
 * 弹簧跟随决定，这里只提供"看哪里"）。
 */
export function lerpFocus(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const k = smoothstep(t);
  return [
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k,
    from[2] + (to[2] - from[2]) * k,
  ];
}
