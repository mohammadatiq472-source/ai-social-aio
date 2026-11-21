export type Point2 = [number, number];

export interface CityBuilding {
  id: string;
  name?: string;
  height: number;
  heightSource: 'estimate' | 'ctbuh';
  rings: Point2[][];
}

/**
 * 程序化壳体（春茧/体育馆这类"没有楼体、只有壳"的地标）。
 *
 * 纯视觉参数：`center` 是壳在局部米制下的平面中心，`radii` 是椭圆的半轴（米），
 * `height` 是壳顶高度。**壳不参与碰撞**（见 runtime.ts），坐标必须来自真实轮廓
 * （生成器按两馆轮廓的并集包围盒算），手填会被 `test_city.py` 的几何测试抓到。
 */
export interface CityShell {
  /** 平面中心 [x, z]，米。 */
  center: [number, number];
  /** 平面椭圆半轴 [rx, rz]，米。 */
  radii: [number, number];
  /** 壳顶高度，米。 */
  height: number;
  /** 每族肋条数（两族交叉成菱形网格）；缺省见 `geometry.ts#SHELL.ribs`。 */
  ribs?: number;
}

/**
 * 一个明确核验过的地标。
 *
 * `kind` 缺省 = `'taper'`：带 `profile`（[高度m, 水平比例] 收分曲线）的塔楼，旧数据全是这一种。
 * `kind: 'shell'`：没有楼体，只有 `shell` 描述的程序化壳体，`profile` 可以不写。
 */
export interface CityLandmark {
  id: string;
  name: string;
  height: number;
  /** 收分曲线；`kind: 'shell'` 的壳体地标没有楼体，这个字段可省。 */
  profile?: [number, number][];
  /** 地标形态：收分塔（默认）或程序化壳体。 */
  kind?: 'taper' | 'shell';
  /** `kind: 'shell'` 时的壳体参数。 */
  shell?: CityShell;
}

/** 入口雨棚：位置、尺寸与可选文字牌；没有就不建。 */
export interface CityCanopy {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  label?: string;
}

/** 独立路牌（不挂在 placements 上）；没有就不建。 */
export interface CitySign {
  text: string;
  x: number;
  z: number;
  yaw: number;
  width: number;
}

/** 水面（深圳湾/内湖）：只渲染，不参与碰撞；rings 是局部米制多边形。 */
export interface CityWater {
  rings: Point2[][];
  /** 水面高度，默认 -0.1（略低于地面，避免与铺装/道路 z-fighting）。 */
  level?: number;
}

export interface CityRoad {
  id: string;
  width: number;
  walkway: boolean;
  points: Point2[];
}

export interface StreetPlacement {
  kind: 'tree' | 'lamp' | 'bench' | 'sign';
  x: number;
  z: number;
  yaw: number;
  /** sign 类零件的文字；缺省时用通用占位，不写死某条街名。 */
  label?: string;
}

export interface CityStreet {
  pavingHeight: number;
  paving: Point2[][][];
  placements: StreetPlacement[];
  canopy?: CityCanopy;
  signs?: CitySign[];
}

export interface CityData {
  version: 1;
  name: string;
  origin: Point2;
  bounds: [number, number, number, number];
  spawn: [number, number, number];
  buildings: CityBuilding[];
  roads: CityRoad[];
  street: CityStreet;
  attribution: { label: string; url: string }[];
  /** 地标可空：南山样区没有与平安同级的核验地标。 */
  landmark?: CityLandmark;
  /** 多个核验地标（春笋等）；与 landmark 合并使用，兼容福田的单地标写法。 */
  landmarks?: CityLandmark[];
  /** 水面（深圳湾）；只渲染，不参与碰撞。 */
  water?: CityWater;
  /** 信息卡上的补充说明；缺省时用通用文案。 */
  note?: string;
}

function requireValue(ok: unknown, field: string): asserts ok {
  if (!ok) throw new Error(`街区数据不合法：${field}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function vector(value: unknown, size: number, limit: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(
    v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit,
  );
}

function optionalText(value: unknown, limit: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= limit);
}

/**
 * 地标条目（单个 landmark 与 landmarks[] 共用同一套校验；`tiles.ts` 也复用这一份，
 * 避免单 JSON 与瓦片索引两套边界漂移）。
 *
 * 旧数据（只有 `profile`、没有 `kind`）逐字通过：`kind` 缺省即 `'taper'`，
 * 此时 `profile` 仍是必填。`kind: 'shell'` 才允许没有 `profile`。
 */
export function validateCityLandmark(value: unknown, field: string): void {
  requireValue(object(value) && typeof value.id === 'string' && value.id.length <= 120 &&
    typeof value.name === 'string' && value.name.length <= 80 &&
    typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0 && value.height <= 1000, field);
  requireValue(value.kind === undefined || value.kind === 'taper' || value.kind === 'shell', `${field} kind`);
  const shell = value.kind === 'shell';
  if (shell) {
    const spec = value.shell;
    requireValue(object(spec) && vector(spec.center, 2, 5000) && vector(spec.radii, 2, 5000) &&
      typeof spec.height === 'number' && Number.isFinite(spec.height) && spec.height > 0 && spec.height <= 200,
      `${field} shell`);
    const [rx, rz] = spec.radii as [number, number];
    // 半轴必须为正且不能大到把整个街区盖住（5000m 的壳没有意义，也挡住"参数写错一位"）。
    requireValue(rx > 1 && rz > 1 && rx <= 2000 && rz <= 2000, `${field} shell radii`);
    const ribs = (spec as { ribs?: unknown }).ribs;
    requireValue(ribs === undefined ||
      (typeof ribs === 'number' && Number.isInteger(ribs) && ribs >= 4 && ribs <= 64), `${field} shell ribs`);
  }
  // 壳体没有楼体，可以不写 profile；其它情况（含旧数据）profile 仍是必填。
  if (shell && value.profile === undefined) return;
  requireValue(Array.isArray(value.profile) && value.profile.length >= 2 && value.profile.length <= 100, `${field} profile`);
  let previous = -1;
  for (const point of value.profile as unknown[]) {
    requireValue(Array.isArray(point) && point.length === 2 && typeof point[0] === 'number' && Number.isFinite(point[0]) &&
      typeof point[1] === 'number' && Number.isFinite(point[1]), `${field} profile point`);
    const [height, scale] = point as [number, number];
    requireValue(height > previous && height <= 1000 && scale > 0 && scale <= 2, `${field} profile range`);
    previous = height;
  }
}

export function parseCityData(raw: unknown): CityData {
  requireValue(object(raw), 'root');
  requireValue(raw.version === 1 && typeof raw.name === 'string', 'version/name');
  requireValue(vector(raw.origin, 2, 180), 'origin');
  requireValue(vector(raw.bounds, 4, 5000), 'bounds');
  requireValue(raw.bounds[0]! < raw.bounds[2]! && raw.bounds[1]! < raw.bounds[3]!, 'bounds order');
  requireValue(vector(raw.spawn, 3, 5000) && raw.spawn[1]! >= 0 && raw.spawn[1]! <= 5, 'spawn');
  requireValue(raw.spawn[0]! > raw.bounds[0]! && raw.spawn[0]! < raw.bounds[2]! &&
    raw.spawn[2]! > raw.bounds[1]! && raw.spawn[2]! < raw.bounds[3]!, 'spawn bounds');
  // 单 JSON fallback 的上限：5×5km（12k 栋）实测 3.25MiB / parse 79ms，20000 足够；
  // 再大（8×8 / 全深圳）必须走瓦片 index，不要再调高这个数。
  requireValue(Array.isArray(raw.buildings) && raw.buildings.length > 0 && raw.buildings.length <= 20000, 'buildings');
  const ids = new Set<string>();
  for (const b of raw.buildings) {
    requireValue(object(b) && typeof b.id === 'string', 'building id');
    requireValue(!ids.has(b.id), 'duplicate building');
    ids.add(b.id);
    requireValue(b.name === undefined || typeof b.name === 'string', 'building name');
    requireValue(typeof b.height === 'number' && Number.isFinite(b.height) && b.height > 0 && b.height <= 1000, 'height');
    requireValue(b.heightSource === 'estimate' || b.heightSource === 'ctbuh', 'height source');
    requireValue(Array.isArray(b.rings) && b.rings.length > 0 && b.rings.length <= 100, 'rings');
    for (const ring of b.rings) {
      requireValue(Array.isArray(ring) && ring.length >= 3 && ring.length <= 5000 && ring.every(p => vector(p, 2, 5000)), 'ring points');
    }
  }
  requireValue(Array.isArray(raw.roads) && raw.roads.length <= 10000, 'roads');
  for (const road of raw.roads) {
    requireValue(object(road) && typeof road.id === 'string' && typeof road.walkway === 'boolean', 'road');
    requireValue(typeof road.width === 'number' && Number.isFinite(road.width) && road.width > 0 && road.width <= 50, 'road width');
    requireValue(Array.isArray(road.points) && road.points.length >= 2 && road.points.length <= 5000 && road.points.every(p => vector(p, 2, 5000)), 'road points');
  }
  requireValue(object(raw.street) && typeof raw.street.pavingHeight === 'number' && Number.isFinite(raw.street.pavingHeight) && raw.street.pavingHeight > 0 && raw.street.pavingHeight <= 0.3, 'street');
  requireValue(Array.isArray(raw.street.paving) && raw.street.paving.length <= 100, 'paving');
  for (const polygon of raw.street.paving) {
    requireValue(Array.isArray(polygon) && polygon.length > 0 && polygon.length <= 100, 'paving polygon');
    for (const ring of polygon) requireValue(Array.isArray(ring) && ring.length >= 3 && ring.length <= 5000 && ring.every(p => vector(p, 2, 5000)), 'paving ring');
  }
  requireValue(Array.isArray(raw.street.placements) && raw.street.placements.length <= 500, 'placements');
  for (const placement of raw.street.placements) {
    requireValue(object(placement) && ['tree', 'lamp', 'bench', 'sign'].includes(String(placement.kind)) && vector([placement.x, placement.z, placement.yaw], 3, 5000) && placement.yaw === 0 && optionalText(placement.label, 40), 'placement');
  }
  if (raw.street.canopy !== undefined) {
    const canopy = raw.street.canopy;
    requireValue(object(canopy) && vector([canopy.x, canopy.z, canopy.width, canopy.depth, canopy.height], 5, 5000) &&
      optionalText(canopy.label, 40), 'canopy');
    const size = canopy as { width: number; depth: number; height: number };
    requireValue(size.width > 0 && size.depth > 0 && size.height > 0 && size.height <= 50, 'canopy size');
  }
  if (raw.street.signs !== undefined) {
    requireValue(Array.isArray(raw.street.signs) && raw.street.signs.length <= 20, 'signs');
    for (const sign of raw.street.signs) {
      requireValue(object(sign) && typeof sign.text === 'string' && sign.text.length > 0 && sign.text.length <= 40 &&
        vector([sign.x, sign.z, sign.yaw, sign.width], 4, 5000), 'sign');
      const size = sign as { width: number };
      requireValue(size.width > 0 && size.width <= 20, 'sign width');
    }
  }
  if (raw.landmark !== undefined) validateCityLandmark(raw.landmark, 'landmark');
  if (raw.landmarks !== undefined) {
    requireValue(Array.isArray(raw.landmarks) && raw.landmarks.length >= 1 && raw.landmarks.length <= 20, 'landmarks');
    for (const landmark of raw.landmarks) validateCityLandmark(landmark, 'landmarks entry');
  }
  if (raw.water !== undefined) {
    requireValue(object(raw.water) && Array.isArray(raw.water.rings) && raw.water.rings.length >= 1 && raw.water.rings.length <= 20, 'water');
    for (const ring of raw.water.rings) {
      requireValue(Array.isArray(ring) && ring.length >= 3 && ring.length <= 5000 && ring.every(p => vector(p, 2, 5000)), 'water ring');
    }
    if (raw.water.level !== undefined) {
      requireValue(typeof raw.water.level === 'number' && Number.isFinite(raw.water.level) && raw.water.level >= -5 && raw.water.level <= 5, 'water level');
    }
  }
  requireValue(optionalText(raw.note, 200), 'note');
  requireValue(Array.isArray(raw.attribution) && raw.attribution.length > 0, 'attribution');
  for (const entry of raw.attribution) {
    requireValue(object(entry) && typeof entry.label === 'string' && typeof entry.url === 'string', 'attribution entry');
    const url = new URL(entry.url);
    requireValue(url.protocol === 'https:' && !url.username && !url.password, 'attribution URL');
  }
  return raw as unknown as CityData;
}
