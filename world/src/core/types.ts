/**
 * 协议单一来源（spec §4.1 / §4.2）。
 *
 * 纪律：
 * - 这个文件一旦冻结，**任何改动都必须先广播给全体成员**（types 是所有模块的公共契约）。
 * - 不依赖 three / rapier / DOM。纯数据 + 纯函数，可以在 node 里直接单测。
 * - 线上形态（JSON v0.1 / 二进制 v0.2）只允许从这里派生编码，禁止各处自己拼字段名。
 */

/** 实体标识。前缀约定：`p:<seq>` 玩家 / `a:<seq>` Agent / `prop:<seq>` 道具。 */
export type EntityId = string;

/** 位置 `p` = [x, y, z]（米），旋转 `r` = 四元数 [x, y, z, w]（已归一化，避免万向锁）。 */
export interface Transform {
  p: [number, number, number];
  r: [number, number, number, number];
}

/** 谁在驱动这个 actor：人类（键盘/触屏）还是 Agent（意图队列）。 */
export type ActorKind = 'human' | 'agent';

/** 动画状态机的状态名。v0.1 固定这 7 个，与 spec §4.1 逐字一致。 */
export type AnimName = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'sit' | 'emote';

/** 头顶气泡。`until` 是**世界时间**（秒），不是 Date.now()，这样回放/快照才对得上。 */
export interface Bubble {
  text: string;
  until: number;
}

/** 一个 actor 的完整对外状态。渲染层只读这个，不读物理内部结构。 */
export interface ActorState {
  id: EntityId;
  kind: ActorKind;
  name: string;
  transform: Transform;
  anim: AnimName;
  /** 0..1 动画相位，便于两端对齐（不靠本地时间各跑各的）。 */
  animPhase: number;
  bubble?: Bubble;
  /** 染色变体 key（M2 的一份几何 × N 份材质）。 */
  tint?: string;
}

/** Agent 想让身体做的一件事。进队列、可能失败（spec §4.2）。 */
export type Intent =
  | { t: 'move'; to: [number, number, number]; speed?: 'walk' | 'run' }
  | { t: 'look'; at: [number, number, number] }
  | { t: 'say'; text: string; ms?: number }
  | { t: 'emote'; name: string }
  | { t: 'sit'; seat: string }
  | { t: 'wait'; ms: number }
  | { t: 'leave' };

/** 意图失败回报：不静默丢弃（spec §4.2 最后一条规则）。 */
export interface IntentFailure {
  t: 'failed';
  reason: string;
  /** 是哪条意图失败的，便于 Agent 侧对账。 */
  intent?: Intent['t'];
}

export type IntentResult = { ok: true } | IntentFailure;

/** 意图队列上限：一个 Agent 同时最多 8 条待执行（spec §4.2）。 */
export const MAX_PENDING_INTENTS = 8;

/** 物理固定步长与单帧最大追赶步数（M1/M3 共用，写在协议层避免两边各写一份）。 */
export const PHYSICS_DT = 1 / 60;
export const MAX_CATCHUP_STEPS = 3;

// ───────────────────────────── 构造与判等 ─────────────────────────────

export function createTransform(
  p: [number, number, number] = [0, 0, 0],
  r: [number, number, number, number] = [0, 0, 0, 1],
): Transform {
  return { p: [p[0], p[1], p[2]], r: [r[0], r[1], r[2], r[3]] };
}

export function cloneTransform(t: Transform): Transform {
  return { p: [t.p[0], t.p[1], t.p[2]], r: [t.r[0], t.r[1], t.r[2], t.r[3]] };
}

export function transformEquals(a: Transform, b: Transform, eps = 1e-6): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.p[i]! - b.p[i]!) > eps) return false;
  }
  for (let i = 0; i < 4; i++) {
    if (Math.abs(a.r[i]! - b.r[i]!) > eps) return false;
  }
  return true;
}

export function distance(a: readonly number[], b: readonly number[]): number {
  const dx = (a[0] ?? 0) - (b[0] ?? 0);
  const dy = (a[1] ?? 0) - (b[1] ?? 0);
  const dz = (a[2] ?? 0) - (b[2] ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ───────────────────────────── EntityId ─────────────────────────────

export type EntityPrefix = 'p' | 'a' | 'prop';

export function makeEntityId(prefix: EntityPrefix, seq: number): EntityId {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new RangeError(`makeEntityId: seq 必须是非负整数，收到 ${seq}`);
  }
  return `${prefix}:${seq}`;
}

/** 解析 id；不合法返回 null（不要抛——网络来的脏数据不该炸掉渲染循环）。 */
export function parseEntityId(id: string): { prefix: EntityPrefix; seq: number } | null {
  const m = /^(p|a|prop):(\d+)$/.exec(id);
  if (!m) return null;
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq)) return null;
  return { prefix: m[1] as EntityPrefix, seq };
}

export function isActorId(id: EntityId): boolean {
  const parsed = parseEntityId(id);
  return parsed !== null && (parsed.prefix === 'p' || parsed.prefix === 'a');
}

// ───────────────────────────── 编解码（v0.1 JSON） ─────────────────────────────
// 线上字段名保持短名（p/r/t/to/at），与 spec §4.1 一致；这里集中做校验，
// 避免「快照里少一个分量」这类脏数据一路流进物理。

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

function isQuat(v: unknown): v is [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every(isFiniteNumber);
}

/** 四元数归一化。零四元数（脏数据）退化为单位旋转，绝不返回 NaN。 */
export function normalizeQuat(
  q: readonly [number, number, number, number],
): [number, number, number, number] {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(len) || len < 1e-8) return [0, 0, 0, 1];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function encodeTransform(t: Transform): { p: [number, number, number]; r: [number, number, number, number] } {
  return { p: [t.p[0], t.p[1], t.p[2]], r: normalizeQuat(t.r) };
}

/** 解不出合法 Transform 时返回 null（调用方决定是丢包还是用默认值兜底）。 */
export function decodeTransform(raw: unknown): Transform | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isVec3(o['p']) || !isQuat(o['r'])) return null;
  return { p: [o['p'][0], o['p'][1], o['p'][2]], r: normalizeQuat(o['r']) };
}

const ANIMS: ReadonlySet<string> = new Set<AnimName>([
  'idle', 'walk', 'run', 'jump', 'fall', 'sit', 'emote',
]);

export function isAnimName(v: unknown): v is AnimName {
  return typeof v === 'string' && ANIMS.has(v);
}

export function encodeActorState(s: ActorState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: s.id,
    kind: s.kind,
    name: s.name,
    transform: encodeTransform(s.transform),
    anim: s.anim,
    animPhase: s.animPhase,
  };
  if (s.bubble) out['bubble'] = { text: s.bubble.text, until: s.bubble.until };
  if (s.tint) out['tint'] = s.tint;
  return out;
}

export function decodeActorState(raw: unknown): ActorState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || parseEntityId(o['id']) === null) return null;
  if (o['kind'] !== 'human' && o['kind'] !== 'agent') return null;
  if (typeof o['name'] !== 'string') return null;
  const transform = decodeTransform(o['transform']);
  if (!transform) return null;
  if (!isAnimName(o['anim'])) return null;

  const phaseRaw = o['animPhase'];
  const animPhase = isFiniteNumber(phaseRaw) ? clamp01(phaseRaw) : 0;

  const state: ActorState = {
    id: o['id'],
    kind: o['kind'],
    name: o['name'],
    transform,
    anim: o['anim'],
    animPhase,
  };

  const bubble = o['bubble'];
  if (typeof bubble === 'object' && bubble !== null) {
    const b = bubble as Record<string, unknown>;
    if (typeof b['text'] === 'string' && isFiniteNumber(b['until'])) {
      state.bubble = { text: b['text'], until: b['until'] };
    }
  }
  if (typeof o['tint'] === 'string') state.tint = o['tint'];

  return state;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 意图编解码。未知 `t` 一律 null：v0.1 宁可拒绝，也不要半执行一条读不懂的意图。 */
export function encodeIntent(i: Intent): Record<string, unknown> {
  switch (i.t) {
    case 'move': {
      const out: Record<string, unknown> = { t: 'move', to: [...i.to] };
      if (i.speed) out['speed'] = i.speed;
      return out;
    }
    case 'look':
      return { t: 'look', at: [...i.at] };
    case 'say': {
      const out: Record<string, unknown> = { t: 'say', text: i.text };
      if (i.ms !== undefined) out['ms'] = i.ms;
      return out;
    }
    case 'emote':
      return { t: 'emote', name: i.name };
    case 'sit':
      return { t: 'sit', seat: i.seat };
    case 'wait':
      return { t: 'wait', ms: i.ms };
    case 'leave':
      return { t: 'leave' };
  }
}

export function decodeIntent(raw: unknown): Intent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o['t']) {
    case 'move': {
      if (!isVec3(o['to'])) return null;
      const speed = o['speed'];
      if (speed !== undefined && speed !== 'walk' && speed !== 'run') return null;
      const intent: Intent = { t: 'move', to: [o['to'][0], o['to'][1], o['to'][2]] };
      if (speed) intent.speed = speed;
      return intent;
    }
    case 'look': {
      if (!isVec3(o['at'])) return null;
      return { t: 'look', at: [o['at'][0], o['at'][1], o['at'][2]] };
    }
    case 'say': {
      if (typeof o['text'] !== 'string' || o['text'].length === 0) return null;
      const ms = o['ms'];
      if (ms !== undefined && !isFiniteNumber(ms)) return null;
      const intent: Intent = { t: 'say', text: o['text'] };
      if (isFiniteNumber(ms)) intent.ms = ms;
      return intent;
    }
    case 'emote': {
      if (typeof o['name'] !== 'string' || o['name'].length === 0) return null;
      return { t: 'emote', name: o['name'] };
    }
    case 'sit': {
      if (typeof o['seat'] !== 'string' || o['seat'].length === 0) return null;
      return { t: 'sit', seat: o['seat'] };
    }
    case 'wait': {
      if (!isFiniteNumber(o['ms']) || o['ms'] < 0) return null;
      return { t: 'wait', ms: o['ms'] };
    }
    case 'leave':
      return { t: 'leave' };
    default:
      return null;
  }
}

// ───────────────────────────── 插值（渲染层用） ─────────────────────────────

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 四元数球面线性插值。dot<0 走短弧，否则转身会绕远路。 */
export function slerp(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  t: number,
): [number, number, number, number] {
  let ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];

  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    dot = -dot;
    ax = -ax; ay = -ay; az = -az; aw = -aw;
  }

  if (dot > 0.9995) {
    // 太接近了，线性插值后归一化即可，避免除以接近 0 的 sin
    return normalizeQuat([lerp(ax, bx, t), lerp(ay, by, t), lerp(az, bz, t), lerp(aw, bw, t)]);
  }

  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const s0 = Math.sin((1 - t) * theta) / sinTheta;
  const s1 = Math.sin(t * theta) / sinTheta;
  return normalizeQuat([ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1]);
}

/** 渲染插值：物理 60Hz 的两帧之间按 alpha 补出画面帧（spec §3 Interp）。 */
export function interpolateTransform(a: Transform, b: Transform, alpha: number): Transform {
  const t = clamp01(alpha);
  return {
    p: [lerp(a.p[0], b.p[0], t), lerp(a.p[1], b.p[1], t), lerp(a.p[2], b.p[2], t)],
    r: slerp(a.r, b.r, t),
  };
}

/** 俯仰角夹取（相机禁止翻过头顶/钻到地下）。单位弧度。 */
export function clampPitch(pitch: number, min: number, max: number): number {
  return pitch < min ? min : pitch > max ? max : pitch;
}
