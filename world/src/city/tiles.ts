/**
 * 城市瓦片流式加载（1km compact-JSON 瓦片 / LOD0·LOD1 / 碰撞环 / 动态地面）。
 *
 * 契约（字段与语义）在 `docs/world/瓦片格式-v2.md` 的 v3 修订：默认瓦片是
 * **compact JSON + 运行时建几何**，不是烘焙 `.bin`。
 *
 * 为什么 v3 换掉 baked `.bin`（Lead 2026-11-21 实测）：
 * 5×5（12,194 栋）烘焙 LOD0 总 56.1MB（单片 median 1.78MB / max 3.8MB），
 * 同数据 compact JSON 只有 3.24MB（median 113KB / max 251KB）。按这个比例
 * 20 万栋 baked 会到 ~900MB、compact 约 54MB —— 只有 compact 能扩到全深圳。
 * 代价是每片要现建几何（~3k 栋/片），所以仍然保留"每帧 1–2 片 / ≤8ms"的预算。
 *
 * 两条硬规则（越界会出事，别为了"看起来对"绕过）：
 * 1. 渲染与碰撞同源：碰撞直接复用 LOD0 `BufferGeometry` 的 position/index（`colliderArrays`）。
 * 2. 地面碰撞块 **≤128m**：不给全城铺地面，只维护跟随玩家的 5×5 个 128m 块
 *    （`DynamicGround`）；2km 宽的薄地板会让角色脚底下沉（见 city/README §物理硬约束）。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Rapier } from '../physics/bake';
import { interactionGroups } from '../physics/layers';
import {
  parseCityData, type CityBuilding, type CityData, type CityLandmark, type CityRoad,
  type CityStreet, type CityWater, type Point2,
} from './data';
import { colliderArrays, emptyGeometry, facadeChunks, landmarkProfiles, roadGeometry, roofGeometry, sidewalkGeometry } from './geometry';
import { TILE_TINT_RGB, facadeTint, type FacadeStyle, type FacadeTint } from './materials';

// ───────────────────────────── 预算与阈值 ─────────────────────────────

/** 瓦片边长（米）。密集区将来可切 500m 子片，本版固定 1km。 */
export const TILE_SIZE = 1000;
/** LOD0 全立面半径。 */
export const LOD0_DISTANCE = 600;
/** LOD1 盒子半径；600–1500 用盒子。 */
export const LOD1_DISTANCE = 1500;
/** 超过这个距离立即卸载（1500–2000 只保留已加载的片，不再新加载）。 */
export const UNLOAD_DISTANCE = 2000;
/** 只有这个半径内的瓦片才 bakeTrimesh（渲染距离仍是 600m）。 */
export const COLLISION_DISTANCE = 250;
/** 每渲染帧最多推进几片（load/upgrade/downgrade/collide 各算一片）。 */
export const MAX_OPS_PER_FRAME = 2;
/** 每帧瓦片操作的同步预算（毫秒）。 */
export const FRAME_BUDGET_MS = 8;

/** 动态地面块边长（米）——物理硬规则：地面碰撞块最大 128m。 */
export const GROUND_BLOCK_SIZE = 128;
/** 5×5 = 半径 2。 */
export const GROUND_RADIUS = 2;

/** 三个立面样式，顺序固定。 */
export const FACADE_STYLES: readonly FacadeStyle[] = ['glass', 'office', 'stone'];

// ───────────────────────────── index.json（v3） ─────────────────────────────

export interface CityTileCounts {
  buildings: number;
  roads: number;
}

export interface CityTileDef {
  id: string;
  bounds: [number, number, number, number];
  /** 相对 `index.json` 所在目录，例如 `tiles/0_0.json`。 */
  file: string;
  counts?: CityTileCounts;
}

/** `landmarks[]` / `landmark` 条目；`rings` 是真实轮廓（给 main.ts 算出生朝向）。 */
export interface CityIndexLandmark extends CityLandmark {
  rings?: Point2[][];
}

export interface CityTileIndex {
  version: 3;
  scene: string;
  tileSize: number;
  bounds: [number, number, number, number];
  origin: Point2;
  spawn: [number, number, number];
  name: string;
  note?: string;
  attribution: { label: string; url: string }[];
  landmark?: CityIndexLandmark;
  landmarks?: CityIndexLandmark[];
  water?: CityWater;
  street?: CityStreet;
  counts?: CityTileCounts;
  tiles: CityTileDef[];
}

/** 单片 JSON 的内容：只放**按片**的数据；street/water/landmarks 在 index 里全局一份。 */
export interface CityTilePayload {
  buildings: CityBuilding[];
  roads: CityRoad[];
}

// ───────────────────────────── 校验 ─────────────────────────────

function fail(field: string): never {
  throw new Error(`瓦片索引不合法：${field}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function vector(value: unknown, size: number, limit = 1e6): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(v => finite(v) && Math.abs(v) <= limit);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** 瓦片文件只允许 `tiles/<name>.json`，挡住 `../` / 绝对路径 / 协议。 */
function validTileFile(file: unknown): file is string {
  return typeof file === 'string' && /^tiles\/[A-Za-z0-9_.-]+\.json$/.test(file) && !file.includes('..');
}

function validateLandmark(value: unknown, field: string): asserts value is CityIndexLandmark {
  if (!object(value) || typeof value.id !== 'string' || value.id.length > 120 ||
    typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80 ||
    !finite(value.height) || value.height <= 0 || value.height > 1000) fail(field);
  if (!Array.isArray(value.profile) || value.profile.length < 2 || value.profile.length > 100) fail(`${field} profile`);
  for (const point of value.profile) {
    if (!Array.isArray(point) || point.length !== 2 || !finite(point[0]) || !finite(point[1])) fail(`${field} profile point`);
  }
  if (value.rings !== undefined) {
    if (!Array.isArray(value.rings) || value.rings.length === 0 || value.rings.length > 100) fail(`${field} rings`);
    for (const ring of value.rings) {
      if (!Array.isArray(ring) || ring.length < 3 || !ring.every(point => vector(point, 2, 1e6))) fail(`${field} ring`);
    }
  }
}

/**
 * 解析并校验 `assets/city/<scene>/index.json`（v3：compact JSON 瓦片）。
 *
 * 故意不复用 `parseCityData`：索引没有逐楼清单（那正是瓦片存在的原因），
 * 但有 `tiles[]` 与 `counts`。共用校验只会逼着索引塞一份假 buildings。
 */
export function parseCityIndex(raw: unknown): CityTileIndex {
  if (!object(raw)) fail('root');
  if (raw.version !== 3) fail('version 必须为 3（compact JSON 瓦片）');
  if (typeof raw.scene !== 'string' || raw.scene.length === 0 || raw.scene.length > 40) fail('scene');
  if (!finite(raw.tileSize) || raw.tileSize <= 0 || raw.tileSize > 5000) fail('tileSize');
  if (!vector(raw.bounds, 4)) fail('bounds');
  if (raw.bounds[0]! >= raw.bounds[2]! || raw.bounds[1]! >= raw.bounds[3]!) fail('bounds order');
  if (!vector(raw.origin, 2, 180)) fail('origin');
  if (!vector(raw.spawn, 3) || raw.spawn[1]! < 0 || raw.spawn[1]! > 5) fail('spawn');
  if (raw.spawn[0]! <= raw.bounds[0]! || raw.spawn[0]! >= raw.bounds[2]! ||
    raw.spawn[2]! <= raw.bounds[1]! || raw.spawn[2]! >= raw.bounds[3]!) fail('spawn bounds');
  if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 80) fail('name');
  if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > 200)) fail('note');
  if (!Array.isArray(raw.attribution) || raw.attribution.length === 0) fail('attribution');
  for (const entry of raw.attribution) {
    if (!object(entry) || typeof entry.label !== 'string' || typeof entry.url !== 'string') fail('attribution entry');
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.username || url.password) fail('attribution URL');
  }
  if (raw.landmark !== undefined) validateLandmark(raw.landmark, 'landmark');
  if (raw.landmarks !== undefined) {
    if (!Array.isArray(raw.landmarks) || raw.landmarks.length === 0 || raw.landmarks.length > 20) fail('landmarks');
    for (const landmark of raw.landmarks) validateLandmark(landmark, 'landmarks entry');
  }
  if (raw.water !== undefined) {
    if (!object(raw.water) || !Array.isArray(raw.water.rings) || raw.water.rings.length === 0 || raw.water.rings.length > 20) fail('water');
    for (const ring of raw.water.rings) {
      if (!Array.isArray(ring) || ring.length < 3 || !ring.every(point => vector(point, 2, 1e6))) fail('water ring');
    }
    if (raw.water.level !== undefined && (!finite(raw.water.level) || raw.water.level < -5 || raw.water.level > 5)) fail('water level');
  }
  if (raw.street !== undefined) {
    const street = raw.street;
    if (!object(street) || !finite(street.pavingHeight) || street.pavingHeight <= 0 || street.pavingHeight > 0.3) fail('street');
    if (!Array.isArray(street.paving) || street.paving.length > 100) fail('street paving');
    for (const polygon of street.paving) {
      if (!Array.isArray(polygon) || polygon.length === 0) fail('paving polygon');
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 3 || !ring.every(point => vector(point, 2, 1e6))) fail('paving ring');
      }
    }
    if (!Array.isArray(street.placements) || street.placements.length > 500) fail('street placements');
    for (const placement of street.placements) {
      if (!object(placement) || !['tree', 'lamp', 'bench', 'sign'].includes(String(placement.kind)) ||
        !vector([placement.x, placement.z, placement.yaw], 3) || placement.yaw !== 0) fail('street placement');
    }
  }
  if (raw.counts !== undefined) {
    if (!object(raw.counts) || !nonNegativeInteger(raw.counts.buildings) || !nonNegativeInteger(raw.counts.roads)) fail('counts');
  }
  if (!Array.isArray(raw.tiles) || raw.tiles.length === 0 || raw.tiles.length > 20000) fail('tiles');
  const ids = new Set<string>();
  for (const tile of raw.tiles) {
    if (!object(tile) || typeof tile.id !== 'string' || !/^\d+_\d+$/.test(tile.id)) fail('tile id');
    if (ids.has(tile.id)) fail(`重复瓦片 ${tile.id}`);
    ids.add(tile.id);
    if (!vector(tile.bounds, 4)) fail(`tile ${tile.id} bounds`);
    if (tile.bounds[0]! >= tile.bounds[2]! || tile.bounds[1]! >= tile.bounds[3]!) fail(`tile ${tile.id} bounds order`);
    if (!validTileFile(tile.file)) fail(`tile ${tile.id} file`);
    if (tile.counts !== undefined) {
      if (!object(tile.counts) || !nonNegativeInteger(tile.counts.buildings) || !nonNegativeInteger(tile.counts.roads)) {
        fail(`tile ${tile.id} counts`);
      }
    }
  }
  return raw as unknown as CityTileIndex;
}

/**
 * 单片 payload → 带全局字段的 `CityData`。
 *
 * 为什么要包一层：`facadeChunks` / `roadGeometry` / 地标收分都吃 `CityData`，
 * 而 data.ts 的 `parseCityData` 就是"瓦片里每栋楼/每段路合法不合法"的既有校验器。
 * 用它而不是再写一份 building/road 校验，能保证单 JSON 与瓦片两条路径的边界一致。
 */
export function tileCityData(index: CityTileIndex, tile: CityTileDef, payload: CityTilePayload): CityData {
  const [x0, z0, x1, z1] = tile.bounds;
  const inside = (value: number, min: number, max: number): number => Math.min(Math.max(value, min + 0.01), max - 0.01);
  const street: CityStreet = index.street ?? { pavingHeight: 0.12, paving: [], placements: [] };
  return {
    version: 1,
    name: index.name,
    origin: index.origin,
    bounds: [x0, z0, x1, z1],
    spawn: [inside(index.spawn[0], x0, x1), 0, inside(index.spawn[2], z0, z1)],
    buildings: payload.buildings,
    roads: payload.roads,
    street,
    attribution: index.attribution,
    ...(index.landmark ? { landmark: shallowLandmark(index.landmark) } : {}),
    ...(index.landmarks ? { landmarks: index.landmarks.map(shallowLandmark) } : {}),
    ...(index.water ? { water: index.water } : {}),
    ...(index.note ? { note: index.note } : {}),
  };
}

/** 空瓦片校验占位（不参与渲染/统计）；见 `parseCityTile`。 */
function emptyTileMarker(tile: CityTileDef): CityBuilding {
  const [x0, z0] = tile.bounds;
  return {
    id: `__empty_tile__${tile.id}`, height: 1, heightSource: 'estimate',
    rings: [[[x0, z0], [x0 + 1, z0], [x0 + 1, z0 + 1], [x0, z0 + 1]]],
  };
}

function shallowLandmark(landmark: CityIndexLandmark): CityLandmark {
  return { id: landmark.id, name: landmark.name, height: landmark.height, profile: landmark.profile };
}

/**
 * 校验单片 JSON 并返回 payload。
 *
 * `counts` 是烘焙器的自检：索引说这片有 N 栋，payload 就必须正好 N 栋 ——
 * 少/多都说明切瓦片时丢楼或重复归属，直接报错比"画面少几栋"更容易定位。
 */
export function parseCityTile(raw: unknown, index: CityTileIndex, tile: CityTileDef): CityTilePayload {
  if (!object(raw) || !Array.isArray(raw.buildings) || !Array.isArray(raw.roads)) {
    throw new Error(`瓦片内容不合法：${tile.file}（需要 buildings[] / roads[]）`);
  }
  const payload: CityTilePayload = { buildings: raw.buildings as CityBuilding[], roads: raw.roads as CityRoad[] };
  try {
    const data = tileCityData(index, tile, payload);
    // 海面/空地瓦片可以 0 栋楼；但 data.ts 的 schema 要求 buildings 非空。
    // 校验时塞一个 1m 占位块（只用于校验，不进 payload/不进渲染）。
    if (!data.buildings.length) data.buildings = [emptyTileMarker(tile)];
    parseCityData(data);
  } catch (error) {
    throw new Error(`瓦片内容不合法：${tile.file}`, { cause: error });
  }
  if (tile.counts) {
    if (payload.buildings.length !== tile.counts.buildings || payload.roads.length !== tile.counts.roads) {
      throw new Error(
        `瓦片数量与索引不符：${tile.id} 期望 ${tile.counts.buildings} 栋/${tile.counts.roads} 路，` +
        `收到 ${payload.buildings.length} 栋/${payload.roads.length} 路`,
      );
    }
  }
  return payload;
}

// ───────────────────────────── 加载器（index → 预取） ─────────────────────────────

export interface TileLoadSource {
  /** 取 JSON（浏览器里是 fetch().json()，测试里可以是内存表/文件）。 */
  loadJson(url: string): Promise<unknown>;
  /** `index.json` 的完整 URL（tile.file 以它为基准）。 */
  baseUrl: string;
}

/** 供 `loadCity` 使用：fetch 一个 JSON，非 2xx 带 URL 抛错。 */
export async function fetchTileJson(url: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`瓦片数据加载失败（HTTP ${response.status}）：${url}`);
  return response.json();
}

/** 出生前同步预取 3×3 片（JSON + 校验）；mount 里 `warmup()` 再同步建几何。 */
export async function prefetchSpawnTiles(index: CityTileIndex, source: TileLoadSource): Promise<Map<string, CityTilePayload>> {
  const entries = await Promise.all(spawnTileIds(index).map(async id => {
    const def = index.tiles.find(tile => tile.id === id)!;
    try {
      const raw = await source.loadJson(new URL(def.file, source.baseUrl).href);
      return [id, parseCityTile(raw, index, def)] as const;
    } catch (error) {
      throw new Error(`出生瓦片加载失败（${index.scene}/${id}）`, { cause: error });
    }
  }));
  return new Map(entries);
}

// ───────────────────────────── 纯决策函数 ─────────────────────────────

/** 玩家到瓦片 AABB 的最近距离（米）；在片内为 0。 */
export function tileDistanceTo(px: number, pz: number, bounds: readonly [number, number, number, number]): number {
  const dx = Math.max(bounds[0] - px, 0, px - bounds[2]);
  const dz = Math.max(bounds[1] - pz, 0, pz - bounds[3]);
  return Math.hypot(dx, dz);
}

/** 距离 → 目标 LOD；`keep` = 只保留已加载的片，不再新加载。 */
export type TileTarget = 'lod0' | 'lod1' | 'keep' | 'unload';

export function targetLod(
  distance: number,
  lod0 = LOD0_DISTANCE,
  lod1 = LOD1_DISTANCE,
  unload = UNLOAD_DISTANCE,
): TileTarget {
  if (distance > unload) return 'unload';
  if (distance <= lod0) return 'lod0';
  if (distance <= lod1) return 'lod1';
  return 'keep';
}

export function tileIdFor(ix: number, iz: number): string {
  return `${ix}_${iz}`;
}

/** 某点所在瓦片 id；点不在 `bounds` 内或没有该片时返回 null。 */
export function tileIdAt(index: CityTileIndex, x: number, z: number): string | null {
  if (x < index.bounds[0] || x > index.bounds[2] || z < index.bounds[1] || z > index.bounds[3]) return null;
  const id = tileIdFor(
    Math.floor((x - index.bounds[0]) / index.tileSize),
    Math.floor((z - index.bounds[1]) / index.tileSize),
  );
  return index.tiles.some(tile => tile.id === id) ? id : null;
}

/** 出生点 3×3 的瓦片 id（中心片优先，其余按到出生点距离排序）。 */
export function spawnTileIds(index: CityTileIndex): string[] {
  const [x, , z] = index.spawn;
  const centerX = Math.floor((x - index.bounds[0]) / index.tileSize);
  const centerZ = Math.floor((z - index.bounds[1]) / index.tileSize);
  const present = new Set(index.tiles.map(tile => tile.id));
  const ids: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const id = tileIdFor(centerX + dx, centerZ + dz);
      if (present.has(id)) ids.push(id);
    }
  }
  const distance = (id: string): number => {
    const tile = index.tiles.find(entry => entry.id === id)!;
    const cx = (tile.bounds[0] + tile.bounds[2]) / 2, cz = (tile.bounds[1] + tile.bounds[3]) / 2;
    return Math.hypot(cx - x, cz - z);
  };
  return ids.sort((a, b) => distance(a) - distance(b));
}

// ───────────────────────────── LOD1 盒子 ─────────────────────────────

/** 每栋楼一个盒子的 LOD1（12 三角形/栋），顶点色写 tint，不采样立面 atlas。 */
export function lod1Geometry(buildings: readonly CityBuilding[]): THREE.BufferGeometry {
  if (!buildings.length) return emptyGeometry();
  const parts: THREE.BufferGeometry[] = [];
  for (const building of buildings) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const ring of building.rings) {
      for (const [x, z] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) continue;
    const width = Math.max(0.6, maxX - minX), depth = Math.max(0.6, maxZ - minZ);
    const geometry = new THREE.BoxGeometry(width, building.height, depth);
    geometry.translate((minX + maxX) / 2, building.height / 2, (minZ + maxZ) / 2);
    const tint = TILE_TINT_RGB[facadeTint(building.id)];
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set(tint, i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  }
  if (!parts.length) return emptyGeometry();
  const merged = mergeGeometries(parts, false);
  parts.forEach(part => part.dispose());
  if (!merged) return emptyGeometry();
  merged.computeBoundingSphere();
  return merged;
}

function hasVertices(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  return position !== undefined && position.count > 0;
}

// ───────────────────────────── 流式加载器 ─────────────────────────────

/** 流式加载需要的材质（由 `CityScene` 按 surfaces 建好并登记到销毁路径）。 */
export interface TileMaterialSet {
  /** 立面按 样式 × 色调 复用单 JSON 路径的同一批材质（9 个）。 */
  facade: Record<FacadeStyle, Record<FacadeTint, THREE.Material>>;
  lod1: THREE.Material;
  roads: THREE.Material;
  walkways: THREE.Material;
  sidewalks: THREE.Material;
  /**
   * LOD0 屋顶细节（女儿墙 + 设备盒），跨片共享一个材质。
   *
   * **只有 LOD0 片会用它**：LOD1 是 600m 外的盒子，加屋顶只是浪费三角形。
   * 这个材质/几何都不进 `colliderArrays()`——屋顶细节不参与碰撞。
   */
  roofs: THREE.Material;
}

/** 碰撞适配器：生产环境是 Rapier，测试里可以是记录器。 */
export interface TileCollisionAdapter {
  bake(vertices: Float32Array, indices: Uint32Array): unknown;
  remove(handle: unknown): void;
}

export interface TileStreamerOptions {
  index: CityTileIndex;
  group: THREE.Group;
  materials: TileMaterialSet;
  /** 按完整 URL 取 JSON。 */
  loadJson(url: string): Promise<unknown>;
  /** `index.json` 的完整 URL。 */
  baseUrl: string;
  collision?: TileCollisionAdapter;
  preloaded?: ReadonlyMap<string, CityTilePayload>;
  now?: () => number;
  maxOpsPerFrame?: number;
  budgetMs?: number;
  lod0Distance?: number;
  lod1Distance?: number;
  unloadDistance?: number;
  collisionDistance?: number;
}

export interface TileStats {
  tilesLoaded: number;
  lod0: number;
  lod1: number;
  collisionTiles: number;
  loadsLastFrame: number;
  msLastFrame: number;
}

export type TileOperationKind = 'collide' | 'load' | 'upgrade' | 'downgrade';

export interface TileOperation {
  kind: TileOperationKind;
  id: string;
  /** load 时的目标 LOD；其它操作为当前/目标推断值。 */
  lod: 'lod0' | 'lod1';
  /** 越小越先做：已加载片补碰撞 → 视锥内 → 距离近 → 降级。 */
  priority: number;
  visible: boolean;
}

interface TileRecord {
  def: CityTileDef;
  distance: number;
  lod: 'lod0' | 'lod1' | null;
  /** 已加载的原始 JSON：升降 LOD 不重新下载（compact 片最大 251KB）。 */
  payload: CityTilePayload | null;
  group: THREE.Group | null;
  lod0Geometries: THREE.BufferGeometry[];
  lod0Meshes: THREE.Mesh[];
  /** LOD0 屋顶细节（不碰撞、不 bake）；降级到 LOD1 时一起删。 */
  roofGeometry: THREE.BufferGeometry | null;
  roofMesh: THREE.Mesh | null;
  lod1Geometry: THREE.BufferGeometry | null;
  lod1Mesh: THREE.Mesh | null;
  roads: THREE.BufferGeometry[];
  roadMeshes: THREE.Mesh[];
  allGeometries: THREE.BufferGeometry[];
  colliders: unknown[];
  busy: boolean;
  failures: number;
  disabled: boolean;
}

/** 视锥内的片优先这么多米：保证"先加载眼前能看见的"不被身后更近的片挤掉。 */
const FRUSTUM_PRIORITY_BONUS = 2000;
/** 连续失败几次后停用该片，避免坏文件每帧重试。 */
const MAX_TILE_FAILURES = 3;

function emptyRecord(def: CityTileDef, distance: number): TileRecord {
  return {
    def, distance, lod: null, payload: null, group: null,
    lod0Geometries: [], lod0Meshes: [], roofGeometry: null, roofMesh: null, lod1Geometry: null, lod1Mesh: null,
    roads: [], roadMeshes: [], allGeometries: [], colliders: [], busy: false, failures: 0, disabled: false,
  };
}

export class TileStreamer {
  readonly index: CityTileIndex;
  private readonly group: THREE.Group;
  private readonly materials: TileMaterialSet;
  private readonly loadJson: (url: string) => Promise<unknown>;
  private readonly baseUrl: string;
  private readonly collision: TileCollisionAdapter | undefined;
  private readonly preloaded: ReadonlyMap<string, CityTilePayload>;
  private readonly now: () => number;
  private readonly maxOpsPerFrame: number;
  private readonly budgetMs: number;
  private readonly lod0Distance: number;
  private readonly lod1Distance: number;
  private readonly unloadDistance: number;
  private readonly collisionDistance: number;

  private readonly byId = new Map<string, CityTileDef>();
  private readonly records = new Map<string, TileRecord>();
  private readonly boxes = new Map<string, THREE.Box3>();
  private readonly frustum = new THREE.Frustum();
  private readonly viewMatrix = new THREE.Matrix4();
  private playerX = 0;
  private playerZ = 0;
  private hasFrustum = false;
  private runningPromise: Promise<void> | null = null;
  private dirty = false;
  private loadsLastFrame = 0;
  private msLastFrame = 0;
  private disposed = false;

  constructor(options: TileStreamerOptions) {
    this.index = options.index;
    this.group = options.group;
    this.materials = options.materials;
    this.loadJson = options.loadJson;
    this.baseUrl = options.baseUrl;
    this.collision = options.collision;
    this.preloaded = options.preloaded ?? new Map();
    this.now = options.now ?? (() => performance.now());
    this.maxOpsPerFrame = options.maxOpsPerFrame ?? MAX_OPS_PER_FRAME;
    this.budgetMs = options.budgetMs ?? FRAME_BUDGET_MS;
    this.lod0Distance = options.lod0Distance ?? LOD0_DISTANCE;
    this.lod1Distance = options.lod1Distance ?? LOD1_DISTANCE;
    this.unloadDistance = options.unloadDistance ?? UNLOAD_DISTANCE;
    this.collisionDistance = options.collisionDistance ?? COLLISION_DISTANCE;
    for (const tile of options.index.tiles) this.byId.set(tile.id, tile);
    this.playerX = options.index.spawn[0];
    this.playerZ = options.index.spawn[2];
  }

  /** 出生装配：把 `loadCity` 预取好的 3×3 LOD0 同步挂上（LOD0 几何在这里建）。 */
  warmup(ids: readonly string[] = spawnTileIds(this.index)): number {
    let loaded = 0;
    for (const id of ids) {
      const def = this.byId.get(id);
      const payload = this.preloaded.get(id);
      if (!def || !payload || this.records.has(id)) continue;
      const record = this.ensureRecord(def);
      record.payload = payload;
      try {
        this.buildLod0(record, payload);
        loaded += 1;
      } catch (error) {
        console.error('[tiles] 出生瓦片装配失败', id, error);
        this.unload(id);
        continue;
      }
      record.distance = tileDistanceTo(this.playerX, this.playerZ, def.bounds);
      if (record.distance <= this.collisionDistance) this.bakeCollision(record);
    }
    return loaded;
  }

  /**
   * 每帧调用：重算距离、立即卸载 >2000m、移出碰撞环 >250m，然后按预算推进 2 片。
   *
   * 卸载与碰撞移除是**立即**的（代价小且不做会让玩家撞到已看不见的墙）；
   * 加载/建几何/升降 LOD/建碰撞才进 2 片 / 8ms 预算。
   */
  update(playerX: number, playerZ: number, camera?: THREE.PerspectiveCamera | null): void {
    if (this.disposed) return;
    this.playerX = playerX;
    this.playerZ = playerZ;
    this.hasFrustum = Boolean(camera);
    if (camera) {
      // three 的 renderer 每帧都会更新这两个矩阵；city.update 在 render 之前跑，
      // 这里自己刷一次，避免用上一帧的视图矩阵做优先级（不影响渲染结果）。
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      this.viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.viewMatrix);
    }
    for (const [id, record] of this.records) {
      const distance = tileDistanceTo(playerX, playerZ, record.def.bounds);
      record.distance = distance;
      if (!record.busy && distance > this.unloadDistance) {
        this.unload(id);
        continue;
      }
      if (!record.busy && record.lod === 'lod0' && record.colliders.length && distance > this.collisionDistance) {
        this.removeCollision(record);
      }
    }
    this.dirty = true;
    void this.runFrame(this.maxOpsPerFrame, this.budgetMs);
  }

  /** 生产环境的"一帧"入口；测试可直接 `await stepFrame(n, budget)`。 */
  async stepFrame(maxOps = this.maxOpsPerFrame, budgetMs = this.budgetMs): Promise<void> {
    await this.runFrame(maxOps, budgetMs);
  }

  /** 测试/预热用：不受 2 片 / 8ms 限制，一直推进到没有待办。 */
  async settle(maxRounds = 64): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      await this.runFrame(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (this.planOperations().length === 0) return;
    }
  }

  /** 只为调试：当前排序后的待办（不执行）。 */
  planOperations(): TileOperation[] {
    if (this.disposed) return [];
    const operations: TileOperation[] = [];
    for (const def of this.byId.values()) {
      const record = this.records.get(def.id);
      if (record?.busy || record?.disabled) continue;
      const distance = tileDistanceTo(this.playerX, this.playerZ, def.bounds);
      const visible = this.isVisible(def);
      const priority = distance - (visible ? FRUSTUM_PRIORITY_BONUS : 0);
      // 没有碰撞适配器（单测/无物理模式）就不产生 collide 待办，否则会白占 2 片预算。
      if (this.collision && record?.lod === 'lod0' && record.colliders.length === 0 && distance <= this.collisionDistance) {
        operations.push({ kind: 'collide', id: def.id, lod: 'lod0', priority, visible });
      }
      const target = targetLod(distance, this.lod0Distance, this.lod1Distance, this.unloadDistance);
      if (!record || !record.lod) {
        if (target === 'lod0' || target === 'lod1') {
          operations.push({ kind: 'load', id: def.id, lod: target, priority, visible });
        }
      } else if (target === 'lod0' && record.lod === 'lod1') {
        operations.push({ kind: 'upgrade', id: def.id, lod: 'lod0', priority, visible });
      } else if (target !== 'lod0' && record.lod === 'lod0') {
        operations.push({ kind: 'downgrade', id: def.id, lod: 'lod1', priority, visible });
      }
    }
    const rank = (kind: TileOperationKind): number => (kind === 'collide' ? 0 : kind === 'downgrade' ? 2 : 1);
    operations.sort((a, b) => rank(a.kind) - rank(b.kind) || a.priority - b.priority);
    return operations;
  }

  stats(): TileStats {
    let lod0 = 0, lod1 = 0, collisionTiles = 0;
    for (const record of this.records.values()) {
      if (record.lod === 'lod0') lod0 += 1;
      else if (record.lod === 'lod1') lod1 += 1;
      if (record.colliders.length) collisionTiles += 1;
    }
    return {
      tilesLoaded: lod0 + lod1,
      lod0, lod1, collisionTiles,
      loadsLastFrame: this.loadsLastFrame,
      msLastFrame: Math.round(this.msLastFrame * 100) / 100,
    };
  }

  /** 某片当前 LOD（测试用；未加载为 null）。 */
  lodOf(id: string): 'lod0' | 'lod1' | null {
    return this.records.get(id)?.lod ?? null;
  }

  /** 当前已加载的片 id（统计/验收脚本用）。 */
  loadedTileIds(): string[] {
    return [...this.records.entries()].filter(([, record]) => record.lod !== null).map(([id]) => id);
  }

  /**
   * 诊断/测试用：某片当前 LOD0 的**渲染几何**。
   * 碰撞直接取自这些数组（`colliderArrays`），测试据此断言"渲染 == 碰撞"。
   */
  debugLod0Geometries(id: string): THREE.BufferGeometry[] {
    return this.records.get(id)?.lod0Geometries.slice() ?? [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.records.keys()]) this.unload(id);
    this.records.clear();
  }

  // ───────────────────────── 内部：装配 ─────────────────────────

  private ensureRecord(def: CityTileDef): TileRecord {
    const existing = this.records.get(def.id);
    if (existing) return existing;
    const record = emptyRecord(def, tileDistanceTo(this.playerX, this.playerZ, def.bounds));
    this.records.set(def.id, record);
    return record;
  }

  private ensureGroup(record: TileRecord): THREE.Group {
    if (record.group) return record.group;
    const group = new THREE.Group();
    group.name = `tile-${record.def.id}`;
    record.group = group;
    this.group.add(group);
    return group;
  }

  /** LOD0：复用单 JSON 路径的 `facadeChunks`（样式 × 色调分桶，最多 9 批）。 */
  private buildLod0(record: TileRecord, payload: CityTilePayload): void {
    const data = tileCityData(this.index, record.def, payload);
    const group = this.ensureGroup(record);
    for (const [index, chunk] of facadeChunks(data).entries()) {
      if (!hasVertices(chunk.geometry)) { chunk.geometry.dispose(); continue; }
      const mesh = new THREE.Mesh(chunk.geometry, this.materials.facade[chunk.style][chunk.tint]);
      mesh.name = `tile-${record.def.id}-lod0-${chunk.style}-${chunk.tint}-${index}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      record.lod0Geometries.push(chunk.geometry);
      record.lod0Meshes.push(mesh);
      record.allGeometries.push(chunk.geometry);
    }
    record.lod = 'lod0';
    this.buildRoofs(record, data);
    this.buildRoads(record, payload);
  }

  /**
   * 每片一个 `city-roofs`：女儿墙 + 屋顶设备盒（>60m 的楼）。
   *
   * 为什么单独一个 mesh、不并进立面批次：立面几何是**碰撞源**（`bakeCollision`
   * 直接遍历 `lod0Geometries`），屋顶并进去就会让玩家在楼顶撞到 0.6m 的女儿墙；
   * 反过来，它单独挂在 `record.allGeometries` 里，卸载/降级的销毁路径照样覆盖。
   */
  private buildRoofs(record: TileRecord, data: CityData): void {
    const geometry = roofGeometry(data.buildings, landmarkProfiles(data));
    if (!hasVertices(geometry)) { geometry.dispose(); return; }
    const mesh = new THREE.Mesh(geometry, this.materials.roofs);
    mesh.name = `tile-${record.def.id}-roofs`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.ensureGroup(record).add(mesh);
    record.roofGeometry = geometry;
    record.roofMesh = mesh;
    record.allGeometries.push(geometry);
  }

  /** LOD1：每栋一个盒子（12 三角），不采样 atlas。 */
  private buildLod1(record: TileRecord, payload: CityTilePayload): void {
    const group = this.ensureGroup(record);
    const geometry = lod1Geometry(payload.buildings);
    if (hasVertices(geometry)) {
      const mesh = new THREE.Mesh(geometry, this.materials.lod1);
      mesh.name = `tile-${record.def.id}-lod1`;
      // LOD1 只在 600m 外出现，远到不会被 90m 的阴影相机覆盖：不投影省一遍绘制。
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
      record.lod1Geometry = geometry;
      record.lod1Mesh = mesh;
      record.allGeometries.push(geometry);
    } else {
      geometry.dispose();
    }
    record.lod = 'lod1';
    this.buildRoads(record, payload);
  }

  /** 道路 / 步道 / 人行道：随 LOD 保留（换 LOD 不重下、不重建）。 */
  private buildRoads(record: TileRecord, payload: CityTilePayload): void {
    if (record.roads.length || !payload.roads.length) return;
    const group = this.ensureGroup(record);
    const roads = payload.roads.filter(road => !road.walkway);
    const walkways = payload.roads.filter(road => road.walkway);
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string): void => {
      if (!hasVertices(geometry)) { geometry.dispose(); return; }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `tile-${record.def.id}-${name}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
      record.roads.push(geometry);
      record.roadMeshes.push(mesh);
      record.allGeometries.push(geometry);
    };
    add(roadGeometry(roads), this.materials.roads, 'roads');
    add(roadGeometry(walkways), this.materials.walkways, 'walkways');
    add(sidewalkGeometry(payload.roads), this.materials.sidewalks, 'sidewalks');
  }

  private bakeCollision(record: TileRecord): void {
    if (!this.collision || record.colliders.length) return;
    for (const geometry of record.lod0Geometries) {
      // 与单 JSON 路径同一个 `colliderArrays()`：位置/索引直接取自渲染 geometry。
      const { vertices, indices } = colliderArrays(geometry);
      record.colliders.push(this.collision.bake(vertices, indices));
    }
  }

  private removeCollision(record: TileRecord): void {
    if (!this.collision) { record.colliders = []; return; }
    for (const handle of record.colliders) this.collision.remove(handle);
    record.colliders = [];
  }

  // ───────────────────────── 内部：预算 / 加载 / 升/降/卸 ─────────────────────────

  private async runFrame(maxOps: number, budgetMs: number): Promise<void> {
    if (this.disposed) return;
    if (this.runningPromise) { this.dirty = true; await this.runningPromise; return; }
    this.runningPromise = this.frameLoop(maxOps, budgetMs).finally(() => {
      this.runningPromise = null;
    });
    await this.runningPromise;
  }

  private async frameLoop(maxOps: number, budgetMs: number): Promise<void> {
    const started = this.now();
    let ops = 0;
    try {
      do {
        this.dirty = false;
        while (ops < maxOps && !this.disposed) {
          if (this.now() - started >= budgetMs) { this.dirty = true; break; }
          const operation = this.planOperations()[0];
          if (!operation) break;
          await this.apply(operation);
          ops += 1;
        }
      } while (this.dirty && ops < maxOps && !this.disposed && this.now() - started < budgetMs);
    } finally {
      this.loadsLastFrame = ops;
      this.msLastFrame = this.now() - started;
    }
  }

  private async apply(operation: TileOperation): Promise<void> {
    const def = this.byId.get(operation.id);
    if (!def) return;
    // 必须用 ensureRecord() 落进 records：否则新片建完几何后不在表里，
    // 下一帧 plan 还会再加载同一片（表现为"每帧 2 片但永远只有出生 9 片"）。
    const record = this.ensureRecord(def);
    record.busy = true;
    try {
      if (operation.kind === 'collide') {
        if (record.lod === 'lod0') this.bakeCollision(record);
        return;
      }
      let payload = record.payload;
      if (!payload) {
        const raw = await this.fetchGuarded(def, record);
        if (this.disposed || raw === null) return;
        payload = raw;
        record.payload = payload;
      }
      if (this.disposed) return;
      if (operation.kind === 'downgrade') {
        this.removeCollision(record);
        this.removeLod0(record);
        this.removeLod1(record);
        this.buildLod1(record, payload);
        return;
      }
      // load / upgrade：先拆另一个 LOD（同一条销毁路径），再建 LOD0。
      this.removeLod1(record);
      this.removeLod0(record);
      this.buildLod0(record, payload);
      record.failures = 0;
      if (record.distance <= this.collisionDistance) this.bakeCollision(record);
    } finally {
      record.busy = false;
    }
  }

  private async fetchGuarded(def: CityTileDef, record: TileRecord): Promise<CityTilePayload | null> {
    try {
      const raw = await this.loadJson(new URL(def.file, this.baseUrl).href);
      return parseCityTile(raw, this.index, def);
    } catch (error) {
      record.failures += 1;
      if (record.failures >= MAX_TILE_FAILURES) {
        record.disabled = true;
        console.error('[tiles] 瓦片连续加载失败，已停用', def.id, error);
      } else {
        console.warn('[tiles] 瓦片加载失败，下一帧重试', def.id, error);
      }
      return null;
    }
  }

  private removeLod0(record: TileRecord): void {
    for (const mesh of record.lod0Meshes) mesh.removeFromParent();
    for (const geometry of record.lod0Geometries) this.disposeGeometry(record, geometry);
    record.lod0Meshes = [];
    record.lod0Geometries = [];
    // 屋顶细节是 LOD0 的一部分：降级到 LOD1 时必须一起拆（LOD1 不建屋顶）。
    record.roofMesh?.removeFromParent();
    record.roofMesh = null;
    if (record.roofGeometry) {
      this.disposeGeometry(record, record.roofGeometry);
      record.roofGeometry = null;
    }
    if (record.lod === 'lod0') record.lod = null;
  }

  private removeLod1(record: TileRecord): void {
    record.lod1Mesh?.removeFromParent();
    record.lod1Mesh = null;
    if (record.lod1Geometry) {
      this.disposeGeometry(record, record.lod1Geometry);
      record.lod1Geometry = null;
    }
    if (record.lod === 'lod1') record.lod = null;
  }

  private disposeGeometry(record: TileRecord, geometry: THREE.BufferGeometry): void {
    const index = record.allGeometries.indexOf(geometry);
    if (index >= 0) record.allGeometries.splice(index, 1);
    geometry.dispose();
  }

  private unload(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.removeCollision(record);
    record.group?.removeFromParent();
    for (const geometry of record.allGeometries) geometry.dispose();
    record.allGeometries = [];
    record.lod0Geometries = [];
    record.lod0Meshes = [];
    record.roofGeometry = null;
    record.roofMesh = null;
    record.roads = [];
    record.roadMeshes = [];
    record.lod1Geometry = null;
    record.lod1Mesh = null;
    record.lod = null;
    record.payload = null;
    record.group = null;
    this.records.delete(id);
  }

  private isVisible(def: CityTileDef): boolean {
    if (!this.hasFrustum) return true;
    let box = this.boxes.get(def.id);
    if (!box) {
      box = new THREE.Box3(
        new THREE.Vector3(def.bounds[0], 0, def.bounds[1]),
        // 地标高 392.5m；留到 500m 保证春笋这类超高层不会被误判为不可见。
        new THREE.Vector3(def.bounds[2], 500, def.bounds[3]),
      );
      this.boxes.set(def.id, box);
    }
    return this.frustum.intersectsBox(box);
  }
}

// ───────────────────────────── 动态地面（5×5 × 128m） ─────────────────────────────

export interface GroundBlock {
  /** 块中心（米）。 */
  centerX: number;
  centerZ: number;
  /** 边长（米）；硬规则：≤128。 */
  size: number;
}

/**
 * 跟随玩家的 5×5 个 128m 碰撞地板（纯函数，便于断言"每块 ≤128m、无缝排列"）。
 *
 * 为什么不用"整城一块大地板"：2km 宽的薄 cuboid 在真实接触探针里让角色下沉约 22cm，
 * 法线修正/加厚/细分楼墙都无效（见 city/README §物理硬约束第 1 条）。
 */
export function groundBlocks(
  playerX: number,
  playerZ: number,
  size = GROUND_BLOCK_SIZE,
  radius = GROUND_RADIUS,
): GroundBlock[] {
  const cellX = Math.floor(playerX / size), cellZ = Math.floor(playerZ / size);
  const blocks: GroundBlock[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      blocks.push({ centerX: (cellX + dx + 0.5) * size, centerZ: (cellZ + dz + 0.5) * size, size });
    }
  }
  return blocks;
}

/**
 * 动态地面：25 个固定 cuboid，玩家跨 128m 网格时用 `setTranslation` 平移（不重建 collider）。
 *
 * 顶部 y=0 与单 JSON 路径的地面块一致（中心 -0.1、半高 0.1）。
 * 视觉地面由瓦片/全局平面负责，这里**只做碰撞**。
 */
export class DynamicGround {
  private readonly colliders: RAPIER_NS.Collider[] = [];
  private blocks: GroundBlock[] = [];
  private cellX = Number.NaN;
  private cellZ = Number.NaN;

  constructor(
    private readonly rapier: Rapier,
    private readonly world: RAPIER_NS.World,
    private readonly size = GROUND_BLOCK_SIZE,
    private readonly radius = GROUND_RADIUS,
  ) {}

  /** 首次安装（已安装则退化为 update）。 */
  install(playerX: number, playerZ: number): void {
    if (this.colliders.length) { this.update(playerX, playerZ); return; }
    this.blocks = groundBlocks(playerX, playerZ, this.size, this.radius);
    this.cellX = Math.floor(playerX / this.size);
    this.cellZ = Math.floor(playerZ / this.size);
    for (const block of this.blocks) {
      const desc = this.rapier.ColliderDesc.cuboid(block.size / 2, 0.1, block.size / 2)
        .setTranslation(block.centerX, -0.1, block.centerZ)
        .setCollisionGroups(interactionGroups('WORLD_STATIC'))
        // 与 physics/bake.ts 的静态几何同一组摩擦/弹性：地面"抓得住"但不粘脚。
        .setFriction(0.85)
        .setRestitution(0);
      this.colliders.push(this.world.createCollider(desc));
    }
  }

  /** 玩家跨 128m 网格时整体平移 25 块；未跨格返回 false（零成本）。 */
  update(playerX: number, playerZ: number): boolean {
    const cellX = Math.floor(playerX / this.size), cellZ = Math.floor(playerZ / this.size);
    if (cellX === this.cellX && cellZ === this.cellZ) return false;
    this.cellX = cellX;
    this.cellZ = cellZ;
    this.blocks = groundBlocks(playerX, playerZ, this.size, this.radius);
    for (let i = 0; i < this.colliders.length; i++) {
      const block = this.blocks[i];
      if (!block) break;
      this.colliders[i]!.setTranslation({ x: block.centerX, y: -0.1, z: block.centerZ });
    }
    return true;
  }

  /** 当前 25 块（测试断言 ≤128m / 排列无缝）。 */
  currentBlocks(): GroundBlock[] {
    return this.blocks;
  }

  get colliderCount(): number {
    return this.colliders.length;
  }

  dispose(): void {
    for (const collider of this.colliders) this.world.removeCollider(collider, false);
    this.colliders.length = 0;
    this.blocks = [];
  }
}
