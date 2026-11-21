/**
 * 瓦片流式加载的单测（不依赖 WebGL/DOM）。
 *
 * 默认瓦片是 **compact JSON + 运行时建几何**（Lead 2026-11-21 实测：5×5 12,194 栋
 * compact 3.24MB vs baked LOD0 56.1MB）。真实瓦片由烘焙线产出到
 * `assets/city/nanshan/`；**没产出时用合成 fixture 跑同一套加载/卸载/预算/回退断言，
 * 不允许 skip**。真实瓦片出现后，端到端用例自动改读真实 index + JSON 片。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PhysicsWorld } from '../physics/engine';
import { CharacterController } from '../physics/character';
import type { CityBuilding } from './data';
import { colliderArrays, facadeChunks } from './geometry';
import {
  DynamicGround, GROUND_BLOCK_SIZE, TileStreamer, groundBlocks, lod1Geometry, parseCityIndex,
  parseCityTile, prefetchSpawnTiles, spawnTileIds, targetLod, tileCityData, tileDistanceTo,
  type CityTileDef, type CityTileIndex, type CityTilePayload, type TileLoadSource, type TileMaterialSet,
} from './tiles';
import { cityInfoText, loadCity, type LoadCityOptions } from './runtime';
import type { SurfaceAssets } from './materials';

const FIXTURE_ORIGIN = 'http://fixture.test/';
const FIXTURE_INDEX_URL = `${FIXTURE_ORIGIN}assets/city/nanshan/index.json`;

// ───────────────────────────── 合成 fixture（手写 index + 小 JSON 片） ─────────────────────────────

interface Fixture {
  index: CityTileIndex;
  /** 相对 index 目录的路径 → 单片 JSON。 */
  files: Map<string, unknown>;
  source: TileLoadSource;
}

function tileBuildings(id: string, bounds: [number, number, number, number]): CityBuilding[] {
  const cx = (bounds[0] + bounds[2]) / 2, cz = (bounds[1] + bounds[3]) / 2;
  const block = (suffix: string, height: number, size: number): CityBuilding => ({
    id: `way/${id}-${suffix}`,
    height,
    heightSource: 'estimate',
    rings: [[[cx - size, cz - size], [cx + size, cz - size], [cx + size, cz + size], [cx - size, cz + size]]],
  });
  return [block('tower', 80, 35), block('mid', 40, 20), block('low', 12, 12)];
}

/** 6×6 = 36 片（bounds ±3000、1km 片），spawn 在 (250,250) → 3_3 片。 */
function makeFixture(): Fixture {
  const bounds: [number, number, number, number] = [-3000, -3000, 3000, 3000];
  const tileSize = 1000;
  const tiles: CityTileDef[] = [];
  const files = new Map<string, unknown>();
  for (let ix = 0; ix < 6; ix++) {
    for (let iz = 0; iz < 6; iz++) {
      const id = `${ix}_${iz}`;
      const x0 = bounds[0] + ix * tileSize, z0 = bounds[1] + iz * tileSize;
      const tileBounds: [number, number, number, number] = [x0, z0, x0 + tileSize, z0 + tileSize];
      const buildings = tileBuildings(id, tileBounds);
      const roads = [
        { id: `way/road-${id}`, width: 10, walkway: false, points: [[x0 + 50, z0 + 100], [x0 + 250, z0 + 100]] as [number, number][] },
      ];
      if (id === '3_3') {
        roads.push({ id: 'way/foot-3_3', width: 3, walkway: true, points: [[x0 + 120, z0 + 120], [x0 + 220, z0 + 120]] as [number, number][] });
      }
      const payload: CityTilePayload = { buildings, roads };
      const file = `tiles/${id}.json`;
      files.set(file, payload);
      tiles.push({
        id, bounds: tileBounds, file,
        counts: { buildings: buildings.length, roads: roads.length },
      });
    }
  }
  const index: CityTileIndex = {
    version: 3,
    scene: 'nanshan',
    tileSize,
    bounds,
    origin: [113.945, 22.532],
    spawn: [250, 0, 250],
    name: '瓦片 fixture',
    attribution: [{ label: 'fixture · CC0', url: 'https://example.com/fixture' }],
    landmarks: [{
      id: 'way/3_3-tower', name: '测试塔', height: 80, profile: [[0, 1], [80, 0.3]],
      rings: [[[-35, -35], [35, -35], [35, 35], [-35, 35]]],
    }],
    water: { rings: [[[-3000, 2000], [3000, 2000], [3000, 3000], [-3000, 3000]]], level: -0.1 },
    street: { pavingHeight: 0.12, paving: [], placements: [{ kind: 'tree', x: 200, z: 240, yaw: 0 }] },
    counts: { buildings: 36 * 3, roads: 36 + 1 },
    tiles,
  };
  const source: TileLoadSource = {
    baseUrl: FIXTURE_INDEX_URL,
    loadJson: async (url: string) => {
      const relative = url.replace(`${FIXTURE_ORIGIN}assets/city/nanshan/`, '');
      const payload = files.get(relative);
      if (!payload) throw new Error(`fixture 缺少 ${relative}`);
      return payload;
    },
  };
  return { index, files, source };
}

function fixtureMaterials(): TileMaterialSet {
  const material = (): THREE.Material => new THREE.MeshBasicMaterial();
  return {
    facade: {
      glass: { cool: material(), teal: material(), silver: material() },
      office: { cool: material(), teal: material(), silver: material() },
      stone: { cool: material(), teal: material(), silver: material() },
    },
    lod1: material(), roads: material(), walkways: material(), sidewalks: material(), roofs: material(),
  };
}

function collisionRecorder(): {
  adapter: { bake(vertices: Float32Array, indices: Uint32Array): unknown; remove(handle: unknown): void };
  baked: { vertices: Float32Array; indices: Uint32Array }[];
  removed: unknown[];
} {
  const baked: { vertices: Float32Array; indices: Uint32Array }[] = [];
  const removed: unknown[] = [];
  return {
    adapter: {
      bake(vertices, indices) { const handle = {}; baked.push({ vertices, indices }); return handle; },
      remove(handle) { removed.push(handle); },
    },
    baked,
    removed,
  };
}

function createStreamer(fixture: Fixture, preloaded: Map<string, CityTilePayload>, collision?: ReturnType<typeof collisionRecorder>): {
  streamer: TileStreamer;
  group: THREE.Group;
} {
  const group = new THREE.Group();
  return {
    group,
    streamer: new TileStreamer({
      index: fixture.index,
      group,
      materials: fixtureMaterials(),
      loadJson: fixture.source.loadJson,
      baseUrl: fixture.source.baseUrl,
      preloaded,
      collision: collision?.adapter,
      maxOpsPerFrame: 2,
      budgetMs: 1000,
    }),
  };
}

function sameArray(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameIndex(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ───────────────────────────── 单 JSON fallback 数据与假 fetch ─────────────────────────────

function fixtureCityRaw(): unknown {
  return {
    version: 1, name: '回退 fixture', origin: [114.05, 22.54], bounds: [-200, -200, 200, 200],
    spawn: [0, 0.12, 0],
    buildings: [{ id: 'fixture-tower', height: 60, heightSource: 'estimate', rings: [[[-20, -20], [20, -20], [20, 20], [-20, 20]]] }],
    roads: [], street: { pavingHeight: 0.12, paving: [], placements: [] },
    attribution: [{ label: 'fixture · CC0', url: 'https://example.com/fixture' }],
  };
}

function stubSurfaces(): SurfaceAssets {
  const texture = new THREE.Texture();
  const maps = { color: texture, normal: texture, arm: texture };
  return { granite: maps, asphalt: maps };
}

/** 内存 fetch：index 状态码可覆盖，JSON 片走 files 表，单 JSON 返回 fallback。 */
function makeFetch(index: unknown, files: Map<string, unknown>, indexStatus = 200): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const json = (body: unknown): Response => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith('/index.json')) {
      return indexStatus === 200 ? json(index) : new Response('not found', { status: indexStatus });
    }
    if (url.endsWith('/nanshan.json')) return json(fixtureCityRaw());
    const relative = url.replace(`${FIXTURE_ORIGIN}assets/city/nanshan/`, '');
    const payload = files.get(relative);
    return payload === undefined ? new Response('not found', { status: 404 }) : json(payload);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function loadOptions(fetchImpl: typeof fetch): LoadCityOptions {
  return { baseURI: FIXTURE_ORIGIN, fetch: fetchImpl, surfaces: stubSurfaces(), search: '' };
}

beforeAll(async () => { await RAPIER.init(); });

// ───────────────────────────── index / 单片的格式与校验 ─────────────────────────────

describe('瓦片索引 v3（compact JSON）', () => {
  it('合成 index 通过校验：32 个 id/文件/计数都被接受，tiles 可逐片解析', () => {
    const fixture = makeFixture();
    const index = parseCityIndex(JSON.parse(JSON.stringify(fixture.index)));
    expect(index.version).toBe(3);
    expect(index.tiles).toHaveLength(36);
    expect(index.tiles[0]!.file).toMatch(/^tiles\/0_0\.json$/);
    const first = index.tiles[0]!;
    const payload = parseCityTile(fixture.files.get(first.file)!, index, first);
    expect(payload.buildings).toHaveLength(3);
    expect(payload.roads).toHaveLength(1);
  });

  it('拒绝 v2/.bin、重复瓦片、目录穿越、坏 counts 与空 tiles', () => {
    const fixture = makeFixture();
    const bad = (mutate: (raw: Record<string, unknown>) => void): unknown => {
      const raw = JSON.parse(JSON.stringify(fixture.index)) as Record<string, unknown>;
      mutate(raw);
      return raw;
    };
    expect(() => parseCityIndex(bad(raw => { raw.version = 2; }))).toThrow(/version 必须为 3/);
    expect(() => parseCityIndex(bad(raw => { (raw.tiles as unknown[]).push((raw.tiles as unknown[])[0]); }))).toThrow(/重复瓦片/);
    expect(() => parseCityIndex(bad(raw => { (raw.tiles as { file: string }[])[0]!.file = 'tiles/../evil.json'; }))).toThrow(/file/);
    expect(() => parseCityIndex(bad(raw => { (raw.tiles as { file: string }[])[0]!.file = 'tiles/0_0.bin'; }))).toThrow(/file/);
    expect(() => parseCityIndex(bad(raw => { (raw.tiles as { counts: unknown }[])[0]!.counts = { buildings: -1, roads: 0 }; }))).toThrow(/counts/);
    expect(() => parseCityIndex(bad(raw => { raw.tiles = []; }))).toThrow(/tiles/);
  });

  it('单片内容复用 parseCityData 校验；counts 不符/坏楼直接报错', () => {
    const fixture = makeFixture();
    const index = parseCityIndex(fixture.index);
    const def = index.tiles.find(tile => tile.id === '3_3')!;
    const payload = fixture.files.get(def.file) as CityTilePayload;
    expect(() => parseCityTile({ buildings: [], roads: [] }, index, def)).toThrow(/数量与索引不符/);
    expect(() => parseCityTile({ roads: [] }, index, def)).toThrow(/buildings/);
    const badHeight = { buildings: payload.buildings.map(building => ({ ...building, height: -1 })), roads: [] };
    expect(() => parseCityTile(badHeight, index, def)).toThrow(/瓦片内容不合法/);
    // tileCityData 用 tile bounds + 全局字段，spawn 被夹进片内（否则 parseCityData 会拒绝）。
    const data = tileCityData(index, def, payload);
    expect(data.bounds).toEqual(def.bounds);
    expect(data.spawn[0]).toBeGreaterThanOrEqual(def.bounds[0]);
    expect(data.spawn[0]).toBeLessThanOrEqual(def.bounds[2]);
    expect(data.landmarks?.[0]?.id).toBe('way/3_3-tower');
    expect(data.street.placements).toHaveLength(1);
    expect(data.water?.rings).toHaveLength(1);
  });
});

// ───────────────────────────── 纯决策：阈值 / 距离 / 出生 3×3 / 地面块 ─────────────────────────────

describe('流式决策（纯函数）', () => {
  it('视距环：<600 LOD0、600–1500 LOD1、1500–2000 保留、>2000 卸载', () => {
    expect(targetLod(0)).toBe('lod0');
    expect(targetLod(600)).toBe('lod0');
    expect(targetLod(600.01)).toBe('lod1');
    expect(targetLod(1500)).toBe('lod1');
    expect(targetLod(1500.01)).toBe('keep');
    expect(targetLod(2000)).toBe('keep');
    expect(targetLod(2000.01)).toBe('unload');
  });

  it('tileDistanceTo：片内为 0，片外到 AABB 的欧氏距离', () => {
    const bounds: [number, number, number, number] = [0, 0, 1000, 1000];
    expect(tileDistanceTo(500, 500, bounds)).toBe(0);
    expect(tileDistanceTo(-300, 500, bounds)).toBe(300);
    expect(tileDistanceTo(1300, 1400, bounds)).toBeCloseTo(Math.hypot(300, 400), 6);
  });

  it('spawnTileIds：出生点居中 9 片；贴边时只返回存在的片', () => {
    const fixture = makeFixture();
    const ids = spawnTileIds(fixture.index);
    expect(ids).toHaveLength(9);
    expect(ids).toEqual(expect.arrayContaining(['2_2', '3_3', '4_4']));
    expect(spawnTileIds({ ...fixture.index, spawn: [-2900, 0, -2900] })).toHaveLength(4);
  });

  it('LOD1：每栋 12 三角（36 索引 / 24 顶点），顶点色来自 TILE_TINT_RGB', () => {
    const buildings = tileBuildings('lod1', [0, 0, 1000, 1000]);
    const geometry = lod1Geometry(buildings);
    expect(geometry.index!.count).toBe(buildings.length * 36);
    expect(geometry.getAttribute('position').count).toBe(buildings.length * 24);
    expect(geometry.getAttribute('color')).toBeDefined();
    geometry.dispose();
  });

  it('动态地面：5×5×128m，块与块无缝，玩家跨格后整体平移', () => {
    const blocks = groundBlocks(250, 250);
    expect(blocks).toHaveLength(25);
    expect(blocks.every(block => block.size <= GROUND_BLOCK_SIZE)).toBe(true);
    const xs = [...new Set(blocks.map(block => block.centerX))].sort((a, b) => a - b);
    expect(xs).toHaveLength(5);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBe(128);
    expect(blocks.some(block => Math.abs(block.centerX - 250) <= 64 && Math.abs(block.centerZ - 250) <= 64)).toBe(true);
    const shifted = groundBlocks(250 + GROUND_BLOCK_SIZE, 250);
    expect(shifted[0]!.centerX).toBe(blocks[0]!.centerX + GROUND_BLOCK_SIZE);
    expect(shifted[0]!.centerZ).toBe(blocks[0]!.centerZ);
  });

  it('真实 Rapier：角色站在动态地面块上不下沉，跨格平移不重建 collider', async () => {
    const pw = await PhysicsWorld.create(RAPIER, {
      name: 'tile-ground', spawn: [[250, 0, 250]], lights: [], props: [], seats: [], static: [],
    }, { propPoolSize: 0 });
    const ground = new DynamicGround(RAPIER, pw.world);
    ground.install(250, 250);
    expect(ground.colliderCount).toBe(25);
    // 沿 +x 走：跨 128m 接缝（250 → 256 附近）时不能下沉；斜向走会同时撞 4 块交角，
    // 那是 KCC 在 4 角退化接触的已知抖动（room 地板同样出现），不适合当"地面"断言。
    const character = new CharacterController(RAPIER, pw, 250, 0.9, 250);
    let minY = Infinity;
    for (let i = 0; i < 240; i++) {
      character.update({ dirX: 1, dirZ: 0, run: true, jump: false });
      pw.step();
      character.writeTransform(t => { minY = Math.min(minY, t.p[1]); });
    }
    expect(minY).toBeGreaterThan(0.8);
    expect(ground.update(250 + GROUND_BLOCK_SIZE * 2, 250)).toBe(true);
    expect(ground.colliderCount).toBe(25);
    expect(ground.currentBlocks().every(block => block.size <= 128)).toBe(true);
    ground.dispose();
    expect(ground.colliderCount).toBe(0);
    pw.dispose();
  });
});

// ───────────────────────────── TileStreamer：出生 3×3 / 预算 / LOD / 碰撞 / 卸载 ─────────────────────────────

describe('TileStreamer', () => {
  it('出生同步装配 3×3 LOD0（含道路/步道/人行道），250m 内才 bakeTrimesh', async () => {
    const fixture = makeFixture();
    const preloaded = await prefetchSpawnTiles(fixture.index, fixture.source);
    expect(preloaded.size).toBe(9);
    const collision = collisionRecorder();
    const { streamer, group } = createStreamer(fixture, preloaded, collision);
    expect(streamer.warmup()).toBe(9);
    const stats = streamer.stats();
    expect(stats.lod0).toBe(9);
    expect(stats.tilesLoaded).toBe(9);
    expect(stats.loadsLastFrame).toBe(0);
    // 出生点 (250,250)：3_3 距离 0、2_3/3_2 距离 250 → 3 片进碰撞环。
    expect(stats.collisionTiles).toBe(3);
    const expectedChunks = (['3_3', '2_3', '3_2'] as const).reduce((sum, id) => {
      const def = fixture.index.tiles.find(tile => tile.id === id)!;
      const payload = preloaded.get(id)!;
      return sum + facadeChunks(tileCityData(fixture.index, def, payload)).length;
    }, 0);
    expect(collision.baked).toHaveLength(expectedChunks);
    // 每片最多 9 个立面批次；3_3 还有 roads + walkways + sidewalks + roofs。
    const tileGroup = group.getObjectByName('tile-3_3')!;
    expect(tileGroup.getObjectByName('tile-3_3-roads')).toBeDefined();
    expect(tileGroup.getObjectByName('tile-3_3-walkways')).toBeDefined();
    expect(tileGroup.getObjectByName('tile-3_3-sidewalks')).toBeDefined();
    expect(tileGroup.getObjectByName('tile-3_3-roofs')).toBeDefined();
    // draw call 预算：每片 LOD0 ≤ 13 个 mesh（≤9 立面 + 3 道路/人行道 + 1 屋顶），
    // 9 片 × 13 = 117 ≤ 120。加一个 city-cars 批就到 126，所以瓦片模式本轮不撒车。
    expect(tileGroup.children.filter(child => child instanceof THREE.Mesh).length).toBeLessThanOrEqual(13);
    expect(streamer.debugLod0Geometries('3_3').length).toBeGreaterThan(0);
    // 渲染与碰撞同源：每个 bake 的顶点/索引必须逐项等于某片 LOD0 geometry 的属性。
    const geometries = streamer.loadedTileIds().flatMap(id => streamer.debugLod0Geometries(id));
    for (const bake of collision.baked) {
      const matched = geometries.some(geometry => {
        const arrays = colliderArrays(geometry);
        return sameArray(arrays.vertices, bake.vertices) && sameIndex(arrays.indices, bake.indices);
      });
      expect(matched, '碰撞顶点必须来自 LOD0 渲染几何').toBe(true);
    }
    streamer.dispose();
  });

  it('每帧最多 2 片；按 600/1500/2000 收敛；远处片同步卸载', async () => {
    const fixture = makeFixture();
    const preloaded = await prefetchSpawnTiles(fixture.index, fixture.source);
    const { streamer, group } = createStreamer(fixture, preloaded);
    streamer.warmup();
    await streamer.stepFrame(2, 1000);
    expect(streamer.stats().loadsLastFrame).toBe(2);
    expect(streamer.stats().tilesLoaded).toBe(11);
    await streamer.settle();
    const stats = streamer.stats();
    expect(stats.tilesLoaded).toBeGreaterThan(11);
    for (const id of streamer.loadedTileIds()) {
      const def = fixture.index.tiles.find(tile => tile.id === id)!;
      const distance = tileDistanceTo(250, 250, def.bounds);
      expect(distance).toBeLessThanOrEqual(2000);
      expect(streamer.lodOf(id)).toBe(distance <= 600 ? 'lod0' : 'lod1');
    }
    // 3×3 里 600m 外的角片被降级，不是一直占着 LOD0。
    expect(streamer.lodOf('4_4')).toBe('lod1');
    expect(streamer.lodOf('2_2')).toBe('lod0');
    // 离开 2000m：全部立即卸载（不等预算）。
    streamer.update(fixture.index.bounds[2] + 5000, fixture.index.bounds[3] + 5000);
    expect(streamer.stats().tilesLoaded).toBe(0);
    expect(streamer.stats().collisionTiles).toBe(0);
    expect(group.children).toHaveLength(0);
    streamer.dispose();
  });

  it('视锥内的片优先：同一优先级组里可见片排在不可见片之前', async () => {
    const fixture = makeFixture();
    const preloaded = await prefetchSpawnTiles(fixture.index, fixture.source);
    const group = new THREE.Group();
    // maxOpsPerFrame=0：只做决策不落地，这样能在 update() 后读到完整待办（含第一片）。
    const streamer = new TileStreamer({
      index: fixture.index, group, materials: fixtureMaterials(), preloaded,
      loadJson: fixture.source.loadJson, baseUrl: fixture.source.baseUrl, maxOpsPerFrame: 0,
    });
    streamer.warmup(['3_3']);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    camera.position.set(250, 20, 250);
    camera.lookAt(2500, 20, 250);
    streamer.update(250, 250, camera);
    const operations = streamer.planOperations();
    const loads = operations.filter(operation => operation.kind === 'load' || operation.kind === 'upgrade');
    expect(loads.length).toBeGreaterThan(0);
    // 相机朝 +x：前方 4_3（x 1000–2000）可见，背后 2_3 不可见；可见片排前面。
    const byId = new Map(loads.map(operation => [operation.id, operation]));
    expect(byId.get('4_3')?.visible).toBe(true);
    expect(byId.get('2_3')?.visible).toBe(false);
    const firstInvisible = loads.findIndex(operation => !operation.visible);
    expect(firstInvisible).toBeGreaterThan(0);
    expect(loads.slice(firstInvisible).every(operation => !operation.visible)).toBe(true);
    streamer.dispose();
  });

  it('LOD0 每片一个 city-roofs（不碰撞、不 bake）；降级到 LOD1 后屋顶被拆掉', async () => {
    const fixture = makeFixture();
    const preloaded = await prefetchSpawnTiles(fixture.index, fixture.source);
    const collision = collisionRecorder();
    const { streamer, group } = createStreamer(fixture, preloaded, collision);
    streamer.warmup();
    const roof = group.getObjectByName('tile-3_3-roofs') as THREE.Mesh;
    expect(roof).toBeDefined();
    expect(roof.castShadow).toBe(false);
    // 碰撞源只有 `lod0Geometries`（立面）：屋顶几何不在里面，就不可能有"楼顶女儿墙碰撞"。
    const collisionGeometries = streamer.loadedTileIds().flatMap(id => streamer.debugLod0Geometries(id));
    expect(collisionGeometries).not.toContain(roof.geometry);
    // 每一次 bakeTrimesh 的顶点都必须来自某个 LOD0 立面几何，绝不来自屋顶几何。
    expect(collision.baked.length).toBeGreaterThan(0);
    for (const bake of collision.baked) {
      const fromFacade = collisionGeometries.some(geometry => sameArray(colliderArrays(geometry).vertices, bake.vertices));
      expect(fromFacade, '碰撞顶点必须来自立面几何（屋顶不 bake）').toBe(true);
    }
    // 4_4 在 600m 外 → settle 之后是 LOD1，屋顶细节必须一起消失（LOD1 不建屋顶）。
    const outerRoof = group.getObjectByName('tile-4_4-roofs') as THREE.Mesh;
    expect(outerRoof, '出生 3×3 里每片 LOD0 都有 roofs').toBeDefined();
    let disposed = 0;
    outerRoof.geometry.addEventListener('dispose', () => { disposed += 1; });
    await streamer.settle();
    expect(streamer.lodOf('4_4')).toBe('lod1');
    expect(group.getObjectByName('tile-4_4-roofs')).toBeUndefined();
    expect(disposed).toBe(1);
    // 仍是 LOD0 的中心片屋顶还在。
    expect(group.getObjectByName('tile-3_3-roofs')).toBeDefined();
    expect(streamer.lodOf('3_3')).toBe('lod0');
    streamer.dispose();
  });

  it('dispose 释放全部瓦片几何、移除全部碰撞体，group 清空', async () => {
    const fixture = makeFixture();
    const preloaded = await prefetchSpawnTiles(fixture.index, fixture.source);
    const collision = collisionRecorder();
    const { streamer, group } = createStreamer(fixture, preloaded, collision);
    streamer.warmup();
    const geometries: THREE.BufferGeometry[] = [];
    group.traverse(object => { if (object instanceof THREE.Mesh) geometries.push(object.geometry); });
    expect(geometries.length).toBeGreaterThan(0);
    let disposed = 0;
    for (const geometry of geometries) geometry.addEventListener('dispose', () => { disposed += 1; });
    const baked = collision.baked.length;
    expect(baked).toBeGreaterThan(0);
    streamer.dispose();
    expect(disposed).toBe(geometries.length);
    expect(collision.removed).toHaveLength(baked);
    expect(group.children).toHaveLength(0);
    expect(streamer.stats().tilesLoaded).toBe(0);
  });

  it('坏瓦片连续失败会停用，不会每帧重试（也不静默把整片当空）', async () => {
    const fixture = makeFixture();
    const preloaded = await prefetchSpawnTiles(fixture.index, fixture.source);
    const group = new THREE.Group();
    let attempts = 0;
    const streamer = new TileStreamer({
      index: fixture.index, group, materials: fixtureMaterials(), preloaded,
      baseUrl: fixture.source.baseUrl,
      loadJson: async () => { attempts += 1; throw new Error('坏的片 JSON'); },
      maxOpsPerFrame: 8, budgetMs: 1000,
    });
    streamer.warmup();
    for (let i = 0; i < 5; i++) await streamer.stepFrame(8, 1000);
    expect(attempts).toBeLessThanOrEqual(3 * fixture.index.tiles.length);
    expect(streamer.stats().tilesLoaded).toBe(9); // 坏的是后续加载，出生 3×3 仍在
    streamer.dispose();
  });
});

// ───────────────────────────── loadCity：瓦片优先 / 404 回退 / ?tiles=0 ─────────────────────────────

describe('loadCity 瓦片探测与回退', () => {
  it('index.json 200 → 瓦片模式；出生 3×3 预取完成；信息卡用 counts', async () => {
    const fixture = makeFixture();
    const { fetch: fetchImpl, calls } = makeFetch(fixture.index, fixture.files);
    const scene = await loadCity('nanshan', loadOptions(fetchImpl));
    expect(scene.mode).toBe('tiles');
    expect(scene.sceneKey).toBe('nanshan');
    expect(scene.data.name).toBe('瓦片 fixture');
    expect(scene.tiled?.index.tiles).toHaveLength(36);
    expect(scene.tiled?.preloaded.size).toBe(9);
    const jsonCalls = calls.filter(call => call.endsWith('.json'));
    // 1 个 index + 9 个 JSON 片。
    expect(jsonCalls).toHaveLength(10);
    const summary = cityInfoText(scene.data, scene.tiled!.index.counts).summary;
    expect(summary).toContain((36 * 3).toLocaleString());
    // cityDataFromIndex 把地标真实轮廓带进 buildings（main.ts 的出生朝向要用）。
    expect(scene.data.buildings.map(building => building.id)).toEqual(['way/3_3-tower']);
    expect(scene.data.landmarks?.[0]?.profile).toHaveLength(2);
  });

  it('index.json 404 → 回退单 JSON，模式仍是 single', async () => {
    const fixture = makeFixture();
    const { fetch: fetchImpl, calls } = makeFetch(fixture.index, fixture.files, 404);
    const scene = await loadCity('nanshan', loadOptions(fetchImpl));
    expect(scene.mode).toBe('single');
    expect(scene.data.name).toBe('回退 fixture');
    expect(calls.some(call => call.endsWith('/nanshan.json'))).toBe(true);
  });

  it('?tiles=0 不请求 index.json，直接走单 JSON（坏了也不影响回退）', async () => {
    const fixture = makeFixture();
    const { fetch: fetchImpl, calls } = makeFetch(fixture.index, fixture.files, 500);
    const options = { ...loadOptions(fetchImpl), search: '?tiles=0&scene=nanshan' };
    const scene = await loadCity('nanshan', options);
    expect(scene.mode).toBe('single');
    expect(calls.some(call => call.endsWith('/index.json'))).toBe(false);
    expect(calls[0]).toContain('/nanshan.json');
  });

  it('index 500 / 场景写错 → 抛错（不静默回退掩盖烘焙故障）', async () => {
    const fixture = makeFixture();
    const broken = makeFetch(fixture.index, fixture.files, 500);
    await expect(loadCity('nanshan', loadOptions(broken.fetch)))
      .rejects.toThrow(/瓦片索引加载失败（nanshan，HTTP 500）/);
    const mismatch = makeFetch({ ...fixture.index, scene: 'futian' }, fixture.files);
    await expect(loadCity('nanshan', loadOptions(mismatch.fetch))).rejects.toThrow(/瓦片索引场景不符/);
  });
});

// ───────────────────────────── 真实瓦片 / 合成 fixture 的端到端同路径 ─────────────────────────────

/**
 * 真实瓦片（烘焙线产出）存在时读真实 index+JSON；否则用合成 fixture 跑**同一套断言**。
 * 不写 `it.skip`：真实瓦片缺失不是"不测"的理由。
 */
function realTiles(): { index: CityTileIndex; source: TileLoadSource; path: string } | null {
  const indexPath = new URL('../../assets/city/nanshan/index.json', import.meta.url);
  if (!existsSync(indexPath)) return null;
  const index = parseCityIndex(JSON.parse(readFileSync(indexPath, 'utf8')));
  return {
    index,
    path: indexPath.href,
    source: {
      baseUrl: pathToFileURL(fileURLToPath(indexPath)).href,
      loadJson: async (url: string) => JSON.parse(readFileSync(fileURLToPath(url), 'utf8')),
    },
  };
}

describe('端到端：index → 出生 3×3 → 建几何 → 预算 → 碰撞环 → 卸载', () => {
  it('真实瓦片存在就用真实瓦片，否则用合成 fixture（同一套断言，不 skip）', async () => {
    const real = realTiles();
    const fixture = real ? null : makeFixture();
    const index = real?.index ?? fixture!.index;
    const source = real?.source ?? fixture!.source;
    const preloaded = await prefetchSpawnTiles(index, source);
    expect(preloaded.size).toBe(spawnTileIds(index).length);
    const collision = collisionRecorder();
    const group = new THREE.Group();
    const streamer = new TileStreamer({
      index, group, materials: fixtureMaterials(), preloaded,
      loadJson: source.loadJson, baseUrl: source.baseUrl,
      collision: collision.adapter, budgetMs: 1000,
    });
    expect(streamer.warmup()).toBe(preloaded.size);
    expect(streamer.stats().lod0).toBe(preloaded.size);
    await streamer.stepFrame(2, 1000);
    expect(streamer.stats().loadsLastFrame).toBeLessThanOrEqual(2);
    await streamer.settle();
    const stats = streamer.stats();
    expect(stats.tilesLoaded).toBeGreaterThanOrEqual(preloaded.size);
    // 已加载片都在 2000m 内；碰撞片数量恰好等于「250m 内且 LOD0 的片」。
    for (const id of streamer.loadedTileIds()) {
      const def = index.tiles.find(tile => tile.id === id)!;
      expect(tileDistanceTo(index.spawn[0], index.spawn[2], def.bounds)).toBeLessThanOrEqual(2000);
      // 空片（海面）可以没有建筑几何，但片组必须存在（道路可能也没有）。
      expect(group.getObjectByName(`tile-${id}`)).toBeDefined();
    }
    const collisionRadius = index.tiles.filter(tile =>
      tileDistanceTo(index.spawn[0], index.spawn[2], tile.bounds) <= 250 &&
      streamer.lodOf(tile.id) === 'lod0').length;
    expect(stats.collisionTiles).toBe(collisionRadius);
    expect(group.children.length).toBeGreaterThan(0);
    console.info(real ? '[tiles] 真实瓦片端到端' : '[tiles] 合成 fixture 端到端（真实瓦片尚未产出）', {
      source: real ? 'assets/city/nanshan/index.json' : 'fixture',
      tiles: index.tiles.length,
      buildings: index.counts?.buildings ?? null,
      spawnTiles: preloaded.size,
      loaded: stats.tilesLoaded,
      lod0: stats.lod0,
      lod1: stats.lod1,
      collisionTiles: stats.collisionTiles,
    });
    streamer.dispose();
  });

  it('真实 index 的每片 JSON 都存在、栋数/路数与 counts 一致（无真实片时用 fixture 断言同一件事）', async () => {
    const real = realTiles();
    const fixture = real ? null : makeFixture();
    const index = real?.index ?? fixture!.index;
    const files = fixture?.files;
    let checked = 0;
    for (const tile of index.tiles) {
      const payload = real
        ? parseCityTile(JSON.parse(readFileSync(fileURLToPath(new URL(tile.file, real.source.baseUrl)), 'utf8')), index, tile)
        : parseCityTile(files!.get(tile.file), index, tile);
      checked += 1;
      // 每栋楼按轮廓中心归片：中心必须落在自己的片里（跨片建筑整体归中心片）。
      for (const building of payload.buildings) {
        const ring = building.rings[0]!;
        const cx = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
        const cz = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
        expect(cx).toBeGreaterThanOrEqual(tile.bounds[0]);
        expect(cx).toBeLessThanOrEqual(tile.bounds[2]);
        expect(cz).toBeGreaterThanOrEqual(tile.bounds[1]);
        expect(cz).toBeLessThanOrEqual(tile.bounds[3]);
      }
    }
    expect(checked).toBe(index.tiles.length);
  });
});

