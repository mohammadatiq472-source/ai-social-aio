/**
 * 房间定义与校验（spec §6 M6）。
 *
 * 三条设计约束，写在这里防止后来人图省事破坏：
 *
 * 1. **这个文件不许 import three / rapier**。
 *    房间是纯数据 + 纯推导，要能在 node 里裸跑单测，将来也要能被 v0.2 的房间服务复用。
 *    「同一份 JSON 既生成网格也生成碰撞体」的实现方式是：两边都消费 `roomSolids()` 的
 *    同一份输出，而不是各自把 JSON 解释一遍——否则一旦解释逻辑分叉，
 *    你看到的墙和你撞到的墙就会不是同一面。
 *
 * 2. **校验错误必须带路径**。
 *    报 "size 不合法" 没用；要报 `static[2].size 必须是长度 3 的数字数组`。
 *    房间是手写 JSON，出错时作者需要能直接定位到那一个字段。
 *
 * 3. **不复用 three 的欧拉角**。
 *    rot 用 [rx, ry, rz]（弧度，XYZ 顺序，与 three 的 `Euler(x,y,z,'XYZ')` 等价），
 *    这里自己转四元数（qx*qy*qz）。这样 room.ts 保持零渲染依赖，
 *    且烘焙出的四元数与渲染侧 setFromEuler 逐位一致（有单测锁住这一点）。
 */

import { normalizeQuat } from './types';

// ───────────────────────────── 类型（对外契约） ─────────────────────────────

/** 三分量向量。用元组而不是 number[]，让越界访问在编译期就暴露。 */
export type Vec3 = [number, number, number];

/** 灯光。v0.1 只用到 dir / hemi / point，够照亮一个屋子。 */
export interface RoomLight {
  type: 'dir' | 'hemi' | 'point';
  /** dir 的照射方向（世界空间，会被归一化）；point 用 position。 */
  dir?: Vec3;
  position?: Vec3;
  color: string;
  intensity: number;
  /** dir 光是否投影。默认 dir 为 true、其它为 false。 */
  shadows?: boolean;
}

/** 静态几何的公共字段。 */
interface StaticBase {
  pos: Vec3;
  /** 欧拉角（弧度，XYZ）。省略即无旋转。 */
  rot?: Vec3;
  /** 材质 key，渲染侧据此选贴图/颜色；物理侧不关心。 */
  mat?: string;
}

/** 盒体：size 是**全尺寸**（不是半尺寸）。 */
export interface RoomBox extends StaticBase {
  type: 'box';
  size: Vec3;
}

/** 斜坡：本质是一个旋转过的薄盒。size 是全尺寸，rot 负责倾斜。 */
export interface RoomRamp extends StaticBase {
  type: 'ramp';
  size: Vec3;
}

/** 台阶：展开成 steps 个实心立方体，沿 +z 递增。 */
export interface RoomStairs extends StaticBase {
  type: 'stairs';
  steps: number;
  rise: number;
  run: number;
  /** 踏步宽度（x 方向）。默认 1.6m，够两个人并排。 */
  width?: number;
}

export type RoomStatic = RoomBox | RoomRamp | RoomStairs;

/** 可推动道具（动态刚体）。 */
export interface RoomProp {
  type: 'box';
  size: Vec3;
  pos: Vec3;
  rot?: Vec3;
  /** 质量（kg）。P8 验收用 10kg。 */
  mass: number;
  mat?: string;
}

/** 座位。rot 是朝向角（弧度，绕 y 轴），不是欧拉三元组。 */
export interface RoomSeat {
  id: string;
  pos: Vec3;
  rot: number;
}

/** 一个完整房间。这是加载器对外的唯一产物。 */
export interface Room {
  name: string;
  /** 出生点列表，按顺序分配给人/Agent。 */
  spawn: Vec3[];
  lights: RoomLight[];
  static: RoomStatic[];
  props: RoomProp[];
  seats: RoomSeat[];
}

// ───────────────────────────── 校验 ─────────────────────────────

/** 一条校验错误。`path` 是可直接定位到 JSON 字段的路径。 */
export interface RoomIssue {
  /** 例：`static[2].size`；整体错误用 `$`。 */
  path: string;
  message: string;
}

export class RoomValidationError extends Error {
  readonly issues: readonly RoomIssue[];

  constructor(issues: readonly RoomIssue[]) {
    super(`房间定义不合法（${issues.length} 处）：\n${formatIssues(issues)}`);
    this.name = 'RoomValidationError';
    this.issues = issues;
  }
}

/** 把错误列表格式化成多行文本（CLI / 控制台直接可读）。 */
export function formatIssues(issues: readonly RoomIssue[]): string {
  return issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
}

/** 收集器：一次跑完所有字段，而不是遇到第一个错就抛——作者要一次看到全部问题。 */
class IssueBag {
  readonly items: RoomIssue[] = [];

  add(path: string, message: string): void {
    this.items.push({ path, message });
  }

  get ok(): boolean {
    return this.items.length === 0;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readVec3(
  bag: IssueBag,
  path: string,
  raw: unknown,
  opts: { optional?: boolean } = {},
): Vec3 | undefined {
  if (raw === undefined) {
    if (!opts.optional) bag.add(path, '缺少必填字段（长度 3 的数字数组）');
    return undefined;
  }
  if (!Array.isArray(raw)) {
    bag.add(path, `必须是长度 3 的数组，收到 ${describe(raw)}`);
    return undefined;
  }
  if (raw.length !== 3) {
    bag.add(path, `必须是长度 3 的数组，收到长度 ${raw.length}`);
    return undefined;
  }
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v: unknown = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      bag.add(`${path}[${i}]`, `必须是有限数字，收到 ${describe(v)}`);
      return undefined;
    }
    out.push(v);
  }
  return [out[0]!, out[1]!, out[2]!];
}

function readNumber(
  bag: IssueBag,
  path: string,
  raw: unknown,
  opts: { optional?: boolean; min?: number; max?: number; integer?: boolean; fallback?: number } = {},
): number | undefined {
  if (raw === undefined) {
    if (opts.fallback !== undefined) return opts.fallback;
    if (!opts.optional) bag.add(path, '缺少必填字段（数字）');
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    bag.add(path, `必须是有限数字，收到 ${describe(raw)}`);
    return undefined;
  }
  if (opts.integer && !Number.isInteger(raw)) {
    bag.add(path, `必须是整数，收到 ${raw}`);
    return undefined;
  }
  if (opts.min !== undefined && raw < opts.min) {
    bag.add(path, `必须 ≥ ${opts.min}，收到 ${raw}`);
    return undefined;
  }
  if (opts.max !== undefined && raw > opts.max) {
    bag.add(path, `必须 ≤ ${opts.max}，收到 ${raw}`);
    return undefined;
  }
  return raw;
}

function readString(
  bag: IssueBag,
  path: string,
  raw: unknown,
  opts: { optional?: boolean; nonEmpty?: boolean } = {},
): string | undefined {
  if (raw === undefined) {
    if (!opts.optional) bag.add(path, '缺少必填字段（字符串）');
    return undefined;
  }
  if (typeof raw !== 'string') {
    bag.add(path, `必须是字符串，收到 ${describe(raw)}`);
    return undefined;
  }
  if (opts.nonEmpty !== false && raw.length === 0) {
    bag.add(path, '不能是空字符串');
    return undefined;
  }
  return raw;
}

/** 报错信息里的值描述：截断长值，避免把整个 JSON 打进日志。 */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组(长度 ${v.length})`;
  if (typeof v === 'object') return '对象';
  if (typeof v === 'string') return `字符串 ${JSON.stringify(v.slice(0, 24))}`;
  return `${typeof v} ${String(v)}`;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function readColor(bag: IssueBag, path: string, raw: unknown): string | undefined {
  const s = readString(bag, path, raw);
  if (s === undefined) return undefined;
  if (!HEX_COLOR.test(s)) {
    bag.add(path, `必须是 #rgb 或 #rrggbb 形式的颜色，收到 ${JSON.stringify(s)}`);
    return undefined;
  }
  return s;
}

function readStatic(bag: IssueBag, path: string, raw: unknown): RoomStatic | undefined {
  if (!isPlainObject(raw)) {
    bag.add(path, `必须是对象，收到 ${describe(raw)}`);
    return undefined;
  }
  const type = readString(bag, `${path}.type`, raw['type']);
  if (type === undefined) return undefined;
  if (type !== 'box' && type !== 'ramp' && type !== 'stairs') {
    bag.add(`${path}.type`, `必须是 "box" | "ramp" | "stairs" 之一，收到 ${JSON.stringify(type)}`);
    return undefined;
  }

  const pos = readVec3(bag, `${path}.pos`, raw['pos']);
  const rot = readVec3(bag, `${path}.rot`, raw['rot'], { optional: true });
  const mat = readString(bag, `${path}.mat`, raw['mat'], { optional: true });

  if (type === 'stairs') {
    const steps = readNumber(bag, `${path}.steps`, raw['steps'], { integer: true, min: 1, max: 64 });
    const rise = readNumber(bag, `${path}.rise`, raw['rise'], { min: 0.01, max: 2 });
    const run = readNumber(bag, `${path}.run`, raw['run'], { min: 0.01, max: 2 });
    const width = readNumber(bag, `${path}.width`, raw['width'], { min: 0.1, max: 20, fallback: 1.6 });
    if (pos === undefined || steps === undefined || rise === undefined || run === undefined || width === undefined) {
      return undefined;
    }
    const stairs: RoomStairs = { type: 'stairs', pos, steps, rise, run, width };
    if (rot) stairs.rot = rot;
    if (mat) stairs.mat = mat;
    return stairs;
  }

  const size = readVec3(bag, `${path}.size`, raw['size']);
  if (pos === undefined || size === undefined) return undefined;
  // 尺寸必须为正：负尺寸会让烘焙出的 cuboid 半长反向，表现是"看不见但挡人"的墙。
  for (let i = 0; i < 3; i++) {
    const v = size[i]!;
    if (v <= 0) {
      bag.add(`${path}.size[${i}]`, `必须 > 0，收到 ${v}`);
      return undefined;
    }
  }
  if (type === 'box') {
    const box: RoomBox = { type: 'box', size, pos };
    if (rot) box.rot = rot;
    if (mat) box.mat = mat;
    return box;
  }
  const ramp: RoomRamp = { type: 'ramp', size, pos };
  if (rot) ramp.rot = rot;
  if (mat) ramp.mat = mat;
  return ramp;
}

function readLight(bag: IssueBag, path: string, raw: unknown): RoomLight | undefined {
  if (!isPlainObject(raw)) {
    bag.add(path, `必须是对象，收到 ${describe(raw)}`);
    return undefined;
  }
  const type = readString(bag, `${path}.type`, raw['type']);
  if (type === undefined) return undefined;
  if (type !== 'dir' && type !== 'hemi' && type !== 'point') {
    bag.add(`${path}.type`, `必须是 "dir" | "hemi" | "point" 之一，收到 ${JSON.stringify(type)}`);
    return undefined;
  }
  const color = readColor(bag, `${path}.color`, raw['color']);
  const intensity = readNumber(bag, `${path}.intensity`, raw['intensity'], { min: 0, max: 100 });
  const dir = readVec3(bag, `${path}.dir`, raw['dir'], { optional: type !== 'dir' });
  const position = readVec3(bag, `${path}.position`, raw['position'], { optional: true });
  if (color === undefined || intensity === undefined) return undefined;
  if (type === 'dir' && dir === undefined) return undefined;

  const light: RoomLight = { type, color, intensity };
  if (dir) light.dir = dir;
  if (position) light.position = position;
  if (typeof raw['shadows'] === 'boolean') light.shadows = raw['shadows'];
  return light;
}

function readProp(bag: IssueBag, path: string, raw: unknown): RoomProp | undefined {
  if (!isPlainObject(raw)) {
    bag.add(path, `必须是对象，收到 ${describe(raw)}`);
    return undefined;
  }
  const type = readString(bag, `${path}.type`, raw['type']);
  if (type !== 'box') {
    bag.add(`${path}.type`, `目前只支持 "box"，收到 ${JSON.stringify(type)}`);
    return undefined;
  }
  const size = readVec3(bag, `${path}.size`, raw['size']);
  const pos = readVec3(bag, `${path}.pos`, raw['pos']);
  const rot = readVec3(bag, `${path}.rot`, raw['rot'], { optional: true });
  const mass = readNumber(bag, `${path}.mass`, raw['mass'], { min: 0.01, max: 500 });
  const mat = readString(bag, `${path}.mat`, raw['mat'], { optional: true });
  if (size === undefined || pos === undefined || mass === undefined) return undefined;
  for (let i = 0; i < 3; i++) {
    const v = size[i]!;
    if (v <= 0) {
      bag.add(`${path}.size[${i}]`, `必须 > 0，收到 ${v}`);
      return undefined;
    }
  }
  const prop: RoomProp = { type: 'box', size, pos, mass };
  if (rot) prop.rot = rot;
  if (mat) prop.mat = mat;
  return prop;
}

function readSeat(bag: IssueBag, path: string, raw: unknown): RoomSeat | undefined {
  if (!isPlainObject(raw)) {
    bag.add(path, `必须是对象，收到 ${describe(raw)}`);
    return undefined;
  }
  const id = readString(bag, `${path}.id`, raw['id']);
  const pos = readVec3(bag, `${path}.pos`, raw['pos']);
  const rot = readNumber(bag, `${path}.rot`, raw['rot'], { fallback: 0 });
  if (id === undefined || pos === undefined || rot === undefined) return undefined;
  return { id, pos, rot };
}

export interface ValidateResult {
  ok: boolean;
  /** 仅在 ok 为 true 时存在。 */
  room?: Room;
  issues: RoomIssue[];
}

/**
 * 校验任意 JSON 值。**不抛异常**，返回结构化结果——加载器要能决定是"报错给用户看"
 * 还是"回退到默认房间"，这不该由异常控制流决定。
 */
export function validateRoom(raw: unknown): ValidateResult {
  const bag = new IssueBag();

  if (!isPlainObject(raw)) {
    bag.add('$', `房间定义必须是对象，收到 ${describe(raw)}`);
    return { ok: false, issues: bag.items };
  }

  const name = readString(bag, 'name', raw['name']);

  // spawn：每个元素是 Vec3。允许为空（空房间），但字段必须存在。
  const spawn: Vec3[] = [];
  const rawSpawn = raw['spawn'];
  if (rawSpawn === undefined) {
    bag.add('spawn', '缺少必填字段（出生点数组）');
  } else if (!Array.isArray(rawSpawn)) {
    bag.add('spawn', `必须是数组，收到 ${describe(rawSpawn)}`);
  } else {
    for (let i = 0; i < rawSpawn.length; i++) {
      const v = readVec3(bag, `spawn[${i}]`, rawSpawn[i]);
      if (v) spawn.push(v);
    }
  }

  const lights: RoomLight[] = [];
  const rawLights = raw['lights'];
  if (rawLights === undefined) {
    bag.add('lights', '缺少必填字段（灯光数组，可以为空数组）');
  } else if (!Array.isArray(rawLights)) {
    bag.add('lights', `必须是数组，收到 ${describe(rawLights)}`);
  } else {
    for (let i = 0; i < rawLights.length; i++) {
      const v = readLight(bag, `lights[${i}]`, rawLights[i]);
      if (v) lights.push(v);
    }
  }

  const statics: RoomStatic[] = [];
  const rawStatic = raw['static'];
  if (rawStatic === undefined) {
    bag.add('static', '缺少必填字段（静态几何数组）');
  } else if (!Array.isArray(rawStatic)) {
    bag.add('static', `必须是数组，收到 ${describe(rawStatic)}`);
  } else {
    for (let i = 0; i < rawStatic.length; i++) {
      const v = readStatic(bag, `static[${i}]`, rawStatic[i]);
      if (v) statics.push(v);
    }
  }

  const props: RoomProp[] = [];
  const rawProps = raw['props'];
  if (rawProps === undefined) {
    bag.add('props', '缺少必填字段（道具数组，可以为空数组）');
  } else if (!Array.isArray(rawProps)) {
    bag.add('props', `必须是数组，收到 ${describe(rawProps)}`);
  } else {
    for (let i = 0; i < rawProps.length; i++) {
      const v = readProp(bag, `props[${i}]`, rawProps[i]);
      if (v) props.push(v);
    }
  }

  const seats: RoomSeat[] = [];
  const rawSeats = raw['seats'];
  if (rawSeats === undefined) {
    bag.add('seats', '缺少必填字段（座位数组，可以为空数组）');
  } else if (!Array.isArray(rawSeats)) {
    bag.add('seats', `必须是数组，收到 ${describe(rawSeats)}`);
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < rawSeats.length; i++) {
      const v = readSeat(bag, `seats[${i}]`, rawSeats[i]);
      if (!v) continue;
      if (seen.has(v.id)) {
        // 座位 id 是意图 `{t:'sit', seat}` 的寻址键，重复会让"坐哪"变成未定义行为
        bag.add(`seats[${i}].id`, `座位 id 重复：${JSON.stringify(v.id)}（同文件内必须唯一）`);
        continue;
      }
      seen.add(v.id);
      seats.push(v);
    }
  }

  if (!bag.ok) return { ok: false, issues: bag.items };

  return {
    ok: true,
    issues: [],
    room: {
      name: name ?? '未命名房间',
      spawn,
      lights,
      static: statics,
      props,
      seats,
    },
  };
}

/** 校验并返回房间；不合法时抛 `RoomValidationError`（带 issues）。 */
export function parseRoom(raw: unknown): Room {
  const result = validateRoom(raw);
  if (!result.ok || !result.room) throw new RoomValidationError(result.issues);
  return result.room;
}

// ───────────────────────────── 旋转 ─────────────────────────────

/**
 * 欧拉角 [rx, ry, rz]（弧度，XYZ 顺序）→ 四元数 [x,y,z,w]。
 *
 * 顺序必须与 three 的 `new Euler(x,y,z,'XYZ')` 一致：结果是 qx*qy*qz。
 * 单测里对着 three 的 setFromEuler 逐位比对，防止有人"顺手"改成 ZYX——
 * 那会让斜坡在渲染里朝东、在物理里朝西。
 */
export function eulerToQuat(rot: Vec3): [number, number, number, number] {
  const [rx, ry, rz] = rot;
  const hx = rx * 0.5;
  const hy = ry * 0.5;
  const hz = rz * 0.5;
  const cx = Math.cos(hx);
  const sx = Math.sin(hx);
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cz = Math.cos(hz);
  const sz = Math.sin(hz);

  // qx * qy * qz 的展开式
  const x = sx * cy * cz + cx * sy * sz;
  const y = cx * sy * cz - sx * cy * sz;
  const z = cx * cy * sz + sx * sy * cz;
  const w = cx * cy * cz - sx * sy * sz;
  return normalizeQuat([x, y, z, w]);
}

/** 绕 y 轴的朝向角 → 四元数（座位用）。 */
export function yawToQuat(yaw: number): [number, number, number, number] {
  const h = yaw * 0.5;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

// ───────────────────────────── 几何推导 ─────────────────────────────

/**
 * 一个实心块的最终形态：中心 + 半尺寸 + 四元数。
 *
 * 这是**渲染网格与物理碰撞体的共同输入**。谁都不许再自己解释一遍 room JSON，
 * 否则"看得见的墙"和"撞得到的墙"会分叉（这是这类系统最经典的 bug）。
 */
export interface RoomSolid {
  /** 来源在 static 数组里的下标，便于出错时定位。 */
  sourceIndex: number;
  /** 来源类型。stairs 会展开成多个 cuboid。 */
  sourceType: RoomStatic['type'];
  /** 中心点（世界空间）。 */
  pos: Vec3;
  /** 半尺寸（米）。 */
  halfExtents: Vec3;
  /** 旋转四元数 [x,y,z,w]。 */
  rot: [number, number, number, number];
  /** 材质 key（渲染侧用，物理侧忽略）。 */
  mat?: string;
}

/** 台阶默认踏步宽度。 */
export const DEFAULT_STAIR_WIDTH = 1.6;

/**
 * 把房间的静态几何展开成一串实心块。纯函数、无分配陷阱（一次性调用，不在热路径）。
 *
 * 台阶的展开方式：第 i 级是一个从地面 y=0 一直堆到该级顶面的**实心**盒，
 * 而不是一块薄板。理由：薄板台阶会让角色控制器在缝隙处踩空，
 * 实心台阶等价于"一整块被切出来的楼梯"，autostep 才有连续的支撑面。
 */
export function roomSolids(room: Room): RoomSolid[] {
  const out: RoomSolid[] = [];

  for (let i = 0; i < room.static.length; i++) {
    const s = room.static[i]!;
    const rot = s.rot ? eulerToQuat(s.rot) : ([0, 0, 0, 1] as [number, number, number, number]);

    if (s.type === 'stairs') {
      const width = s.width ?? DEFAULT_STAIR_WIDTH;
      for (let step = 0; step < s.steps; step++) {
        const height = s.rise * (step + 1);
        out.push({
          sourceIndex: i,
          sourceType: 'stairs',
          pos: [
            s.pos[0],
            s.pos[1] + height * 0.5,
            s.pos[2] + s.run * (step + 0.5),
          ],
          halfExtents: [width * 0.5, height * 0.5, s.run * 0.5],
          rot,
          ...(s.mat === undefined ? {} : { mat: s.mat }),
        });
      }
      continue;
    }

    out.push({
      sourceIndex: i,
      sourceType: s.type,
      pos: [s.pos[0], s.pos[1], s.pos[2]],
      halfExtents: [s.size[0] * 0.5, s.size[1] * 0.5, s.size[2] * 0.5],
      rot,
      ...(s.mat === undefined ? {} : { mat: s.mat }),
    });
  }

  return out;
}

/** 道具的最终形态（动态刚体）。与 RoomSolid 分开：它会被物理推动，不能被当成静态烘焙。 */
export interface RoomPropSolid {
  sourceIndex: number;
  pos: Vec3;
  halfExtents: Vec3;
  rot: [number, number, number, number];
  mass: number;
  mat?: string;
}

export function roomPropSolids(room: Room): RoomPropSolid[] {
  return room.props.map((p, i) => ({
    sourceIndex: i,
    pos: [p.pos[0], p.pos[1], p.pos[2]] as Vec3,
    halfExtents: [p.size[0] * 0.5, p.size[1] * 0.5, p.size[2] * 0.5] as Vec3,
    rot: p.rot ? eulerToQuat(p.rot) : ([0, 0, 0, 1] as [number, number, number, number]),
    mass: p.mass,
    ...(p.mat === undefined ? {} : { mat: p.mat }),
  }));
}

/**
 * 第 n 个出生点。人数超过出生点数时**环绕复用**（而不是报错）：
 * 房间作者不该被迫为"最多可能有几个人"写满出生点；环绕会让重叠，
 * 所以沿 x 轴做一个 0.6m 的错位，避免两个角色出生即互相穿插。
 */
export function spawnPoint(room: Room, index: number): Vec3 {
  if (room.spawn.length === 0) return [0, 0.1, 0];
  const base = room.spawn[index % room.spawn.length]!;
  const lap = Math.floor(index / room.spawn.length);
  if (lap === 0) return [base[0], base[1], base[2]];
  return [base[0] + lap * 0.6, base[1], base[2]];
}

// ───────────────────────────── 加载 ─────────────────────────────

/** 默认房间文件（相对站点根；Vite 的 base 是 './'，用绝对路径会 404）。 */
export const DEFAULT_ROOM_URL = 'rooms/demo-room.json';

/**
 * 拉取并校验房间 JSON。
 *
 * 注意：`base: './'` 意味着页面可能在子路径下（Qoder Sites 部署），
 * 所以这里用相对当前文档的路径，而不是 '/rooms/...'。
 */
export async function loadRoom(url: string = DEFAULT_ROOM_URL): Promise<Room> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`房间加载失败：${url} 返回 HTTP ${res.status} ${res.statusText}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`房间 JSON 解析失败：${url}（${err instanceof Error ? err.message : String(err)}）`);
  }
  try {
    return parseRoom(json);
  } catch (err) {
    if (err instanceof RoomValidationError) {
      throw new Error(`房间 ${url} 校验失败：\n${formatIssues(err.issues)}`);
    }
    throw err;
  }
}
