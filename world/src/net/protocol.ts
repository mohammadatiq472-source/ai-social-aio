/**
 * 网络协议（spec §4.3 / §6 M7）。**v0.1 只定形，不接线。**
 *
 * 这一版存在的唯一目的是：等 v0.2 真要开多人时，两端不需要再商量一次字节布局。
 * 所以这里有三条自我约束：
 *
 * 1. **不 import 任何网络库、不 import three/rapier**。
 *    协议是纯数据 + 纯函数，能在 node 里裸跑单测（本文件只 type-import `core/types`）。
 * 2. **布局写死在注释与常量里，编解码与常量必须同步改**。
 *    下面每个字段的字节偏移都写出来了；改字段顺序而不同步改 `SNAPSHOT_ENTITY_BYTES`
 *    会立刻被单测里的「字节长度 == 6 + 24n」断言抓住。
 * 3. **解码对脏数据宽容，编码对编程错误严格**。
 *    线上收到坏包不该让渲染循环崩（未知 anim → 回落 idle），
 *    但本地要编一个「实体表里没有的 id」是代码 bug，必须立刻抛。
 *
 * ═══════════════ snapshot 二进制布局（spec §6 M7 原文） ═══════════════
 *
 *   偏移  类型      字段
 *   0     uint32    seq            快照序号（单调递增，用于丢包检测与纠正）
 *   4     uint16    count          本帧实体数（0..65535）
 *   6     ── 每条记录 24 字节，紧接其后 ──
 *         偏移  类型        字段
 *         +0    uint16      idIndex    → 映射表下标（表随 hello 下发）
 *         +2    float32     x
 *         +6    float32     y
 *         +10   float32     z
 *         +14   int16       qx   ┐
 *         +16   int16       qy   │ 归一化到 [-32767, 32767]
 *         +18   int16       qz   │ 即 round(q * 32767)
 *         +20   int16       qw   ┘
 *         +22   uint8       anim     动画状态码（ANIM_CODES 的下标）
 *         +23   uint8       phase    动画相位 0..255 → 0..1
 *
 * 小端（`DataView` 默认参数 `littleEndian = false` 是**大端**，所以这里每处都显式传 true）。
 * 小端不是随便选的：x86/ARM 都是小端，v0.2 的服务端（Node）与浏览器同源，
 * 少一次字节序转换就少一个"本地好、真机坏"的坑。
 *
 * 为什么位置用 float32 而不是 int16 定点：
 * 房间尺度 24m，int16 定点在 ±24m 上只有 0.73mm 分辨率，够用；
 * 但 float32 的 24 字节/实体在这个规模（≤32 人 + 若干道具）下带宽完全不是瓶颈
 * （20Hz × 40 实体 × 24B ≈ 19KB/s），换成定点省下的 6 字节不值得多一套量化逻辑。
 * 四元数才用 int16：它天然落在 [-1,1]，量化误差 1/32767 ≈ 0.003°，肉眼不可见。
 */

import type { AnimName, EntityId } from '../core/types';

/** 协议版本。握手时两端必须相等，否则断开（v0.2）。 */
export const PROTOCOL_VERSION = 1;

/**
 * 消息类型号。
 *
 * 注意：**snapshot 的二进制里没有这个字节**——spec §6 M7 的布局以 `uint32 seq` 开头。
 * 类型号属于传输层（WS 的二进制帧 vs 文本帧，或 v0.2 的 1 字节前缀）。
 * 把它塞进 payload 会让布局与规格书不一致，所以这里只导出常量给传输层用。
 */
export const MSG = {
  HELLO: 1,
  INPUT: 2,
  SNAPSHOT: 3,
  EVENT: 4,
  PING: 5,
  PONG: 6,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/** 快照头部字节数：uint32 seq + uint16 count。 */
export const SNAPSHOT_HEADER_BYTES = 6;

/** 单条实体记录的字节数（见文件头布局表）。 */
export const SNAPSHOT_ENTITY_BYTES = 24;

/** uint16 的天然上限。超过它就必须分片（v0.2 的差量广播不会接近这个数）。 */
export const MAX_SNAPSHOT_ENTITIES = 0xffff;

/** 四元数量化的满量程。 */
export const QUAT_SCALE = 32767;

/** 动画状态码表。**顺序即线上编码**，只许追加不许重排（重排会让新旧客户端错位）。 */
export const ANIM_CODES = [
  'idle',
  'walk',
  'run',
  'jump',
  'fall',
  'sit',
  'emote',
] as const satisfies readonly AnimName[];

const ANIM_CODE_BY_NAME = new Map<string, number>(ANIM_CODES.map((a, i) => [a, i]));

// ───────────────────────────── 消息类型（spec §4.3） ─────────────────────────────

/**
 * C→S 一次：`{token, name, tint}` + **id 映射表**。
 *
 * 映射表跟着 hello 下发是 spec §6 M7 第 3 条的原文要求。放这里而不是另开一条
 * `idtable` 消息，是因为"表没到就收到 snapshot"是必须被结构性排除的状态：
 * 同一条消息里带表，解析完就已经可用，不需要额外的就绪状态机。
 */
export interface HelloMsg {
  token: string;
  name: string;
  tint?: string;
  /** idIndex ↔ EntityId 的映射表（顺序即下标）。 */
  idTable: EntityId[];
}

/** C→S 30Hz 的二进制输入（布局见 `encodeInput`）。 */
export interface InputMsg {
  tick: number;
  /** 世界空间水平方向（已归一化；0,0 = 不动）。 */
  moveX: number;
  moveZ: number;
  jump: boolean;
  /** 视角四元数 [x,y,z,w]（float32，不量化：视角抖动比位置更显眼）。 */
  look: [number, number, number, number];
}

/** 快照里的一个实体。 */
export interface SnapshotEntity {
  id: EntityId;
  p: [number, number, number];
  r: [number, number, number, number];
  anim: AnimName;
  /** 0..1。 */
  phase: number;
}

/** S→C 20Hz 快照。 */
export interface SnapshotMsg {
  seq: number;
  entities: SnapshotEntity[];
}

/** S→C 事件驱动（进出场/说话/交互）。v0.1 只定形。 */
export type EventMsg =
  | { t: 'join'; id: EntityId; name: string; tint?: string }
  | { t: 'leave'; id: EntityId }
  | { t: 'say'; id: EntityId; text: string; ms: number }
  | { t: 'sit'; id: EntityId; seat: string }
  | { t: 'stand'; id: EntityId };

/** 双向 1Hz：时钟同步与 RTT。 */
export interface PingMsg {
  /** 发送端序号，pong 原样带回。 */
  nonce: number;
  /** 发送端时钟（毫秒，`performance.now()` 或 `world.now*1000`，两端各自解释）。 */
  t: number;
}

// ───────────────────────────── id 映射表 ─────────────────────────────

/**
 * idIndex ↔ EntityId 的双向映射（随 hello 下发）。
 *
 * 为什么用类而不是裸数组：下标查找是每个实体每帧都要做的（编码 40 次/快照 × 20Hz），
 * 线性 `indexOf` 在这个量级上虽然也够，但一旦实体数上百就会变成 O(n²)。
 * 这里用 Map 做反查，`add` 幂等——hello 重发/重连时不会把表撑大或错位。
 */
export class IdTable {
  private readonly ids: EntityId[] = [];
  private readonly byId = new Map<EntityId, number>();

  constructor(ids: readonly EntityId[] = []) {
    for (const id of ids) this.add(id);
  }

  get size(): number {
    return this.ids.length;
  }

  /** 追加（幂等）。返回该 id 的下标。 */
  add(id: EntityId): number {
    const existing = this.byId.get(id);
    if (existing !== undefined) return existing;
    if (this.ids.length >= MAX_SNAPSHOT_ENTITIES) {
      throw new RangeError(
        `IdTable.add: 映射表已满（上限 ${MAX_SNAPSHOT_ENTITIES}，uint16 下标）。` +
          'v0.2 需要在满表时重建映射（只保留当前在线实体）。',
      );
    }
    const index = this.ids.length;
    this.ids.push(id);
    this.byId.set(id, index);
    return index;
  }

  indexOf(id: EntityId): number | undefined {
    return this.byId.get(id);
  }

  idAt(index: number): EntityId | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.ids.length) return undefined;
    return this.ids[index];
  }

  has(id: EntityId): boolean {
    return this.byId.has(id);
  }

  /** 下发给客户端的形态（顺序即下标，不要排序）。 */
  toArray(): EntityId[] {
    return [...this.ids];
  }
}

// ───────────────────────────── 量化 ─────────────────────────────

/** 四元数分量 → int16。越界夹取（脏数据不该溢出成另一个合法值）。 */
export function quantizeQuatComponent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const scaled = Math.round(v * QUAT_SCALE);
  if (scaled > QUAT_SCALE) return QUAT_SCALE;
  if (scaled < -QUAT_SCALE) return -QUAT_SCALE;
  return scaled;
}

/** int16 → 四元数分量。 */
export function dequantizeQuatComponent(v: number): number {
  return v / QUAT_SCALE;
}

/** 动画名 → 码。未知名字按 idle 处理（宽容，见文件头第 3 条）。 */
export function animToCode(anim: AnimName | string): number {
  return ANIM_CODE_BY_NAME.get(anim) ?? 0;
}

/** 码 → 动画名。未知码回落 idle。 */
export function codeToAnim(code: number): AnimName {
  return ANIM_CODES[code] ?? 'idle';
}

/** 0..1 → uint8。 */
export function quantizePhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  return Math.round(p * 255);
}

/** uint8 → 0..1。 */
export function dequantizePhase(v: number): number {
  return v / 255;
}

// ───────────────────────────── snapshot 编解码 ─────────────────────────────

/** 编码一个快照需要多少字节（供上层预分配/校验，避免编完才发现超长）。 */
export function snapshotByteLength(count: number): number {
  return SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_ENTITY_BYTES;
}

/**
 * 编码快照。
 *
 * `table` 是 id 映射表：编码时必须已经包含所有实体（表随 hello 下发，
 * 服务端在实体进场时先扩表再发快照）。表里没有的 id 直接抛——
 * 那是"表与实体表脱节"的代码 bug，静默写一个错误下标会让客户端把角色渲染成别人。
 */
export function encodeSnapshot(msg: SnapshotMsg, table: IdTable): ArrayBuffer {
  const count = msg.entities.length;
  if (count > MAX_SNAPSHOT_ENTITIES) {
    throw new RangeError(
      `encodeSnapshot: 实体数 ${count} 超过 uint16 上限 ${MAX_SNAPSHOT_ENTITIES}（v0.2 需分片）`,
    );
  }

  const buffer = new ArrayBuffer(snapshotByteLength(count));
  const view = new DataView(buffer);

  view.setUint32(0, msg.seq >>> 0, true);
  view.setUint16(4, count, true);

  let offset = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const e = msg.entities[i]!;
    const index = table.indexOf(e.id);
    if (index === undefined) {
      throw new Error(
        `encodeSnapshot: 实体 ${e.id} 不在 id 映射表里。` +
          '先 table.add(id) 再编码——否则客户端会把下标解析成另一个实体。',
      );
    }

    view.setUint16(offset, index, true);
    view.setFloat32(offset + 2, e.p[0], true);
    view.setFloat32(offset + 6, e.p[1], true);
    view.setFloat32(offset + 10, e.p[2], true);
    view.setInt16(offset + 14, quantizeQuatComponent(e.r[0]), true);
    view.setInt16(offset + 16, quantizeQuatComponent(e.r[1]), true);
    view.setInt16(offset + 18, quantizeQuatComponent(e.r[2]), true);
    view.setInt16(offset + 20, quantizeQuatComponent(e.r[3]), true);
    view.setUint8(offset + 22, animToCode(e.anim));
    view.setUint8(offset + 23, quantizePhase(e.phase));

    offset += SNAPSHOT_ENTITY_BYTES;
  }

  return buffer;
}

/**
 * 解码快照。
 *
 * 对**长度不足**的包直接抛：那是传输层截断，继续读会越界读出垃圾。
 * 对**内容非法**（未知 anim 码、下标超出映射表）宽容处理并计数，
 * 由调用方决定是否丢包——解码器不替上层做这个决定，但也不崩。
 */
export function decodeSnapshot(buffer: ArrayBuffer, table: IdTable): SnapshotMsg {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new RangeError(
      `decodeSnapshot: 包长 ${buffer.byteLength} 不足头部 ${SNAPSHOT_HEADER_BYTES} 字节`,
    );
  }

  const view = new DataView(buffer);
  const seq = view.getUint32(0, true);
  const count = view.getUint16(4, true);

  const expected = snapshotByteLength(count);
  if (buffer.byteLength < expected) {
    throw new RangeError(
      `decodeSnapshot: 声明 ${count} 个实体需要 ${expected} 字节，实收 ${buffer.byteLength}`,
    );
  }

  const entities: SnapshotEntity[] = [];
  let offset = SNAPSHOT_HEADER_BYTES;

  for (let i = 0; i < count; i++) {
    const index = view.getUint16(offset, true);
    const id = table.idAt(index);
    // 表里没有这个下标：跳过而不是抛。表是可扩的，客户端可能还没收到扩容通知。
    if (id === undefined) {
      offset += SNAPSHOT_ENTITY_BYTES;
      continue;
    }

    entities.push({
      id,
      p: [
        view.getFloat32(offset + 2, true),
        view.getFloat32(offset + 6, true),
        view.getFloat32(offset + 10, true),
      ],
      r: [
        dequantizeQuatComponent(view.getInt16(offset + 14, true)),
        dequantizeQuatComponent(view.getInt16(offset + 16, true)),
        dequantizeQuatComponent(view.getInt16(offset + 18, true)),
        dequantizeQuatComponent(view.getInt16(offset + 20, true)),
      ],
      anim: codeToAnim(view.getUint8(offset + 22)),
      phase: dequantizePhase(view.getUint8(offset + 23)),
    });

    offset += SNAPSHOT_ENTITY_BYTES;
  }

  return { seq, entities };
}

// ───────────────────────────── input 编解码 ─────────────────────────────

/**
 * input 布局（C→S 30Hz，29 字节）：
 *
 *   0   uint32   tick
 *   4   float32  moveX
 *   8   float32  moveZ
 *   12  uint8    flags（bit0 = jump）
 *   13  float32  look[0..3]（13,17,21,25）
 */
export const INPUT_BYTES = 29;

export function encodeInput(msg: InputMsg): ArrayBuffer {
  const buffer = new ArrayBuffer(INPUT_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, msg.tick >>> 0, true);
  view.setFloat32(4, msg.moveX, true);
  view.setFloat32(8, msg.moveZ, true);
  view.setUint8(12, msg.jump ? 1 : 0);
  view.setFloat32(13, msg.look[0], true);
  view.setFloat32(17, msg.look[1], true);
  view.setFloat32(21, msg.look[2], true);
  view.setFloat32(25, msg.look[3], true);
  return buffer;
}

export function decodeInput(buffer: ArrayBuffer): InputMsg {
  if (buffer.byteLength < INPUT_BYTES) {
    throw new RangeError(`decodeInput: 包长 ${buffer.byteLength} 不足 ${INPUT_BYTES} 字节`);
  }
  const view = new DataView(buffer);
  return {
    tick: view.getUint32(0, true),
    moveX: view.getFloat32(4, true),
    moveZ: view.getFloat32(8, true),
    jump: (view.getUint8(12) & 1) === 1,
    look: [
      view.getFloat32(13, true),
      view.getFloat32(17, true),
      view.getFloat32(21, true),
      view.getFloat32(25, true),
    ],
  };
}

// ───────────────────────────── ping / pong ─────────────────────────────

/**
 * ping/pong 布局（12 字节）：uint32 nonce + float64 发送时钟。
 * 用 float64 存时钟而不是 uint32 毫秒：float64 精度足够跑满一个会话，
 * 而 uint32 毫秒 49 天回绕——v0.2 的房间可能长开，回绕会让 RTT 突然变成负数。
 */
export const PING_BYTES = 12;

export function encodePing(msg: PingMsg): ArrayBuffer {
  const buffer = new ArrayBuffer(PING_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, msg.nonce >>> 0, true);
  view.setFloat64(4, msg.t, true);
  return buffer;
}

export function decodePing(buffer: ArrayBuffer): PingMsg {
  if (buffer.byteLength < PING_BYTES) {
    throw new RangeError(`decodePing: 包长 ${buffer.byteLength} 不足 ${PING_BYTES} 字节`);
  }
  const view = new DataView(buffer);
  return { nonce: view.getUint32(0, true), t: view.getFloat64(4, true) };
}

/** hello 是 JSON（spec §4.3 表格里只有 input/snapshot 是二进制）。 */
export function encodeHello(msg: HelloMsg): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    token: msg.token,
    name: msg.name,
    tint: msg.tint,
    idTable: msg.idTable,
  });
}

/** 解析 hello。版本不一致返回 null（调用方应断开，而不是"尽力而为"地继续）。 */
export function decodeHello(raw: string): HelloMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o['v'] !== PROTOCOL_VERSION) return null;
  if (typeof o['token'] !== 'string' || typeof o['name'] !== 'string') return null;
  const table = o['idTable'];
  if (!Array.isArray(table) || !table.every((x) => typeof x === 'string')) return null;
  const msg: HelloMsg = { token: o['token'], name: o['name'], idTable: table as EntityId[] };
  if (typeof o['tint'] === 'string') msg.tint = o['tint'];
  return msg;
}
