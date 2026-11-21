import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { parseCityData, type CityBuilding, type CityCanopy, type CityData, type CityLandmark, type Point2, type StreetPlacement } from './data';
import {
  buildingGeometry, buildingChunks, carGeometry, carPlacements, colliderArrays, facadeChunks,
  landmarkProfiles, ridgeGeometry, roadGeometry, roofGeometry, shoreGeometry, sidewalkGeometry,
  sidewalkWidth, waterGeometry, SIDEWALK_HEIGHT, CAR_COUNT, RIDGE, ROOF_COLORS, ROOF_EQUIPMENT_MIN_HEIGHT,
  ROOF_PARAPET, SHORE_LIFT, SHORE_WIDTH,
} from './geometry';
import { buildStreetKit, GENERIC_SIGN_LABEL, STREET_KIT } from './kit';
import { landmarkScale } from './landmark';
import { CityScene, cityInfoText, cityLayerParts, hasVertices, streetKitParts, waterLayerParts } from './runtime';
import {
  CITY_LIGHTING, FACADE_TINTS, facadeTint, carMaterial, facadeMaterial, ridgeMaterial, roofMaterial,
  shoreMaterial, waterMaterial, windowEmissiveIntensity, NIGHT_EMISSIVE_INTENSITY, NIGHT_WINDOW_EMISSIVE,
  WATER_COLOR,
} from './materials';
import { LIGHTING_PRESETS } from '../render/lighting';
import { bakeTrimesh } from '../physics/bake';
import { PhysicsWorld } from '../physics/engine';
import { CharacterController } from '../physics/character';
import { parseRoom } from '../core/room';

const raw = () => JSON.parse(readFileSync(new URL('../../assets/city/futian.json', import.meta.url), 'utf8'));
/**
 * 南山数据由数据线（task-1/task-3）交付。**缺文件要红，不能静默跳过**：
 * 静默 skip 会让「南山到底跑没跑过」变成一句没人能验证的话。
 */
const nanshanRaw = (): unknown => {
  try {
    return JSON.parse(readFileSync(new URL('../../assets/city/nanshan.json', import.meta.url), 'utf8'));
  } catch (error) {
    throw new Error('等待 data 线：world/assets/city/nanshan.json 缺失或不可读', { cause: error });
  }
};

const square: CityBuilding = { id: 'fixture', height: 10, heightSource: 'estimate', rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]] };

const SPRING_BAMBOO: CityLandmark = {
  id: 'way/spring-bamboo', name: '春笋（中国华润大厦）', height: 392.5,
  profile: [[0, 1], [20, 0.99], [100, 0.95], [200, 0.86], [300, 0.7], [360, 0.45], [392.5, 0.08]],
};

/** 空街区 fixture：默认没有铺装/零件/地标/水面——证明装配代码不会被"缺字段"绊倒。 */
function fixtureRaw(options: {
  landmark?: CityLandmark;
  landmarks?: CityLandmark[];
  canopy?: CityCanopy;
  placements?: StreetPlacement[];
  paving?: Point2[][][];
  roads?: CityData['roads'];
  water?: { rings: Point2[][]; level?: number };
  buildings?: CityBuilding[];
} = {}): unknown {
  return {
    version: 1,
    name: '空街 fixture',
    origin: [114.05, 22.54],
    bounds: [-300, -300, 300, 300],
    spawn: [0, 0.12, 0],
    buildings: options.buildings ?? [
      { id: 'fixture-tower', height: 200, heightSource: 'estimate', rings: [[[-40, -40], [40, -40], [40, 40], [-40, 40]]] },
      { id: 'fixture-block', height: 12, heightSource: 'estimate', rings: [[[60, 60], [80, 60], [80, 80], [60, 80]]] },
    ],
    roads: options.roads ?? [],
    street: {
      pavingHeight: 0.12,
      paving: options.paving ?? [],
      placements: options.placements ?? [],
      ...(options.canopy ? { canopy: options.canopy } : {}),
    },
    attribution: [{ label: 'fixture 数据 · CC0', url: 'https://example.com/fixture' }],
    ...(options.landmark ? { landmark: options.landmark } : {}),
    ...(options.landmarks ? { landmarks: options.landmarks } : {}),
    ...(options.water ? { water: options.water } : {}),
  };
}

/** 点到线段距离（米）。出生点净空断言用它，而不是到包围盒中心的距离。 */
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** 点到建筑轮廓（含内院孔洞）的最近距离。 */
function distanceToBuilding(building: CityBuilding, x: number, z: number): number {
  let nearest = Infinity;
  for (const ring of building.rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      nearest = Math.min(nearest, segmentDistance(x, z, a[0], a[1], b[0], b[1]));
    }
  }
  return nearest;
}

/** 点在环内（射线交叉）。凹轮廓下也不能用包围盒近似。 */
function insideRing(ring: Point2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * 最小 canvas stub：`facadeMaterial()` 要 `document.createElement('canvas')` 画 4 张 atlas，
 * 而单测跑在 node（没有 DOM）。这里只提供"任何方法都能调用、任何属性都能赋值"的假 ctx，
 * 为的是断言**材质接线**（emissiveMap 是否复用颜色图），不是断言像素。
 */
function stubCanvasDocument(): () => void {
  const previous = (globalThis as { document?: unknown }).document;
  const context = new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
  const canvas = { width: 512, height: 512, getContext: () => context } as unknown as HTMLCanvasElement;
  (globalThis as { document?: unknown }).document = { createElement: () => canvas };
  return () => { (globalThis as { document?: unknown }).document = previous; };
}

/** 一批几何在 [low, high] 高度区间内的水平 x 跨度，用来断言"收分"真的发生。 */
function xSpanBetween(geometry: THREE.BufferGeometry, low: number, high: number): number {
  const position = geometry.getAttribute('position');
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y < low || y > high) continue;
    min = Math.min(min, position.getX(i));
    max = Math.max(max, position.getX(i));
  }
  return max - min;
}

function boundsY(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  return geometry.boundingBox!.max.y;
}

beforeAll(async () => { await RAPIER.init(); });

describe('福田数据边界', () => {
  it('加载已清理样区，只有一个明确核验地标', () => {
    const data = parseCityData(raw());
    expect(data.buildings.length).toBe(1230);
    expect(data.roads.length).toBe(809);
    const landmarks = data.buildings.filter(b => b.heightSource === 'ctbuh');
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0]!.name).toBe('平安金融中心');
    expect(landmarks[0]!.height).toBe(599.1);
  });
  it.each([-1, 0, Infinity, NaN, 1001])('拒绝无效高度 %s', height => {
    const data = raw(); data.buildings[0].height = height;
    expect(() => parseCityData(data)).toThrow();
  });
  it('拒绝损坏的轮廓、重复ID、危险来源URL', () => {
    let data = raw(); data.buildings[0].rings = [[[0, 0]]];
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.buildings.push(data.buildings[0]);
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.attribution[0].url = 'javascript:alert(1)';
    expect(() => parseCityData(data)).toThrow();
  });
  it('拒绝出生点越界、错误版本和非有限坐标', () => {
    let data = raw(); data.spawn[0] = 2000;
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.version = 2;
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.buildings[0].rings[0][0][0] = Infinity;
    expect(() => parseCityData(data)).toThrow();
  });
  it('街区地面与可见边界使用同一房间数据', () => {
    const city = new CityScene(parseCityData(raw()));
    expect(parseRoom(city.room).static).toHaveLength(328);
    expect(city.room.static.filter(s => s.mat === 'floor').every(s => s.type === 'box' && s.size[0] <= 128 && s.size[2] <= 128)).toBe(true);
    expect(city.room.spawn[0]).toEqual(city.data.spawn);
  });
});

describe('街区渲染与碰撞同源', () => {
  it('挤出保持 x/z 与正高度方向', () => {
    const geometry = buildingGeometry(square);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.x).toBeCloseTo(0);
    expect(geometry.boundingBox!.max.z).toBeCloseTo(10);
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0);
    expect(geometry.boundingBox!.max.y).toBeCloseTo(10);
    geometry.dispose();
  });
  it('完整样区最多四个建筑draw call，碰撞顶点逐项等于渲染顶点', () => {
    const geometries = buildingChunks(parseCityData(raw()));
    expect(geometries.length).toBeLessThanOrEqual(4);
    for (const geometry of geometries) {
      const { vertices, indices } = colliderArrays(geometry);
      expect(vertices).toEqual(geometry.getAttribute('position').array);
      expect(indices.length % 3).toBe(0);
      expect(geometry.groups).toHaveLength(0);
      expect(geometry.boundingSphere!.radius).toBeGreaterThan(0);
      geometry.dispose();
    }
  });
  it('凹轮廓不会被碰撞包围盒填满', () => {
    const geometry = buildingGeometry({ ...square, rings: [[[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]]] });
    const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const data = colliderArrays(geometry);
    const collider = bakeTrimesh(RAPIER, physics, data.vertices, data.indices);
    expect(collider.castRay(new RAPIER.Ray({ x: 8, y: 20, z: 8 }, { x: 0, y: -1, z: 0 }), 30, true)).toBe(-1);
    expect(collider.castRay(new RAPIER.Ray({ x: 1, y: 20, z: 1 }, { x: 0, y: -1, z: 0 }), 30, true)).toBeCloseTo(10);
    physics.free(); geometry.dispose();
  });
  it('内院孔洞在可见屋顶和碰撞中都保留', () => {
    const geometry = buildingGeometry({ ...square, rings: [...square.rings, [[3, 3], [7, 3], [7, 7], [3, 7]]] });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster(new THREE.Vector3(5, 20, 5), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const data = colliderArrays(geometry);
    const collider = bakeTrimesh(RAPIER, physics, data.vertices, data.indices);
    expect(collider.castRay(new RAPIER.Ray({ x: 5, y: 20, z: 5 }, { x: 0, y: -1, z: 0 }), 30, true)).toBe(-1);
    physics.free(); geometry.dispose(); mesh.material.dispose();
  });
  it('真角色冲向楼墙会停住且能沿墙滑行', async () => {
    const pw = await PhysicsWorld.create(RAPIER, parseRoom({ name: 'test', spawn: [[0, 0, 0]], lights: [], props: [], seats: [], static: [{ type: 'box', pos: [0, -0.1, 0], size: [60, 0.2, 60] }] }), { propPoolSize: 0 });
    const geometry = buildingGeometry(square);
    const data = colliderArrays(geometry);
    bakeTrimesh(RAPIER, pw.world, data.vertices, data.indices);
    const character = new CharacterController(RAPIER, pw, -3, 0.9, 5);
    for (let i = 0; i < 150; i++) {
      character.update({ dirX: 1, dirZ: 0, run: true, jump: false }); pw.step();
    }
    let position = { x: 0, y: 0, z: 0 };
    character.writeTransform(t => { position = { x: t.p[0], y: t.p[1], z: t.p[2] }; });
    expect(position.x).toBeLessThan(-0.25);
    expect(position.x).toBeGreaterThan(-0.6);
    const before = position.z;
    for (let i = 0; i < 30; i++) {
      character.update({ dirX: 1, dirZ: 1, run: false, jump: false }); pw.step();
    }
    character.writeTransform(t => { position = { x: t.p[0], y: t.p[1], z: t.p[2] }; });
    expect(position.z).toBeGreaterThan(before + 0.4);
    expect(position.x).toBeLessThan(-0.25);
    expect(position.y).toBeGreaterThan(0.8);
    pw.dispose(); geometry.dispose();
  });
  it('真实福田出生点冲向地标墙不下沉', async () => {
    const data = parseCityData(raw());
    const city = new CityScene(data);
    const pw = await PhysicsWorld.create(RAPIER, city.room, { propPoolSize: 0 });
    const geometries = buildingChunks(data);
    for (const geometry of geometries) {
      const arrays = colliderArrays(geometry);
      bakeTrimesh(RAPIER, pw.world, arrays.vertices, arrays.indices);
    }
    const character = new CharacterController(RAPIER, pw, data.spawn[0], 0.9, data.spawn[2]);
    let minY = Infinity;
    let last: unknown;
    for (let i = 0; i < 400; i++) {
      character.update({ dirX: -1, dirZ: 0, run: true, jump: false });
      pw.step();
      character.writeTransform(t => { minY = Math.min(minY, t.p[1]); last = t.p; });
    }
    console.info('city wall contact', { minY, last });
    pw.dispose(); geometries.forEach(g => g.dispose());
    expect(minY).toBeGreaterThan(0.8);
  });
  it('真实角色跨地板块接缝不下沉也不被绊住', async () => {
    const city = new CityScene(parseCityData(raw()));
    const pw = await PhysicsWorld.create(RAPIER, city.room, { propPoolSize: 0 });
    const character = new CharacterController(RAPIER, pw, -353, 0.9, 31);
    let minY = Infinity, x = -353, z = 31;
    for (let i = 0; i < 240; i++) {
      character.update({ dirX: 1, dirZ: 1, run: true, jump: false }); pw.step();
      character.writeTransform(t => { minY = Math.min(minY, t.p[1]); x = t.p[0]; z = t.p[2]; });
    }
    pw.dispose();
    expect(minY).toBeGreaterThan(0.8);
    expect(x).toBeGreaterThan(-343);
    expect(z).toBeGreaterThan(41);
  });
  it('路面法线向上，重复点不制造无效顶点', () => {
    const geometry = roadGeometry([{ id: 'road', walkway: false, width: 6, points: [[0, 0], [0, 0], [10, 0]] }]);
    expect(geometry.getAttribute('position').count).toBe(6);
    expect(geometry.getAttribute('normal').getY(0)).toBeCloseTo(1);
    geometry.dispose();
  });
});

describe('多地标收分', () => {
  it('landmark 与 landmarks[] 合并成 id→profile，同 id 先到先得', () => {
    const spring = { ...SPRING_BAMBOO, id: 'way/a', profile: [[0, 1], [100, 0.5]] as [number, number][] };
    const other = { ...SPRING_BAMBOO, id: 'way/b', profile: [[0, 1], [50, 0.2]] as [number, number][] };
    const data = parseCityData(fixtureRaw({ landmark: spring, landmarks: [other, { ...spring, profile: [[0, 1], [100, 0.1]] }] }));
    const profiles = landmarkProfiles(data);
    expect([...profiles.keys()].sort()).toEqual(['way/a', 'way/b']);
    // landmark 先写入，landmarks[] 里的同 id 不覆盖它。
    expect(profiles.get('way/a')).toBe(spring.profile);
    expect(profiles.get('way/b')).toBe(other.profile);
  });
  it('春笋按自己的 profile 收 60 段，顶高与冠部宽度都对', () => {
    const tower: CityBuilding = { id: SPRING_BAMBOO.id!, height: SPRING_BAMBOO.height, heightSource: 'ctbuh', rings: [[[0, 0], [40, 0], [40, 40], [0, 40]]] };
    const straight = buildingGeometry(tower);
    const tapered = buildingGeometry(tower, SPRING_BAMBOO.profile);
    expect(boundsY(tapered)).toBeCloseTo(392.5, 2);
    // 60 段收分比 1 段直筒多出大量顶点（证明 steps=60 真的生效）。
    expect(tapered.getAttribute('position').count).toBeGreaterThan(straight.getAttribute('position').count * 4);
    // 基底仍是原始轮廓（40m），冠部收到 40×0.08 ≈ 3.2m。
    expect(xSpanBetween(tapered, -0.1, 1)).toBeCloseTo(40, 1);
    expect(xSpanBetween(tapered, 391, 393)).toBeLessThan(5);
    expect(xSpanBetween(straight, 391, 393)).toBeCloseTo(40, 1);
    straight.dispose(); tapered.dispose();
  });
  it('facadeChunks 用数据里的 profile 收分（不是只认平安 id）', () => {
    const tower: CityBuilding = { id: SPRING_BAMBOO.id!, height: SPRING_BAMBOO.height, heightSource: 'ctbuh', rings: [[[0, 0], [40, 0], [40, 40], [0, 40]]] };
    const data = parseCityData(fixtureRaw({ buildings: [tower], landmarks: [SPRING_BAMBOO] }));
    const chunks = facadeChunks(data);
    expect(chunks).toHaveLength(1);
    expect(boundsY(chunks[0]!.geometry)).toBeCloseTo(392.5, 2);
    expect(xSpanBetween(chunks[0]!.geometry, 391, 393)).toBeLessThan(5);
    chunks.forEach(chunk => chunk.geometry.dispose());
  });
  it('真实南山：春笋 392.5m 且按 profile 收分', () => {
    const data = parseCityData(nanshanRaw());
    const spring = data.landmarks?.find(landmark => landmark.name.includes('春笋'));
    expect(spring, '南山数据必须声明春笋 landmarks[]').toBeDefined();
    const tower = data.buildings.find(building => building.id === spring!.id);
    expect(tower, 'landmarks[].id 必须能在 buildings[] 里找回').toBeDefined();
    expect(tower!.heightSource).toBe('ctbuh');
    expect(tower!.height).toBeCloseTo(392.5, 1);
    const geometry = buildingGeometry(tower!, spring!.profile);
    expect(boundsY(geometry)).toBeCloseTo(392.5, 1);
    expect(xSpanBetween(geometry, -0.1, 2)).toBeGreaterThan(xSpanBetween(geometry, 391, 393));
    geometry.dispose();
    // 整个南山立面分块里最高的顶点也必须是春笋（证明 profile 进了真实装配路径）。
    const chunks = facadeChunks(data);
    const tallest = Math.max(...chunks.map(chunk => boundsY(chunk.geometry)));
    expect(tallest).toBeCloseTo(392.5, 1);
    chunks.forEach(chunk => chunk.geometry.dispose());
  });
});

describe('水面', () => {
  it('water mesh 从 data.water 生成、默认 level=-0.1、法线朝上', () => {
    const data = parseCityData(fixtureRaw({ water: { rings: [[[-60, 60], [60, 60], [60, 160], [-60, 160]]] } }));
    const layers = cityLayerParts(data);
    const water = layers.find(layer => layer.name === 'city-water');
    expect(water, '有 water 字段就必须建 city-water').toBeDefined();
    const position = water!.geometry.getAttribute('position');
    expect(position.count).toBeGreaterThan(0);
    for (let i = 0; i < position.count; i++) expect(position.getY(i)).toBeCloseTo(-0.1, 5);
    expect(water!.geometry.getAttribute('normal').getY(0)).toBeGreaterThan(0.9);
    // 视觉层接口里没有 collision 字段：mount 也只给 streetKitParts 里 collision=true 的零件烘焙。
    expect('collision' in water!).toBe(false);
    expect(water!.geometry.getAttribute('position').array).toBeInstanceOf(Float32Array);
  });
  it('water.level 覆盖默认高度；空 rings 返回空几何', () => {
    const geometry = waterGeometry([[[0, 0], [10, 0], [10, 10], [0, 10]]], 0.35);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.y).toBeCloseTo(0.35, 5);
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0.35, 5);
    geometry.dispose();
    expect(hasVertices(waterGeometry([], -0.1))).toBe(false);
  });
  it('waterMaterial：深圳湾蓝绿、近镜面（roughness 0.05）、轻金属、反射增益 2', () => {
    const material = waterMaterial();
    expect(material.color.getHex()).toBe(WATER_COLOR);
    expect(material.color.getHex()).toBe(0x2e5f73);
    expect(material.roughness).toBeCloseTo(0.05, 5);
    expect(material.metalness).toBeCloseTo(0.3, 5);
    expect(material.envMapIntensity).toBeCloseTo(2, 5);
    expect(material.name).toBe('city-water');
    material.dispose();
  });
  it('岸线泡沫/沙线：贴着水岸内侧的一条亮带，纯色几何、不碰撞', () => {
    const ring: Point2[] = [[-60, 60], [60, 60], [60, 160], [-60, 160]];
    const geometry = shoreGeometry([ring], -0.1);
    const position = geometry.getAttribute('position');
    expect(position.count).toBeGreaterThan(0);
    // 比水面高 0.02m（共面会 z-fighting），整条带子都在水面之上、岸线以内。
    // 外沿顶点正好压在水岸线上（射线法对边界点判定不稳），所以边界点单独放行。
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBeCloseTo(-0.1 + SHORE_LIFT, 5);
      const x = position.getX(i), z = position.getZ(i);
      let boundary = Infinity;
      for (let e = 0; e < ring.length; e++) {
        const a = ring[e]!, b = ring[(e + 1) % ring.length]!;
        boundary = Math.min(boundary, segmentDistance(x, z, a[0], a[1], b[0], b[1]));
      }
      expect(insideRing(ring, x, z) || boundary < 0.01, '岸线亮带必须落在水环内部').toBe(true);
    }
    expect(geometry.getAttribute('normal').getY(0)).toBeCloseTo(1, 5);
    // 宽带必须真的朝水里铺：三角形总面积 ≈ 周长 × 宽度（±40%），不是只画了一条岸线。
    let area = 0;
    for (let i = 0; i < position.count; i += 3) {
      const ax = position.getX(i), az = position.getZ(i);
      const bx = position.getX(i + 1), bz = position.getZ(i + 1);
      const cx = position.getX(i + 2), cz = position.getZ(i + 2);
      area += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
    }
    const perimeter = ring.reduce((sum, point, index) => {
      const next = ring[(index + 1) % ring.length]!;
      return sum + Math.hypot(next[0] - point[0], next[1] - point[1]);
    }, 0);
    expect(area).toBeGreaterThan(perimeter * SHORE_WIDTH * 0.6);
    expect(area).toBeLessThan(perimeter * SHORE_WIDTH * 1.4);
    geometry.dispose();
    // 空数据/空环不建几何（旧数据没有 water 时装配路径不会崩）。
    expect(hasVertices(shoreGeometry([], -0.1))).toBe(false);
    expect(waterLayerParts(parseCityData(fixtureRaw()))).toHaveLength(0);
    const material = shoreMaterial();
    expect(material.metalness).toBe(0);
    expect(material.roughness).toBeGreaterThan(0.8);
    material.dispose();
  });
  it('没有 water 字段就不建 city-water / city-shore（旧数据安全）', () => {
    const layers = cityLayerParts(parseCityData(fixtureRaw()));
    expect(layers.some(layer => layer.name === 'city-water')).toBe(false);
    expect(layers.some(layer => layer.name === 'city-shore')).toBe(false);
  });
});

describe('LOD0 屋顶细节', () => {
  const tall: CityBuilding = {
    id: 'way/tall', height: 120, heightSource: 'estimate',
    rings: [[[0, 0], [40, 0], [40, 40], [0, 40]]],
  };
  const low: CityBuilding = {
    id: 'way/low', height: 12, heightSource: 'estimate',
    rings: [[[100, 100], [120, 100], [120, 120], [100, 120]]],
  };

  it('女儿墙 0.5–0.8m、比立面深一档；>60m 的楼另有 1–3 个设备盒', () => {
    const lowRoof = roofGeometry([low]);
    lowRoof.computeBoundingBox();
    // 低楼只有 0.5–0.8m 的女儿墙，顶面不会高出楼顶 0.8m。
    expect(lowRoof.boundingBox!.max.y).toBeGreaterThan(low.height + ROOF_PARAPET.minHeight - 0.01);
    expect(lowRoof.boundingBox!.max.y).toBeLessThanOrEqual(low.height + ROOF_PARAPET.maxHeight + 0.01);
    // 顶点色比立面屋顶（0.65/0.70/0.70）深一档。
    expect(ROOF_COLORS.parapet[0]).toBeLessThan(0.65);
    const colors = lowRoof.getAttribute('color');
    for (let i = 0; i < colors.count; i++) expect(colors.getX(i)).toBeLessThan(0.65);
    // 4 条边 ×（外立面 2 三角 + 顶面 2 三角）× 3 顶点 = 48 个顶点，没有设备盒。
    expect(lowRoof.getAttribute('position').count).toBe(48);
    lowRoof.dispose();

    const tallRoof = roofGeometry([tall]);
    tallRoof.computeBoundingBox();
    // 设备盒坐在楼顶：1.2–3.1m 高，所以最高点会超过女儿墙。
    expect(tall.height).toBeGreaterThanOrEqual(ROOF_EQUIPMENT_MIN_HEIGHT);
    expect(tallRoof.boundingBox!.max.y).toBeGreaterThan(tall.height + ROOF_PARAPET.maxHeight);
    expect(tallRoof.boundingBox!.max.y).toBeLessThan(tall.height + 3.2);
    expect(tallRoof.getAttribute('position').count).toBeGreaterThan(48);
    tallRoof.dispose();
  });

  it('确定性：同一 id 两次生成的顶点/颜色逐项相同（不依赖运行时随机）', () => {
    const first = roofGeometry([tall, low]);
    const second = roofGeometry([tall, low]);
    expect([...first.getAttribute('position').array]).toEqual([...second.getAttribute('position').array]);
    expect([...first.getAttribute('color').array]).toEqual([...second.getAttribute('color').array]);
    first.dispose(); second.dispose();
  });

  it('屋顶不进立面批次（立面几何是碰撞源），也不进视觉层清单', () => {
    const data = parseCityData(fixtureRaw({ buildings: [tall, low] }));
    const chunks = facadeChunks(data);
    const roofs = roofGeometry(data.buildings, landmarkProfiles(data));
    expect(hasVertices(roofs)).toBe(true);
    for (const chunk of chunks) {
      // 屋顶是独立几何：立面 chunk 的顶点数与它无关，碰撞（colliderArrays）只吃立面那份。
      expect(chunk.geometry).not.toBe(roofs);
      chunk.geometry.dispose();
    }
    expect(cityLayerParts(data).map(layer => layer.name)).not.toContain('city-roofs');
    roofs.dispose();
    const material = roofMaterial();
    expect(material.vertexColors).toBe(true);
    material.dispose();
  });

  it('收分地标（春笋）：屋顶细节按顶部比例缩，不会悬在塔冠外面', () => {
    const tower: CityBuilding = {
      id: SPRING_BAMBOO.id!, height: SPRING_BAMBOO.height, heightSource: 'ctbuh',
      rings: [[[0, 0], [40, 0], [40, 40], [0, 40]]],
    };
    const data = parseCityData(fixtureRaw({ buildings: [tower], landmarks: [SPRING_BAMBOO] }));
    const roofs = roofGeometry(data.buildings, landmarkProfiles(data));
    roofs.computeBoundingBox();
    // 392.5m 处的水平比例是 0.08：女儿墙外沿必须落在 40m×0.08 + 厚度 的一小圈里。
    const span = roofs.boundingBox!.max.x - roofs.boundingBox!.min.x;
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(40 * 0.08 + ROOF_PARAPET.thickness * 2 + 0.5);
    roofs.dispose();
  });
});

describe('夜间亮窗', () => {
  it('白天 0、夜晚 0.6；切到夜晚的过渡途中就点亮（current 只在过渡结束才变）', () => {
    expect(NIGHT_EMISSIVE_INTENSITY).toBe(0.6);
    expect(windowEmissiveIntensity({ current: 'day', target: null })).toBe(0);
    expect(windowEmissiveIntensity({ current: 'storm', target: null })).toBe(0);
    expect(windowEmissiveIntensity({ current: 'night', target: null })).toBe(NIGHT_EMISSIVE_INTENSITY);
    expect(windowEmissiveIntensity({ current: 'day', target: 'night' })).toBe(NIGHT_EMISSIVE_INTENSITY);
    expect(windowEmissiveIntensity({ current: 'night', target: 'day' })).toBe(NIGHT_EMISSIVE_INTENSITY);
    expect(windowEmissiveIntensity({})).toBe(0);
  });
  it('暖色自发光、emissiveMap 复用颜色 atlas（不多占一张纹理），出厂强度 0', () => {
    const restore = stubCanvasDocument();
    try {
      // 暖色：R > B，不能是冷白或原色。
      const warm = new THREE.Color(NIGHT_WINDOW_EMISSIVE);
      expect(warm.r).toBeGreaterThan(warm.b);
      const material = facadeMaterial('glass', {} as CanvasImageSource, 'cool');
      expect(material.emissiveMap).toBe(material.map);
      expect(material.emissive.getHex()).toBe(NIGHT_WINDOW_EMISSIVE);
      expect(material.emissiveIntensity).toBe(0);
      const maps = new Set([material.map, material.normalMap, material.roughnessMap, material.metalnessMap]);
      material.dispose();
      maps.forEach(map => map?.dispose());
    } finally {
      restore();
    }
  });
  it('原房间光照预设不被夜间亮窗改动', () => {
    expect(LIGHTING_PRESETS.night!.background).toBe(0x080a10);
    expect(CITY_LIGHTING.night!.background).toBe(0x101d32);
    expect(CITY_LIGHTING.night).not.toBe(LIGHTING_PRESETS.night);
    expect(CITY_LIGHTING.night!.fog.far).toBeLessThan(CITY_LIGHTING.day!.fog.far);
  });
});

describe('远山剪影', () => {
  const nanshanBounds: [number, number, number, number] = [-2571.85, -2768.44, 2571.85, 2768.44];
  /** 山脊顶点（不含山脚以下的地坪）必须在城市 bounds 之外，且低于春笋。 */
  function ridgeFacts(bounds: [number, number, number, number]): { maxY: number; vertices: number; outside: number } {
    const geometry = ridgeGeometry(bounds);
    const position = geometry.getAttribute('position');
    let maxY = -Infinity, outside = 0, ridge = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      maxY = Math.max(maxY, y);
      // 远景地坪（y=-0.25）会铺到城市下面，不参与"必须在 bounds 外"的断言。
      if (Math.abs(y + RIDGE.apronDrop) < 1e-6) continue;
      ridge += 1;
      if (x < bounds[0] || z > bounds[3]) outside += 1;
      else expect.unreachable(`山脊顶点落进城市范围：${x},${y},${z}`);
    }
    expect(geometry.getAttribute('color')).toBeDefined();
    expect(ridge).toBeGreaterThan(0);
    expect(outside).toBe(ridge);
    geometry.dispose();
    return { maxY, vertices: position.count, outside };
  }

  it('南山：南/西一条低模山脊，全部在 bounds 外且低于春笋 392.5m', () => {
    const facts = ridgeFacts(nanshanBounds);
    // 相对城市中心 4.8km（城市 3–5km 外的尺度感）；相对南岸只有 2km —— 因为相机远裁剪面
    // 3500m（main.ts 公共脊柱），再往南山脊会被切掉。这里锁住"能看到"这个下限。
    expect(RIDGE.distance).toBeGreaterThanOrEqual(1500);
    expect(nanshanBounds[3] + RIDGE.distance).toBeGreaterThanOrEqual(3000);
    expect(nanshanBounds[3] + RIDGE.distance).toBeLessThanOrEqual(5000);
    expect(facts.maxY).toBeGreaterThan(RIDGE.minHeight);
    expect(facts.maxY).toBeLessThanOrEqual(RIDGE.maxHeight + 0.001);
    expect(facts.maxY).toBeLessThan(392.5);
    // 出生点到山脊的距离必须 < 相机远裁剪面，否则"建了但看不见"。
    const data = parseCityData(nanshanRaw());
    const toRidge = Math.hypot(data.spawn[0] - data.spawn[0], data.spawn[2] - (nanshanBounds[3] + RIDGE.distance));
    expect(toRidge).toBeLessThan(3500);
  });
  it('换一套 bounds 仍然成立（不写死南山坐标）；材质受雾、不绑反射', () => {
    const futianBounds: [number, number, number, number] = [-1023, -1111, 1044, 1097];
    const facts = ridgeFacts(futianBounds);
    expect(facts.maxY).toBeLessThan(392.5);
    const material = ridgeMaterial();
    expect(material.fog).toBe(true);
    expect(material.vertexColors).toBe(true);
    expect((material as THREE.Material).name).toBe('city-ridges');
    material.dispose();
  });
});

describe('街树尺寸', () => {
  it('整体缩到原来的约 0.82：冠半径 / 冠高 / 干高都小了，冠底仍高过 2m', () => {
    expect(STREET_KIT.tree.crownRadius).toBeCloseTo(1.75, 2);
    expect(STREET_KIT.tree.crownRadius).toBeLessThan(2.1 * 0.85);
    expect(STREET_KIT.tree.crownHeight).toBeLessThan(4.6 * 0.85);
    expect(STREET_KIT.tree.trunkHeight).toBeLessThan(3.4 * 0.85);
    // 钻得过但不穿模：冠底（冠中心 - 冠半径×0.78）必须 > 2m。
    expect(STREET_KIT.tree.crownHeight - STREET_KIT.tree.crownRadius * 0.78).toBeGreaterThan(2);
  });
});

describe('立面色调分桶', () => {
  it('三个色调变体都存在，同 id 稳定', () => {
    expect(Object.keys(FACADE_TINTS).sort()).toEqual(['cool', 'silver', 'teal']);
    const ids = ['way/1', 'way/2', 'way/3', 'way/4', 'way/5', 'way/6'];
    expect(new Set(ids.map(facadeTint))).toEqual(new Set(['cool', 'teal', 'silver']));
    for (const id of ids) expect(facadeTint(id)).toBe(facadeTint(id));
  });
  it('福田按 id 稳定分桶，draw call ≤36，碰撞顶点逐项等于渲染顶点', () => {
    const data = parseCityData(raw());
    const first = facadeChunks(data), second = facadeChunks(data);
    expect(first.length).toBeLessThanOrEqual(36);
    const keys = (chunks: ReturnType<typeof facadeChunks>) => chunks.map(chunk => `${chunk.style}:${chunk.tint}`).sort();
    expect(keys(second)).toEqual(keys(first));
    expect(new Set(first.map(chunk => chunk.style)).size).toBe(3);
    expect(new Set(first.map(chunk => chunk.tint)).size).toBe(3);
    for (const chunk of [...first, ...second]) {
      const { vertices, indices } = colliderArrays(chunk.geometry);
      expect(vertices).toEqual(chunk.geometry.getAttribute('position').array);
      expect(indices.length % 3).toBe(0);
      chunk.geometry.dispose();
    }
  });
  it('真实南山的立面分块也稳定且 ≤36', () => {
    const data = parseCityData(nanshanRaw());
    const chunks = facadeChunks(data);
    expect(chunks.length).toBeLessThanOrEqual(36);
    expect(new Set(chunks.map(chunk => `${chunk.style}:${chunk.tint}`)).size).toBe(chunks.length);
    for (const chunk of chunks) {
      expect(colliderArrays(chunk.geometry).vertices).toEqual(chunk.geometry.getAttribute('position').array);
      chunk.geometry.dispose();
    }
  });
});

describe('街道层：人行道与低模车', () => {
  const roads: CityData['roads'] = [
    { id: 'way/long', width: 14, walkway: false, points: [[-200, -40], [200, -40]] },
    { id: 'way/cross', width: 10, walkway: false, points: [[-40, -200], [-40, 200]] },
    { id: 'way/foot', width: 2, walkway: true, points: [[0, 0], [100, 0]] },
  ];
  /** 12 条平行主干道 + 两栋远离车道的楼：候选足够，按契约取 10 辆。 */
  const manyRoads: CityData['roads'] = Array.from({ length: 12 }, (_, index) => ({
    id: `way/main-${index}`, width: 10, walkway: false,
    points: [[-200, -220 + index * 40], [200, -220 + index * 40]] as Point2[],
  }));
  const farBuildings: CityBuilding[] = [
    { id: 'far-a', height: 80, heightSource: 'estimate', rings: [[[-280, -280], [-240, -280], [-240, -260], [-280, -260]]] },
    { id: 'far-b', height: 60, heightSource: 'estimate', rings: [[[240, 260], [280, 260], [280, 280], [240, 280]]] },
  ];
  it('沿车行道两侧生成 1.2–1.8m 浅灰条带，法线朝上', () => {
    expect(sidewalkWidth('any-id')).toBeGreaterThanOrEqual(1.2);
    expect(sidewalkWidth('any-id')).toBeLessThanOrEqual(1.8);
    const geometry = sidewalkGeometry(roads);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(geometry.getAttribute('normal').getY(0)).toBeGreaterThan(0.9);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) expect(position.getY(i)).toBeCloseTo(SIDEWALK_HEIGHT, 5);
    geometry.dispose();
    // 步道本身不重复铺人行道。
    expect(hasVertices(sidewalkGeometry([{ id: 'way/foot', width: 2, walkway: true, points: [[0, 0], [10, 0]] }]))).toBe(false);
  });
  it('低模车沿主要道路静态摆放 8–12 辆，两个盒子合并成一个 mesh', () => {
    const data = parseCityData(fixtureRaw({ roads: manyRoads, buildings: farBuildings }));
    const placements = carPlacements(data);
    expect(placements.length).toBe(10);
    expect(placements.length).toBeGreaterThanOrEqual(8);
    expect(placements.length).toBeLessThanOrEqual(12);
    expect(placements.length).toBeLessThanOrEqual(CAR_COUNT);
    const geometry = carGeometry(data);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    const material = carMaterial();
    expect(material.vertexColors).toBe(true);
    material.dispose(); geometry.dispose();
  });
  it('城市视觉图层有名称且不参与碰撞（空道路返回空）', () => {
    const data = parseCityData(fixtureRaw({ roads: manyRoads, buildings: farBuildings }));
    const layers = cityLayerParts(data);
    expect(layers.map(layer => layer.name)).toEqual(['city-sidewalks', 'city-cars']);
    expect(cityLayerParts(parseCityData(fixtureRaw()))).toHaveLength(0);
    for (const layer of layers) {
      expect('collision' in layer).toBe(false);
      expect(hasVertices(layer.geometry)).toBe(true);
      layer.geometry.dispose();
    }
  });
  it('真实南山：water / shore / sidewalks / cars 四个视觉层都在，车 8–12 辆', () => {
    const data = parseCityData(nanshanRaw());
    const layers = cityLayerParts(data);
    expect(layers.map(layer => layer.name).sort()).toEqual(['city-cars', 'city-shore', 'city-sidewalks', 'city-water']);
    for (const layer of layers) expect(hasVertices(layer.geometry)).toBe(true);
    const placements = carPlacements(data);
    expect(placements.length).toBeGreaterThanOrEqual(8);
    expect(placements.length).toBeLessThanOrEqual(12);
    layers.forEach(layer => layer.geometry.dispose());
  });
});

describe('南山数据边界', () => {
  it('加载南山样区：12,194 建筑 / 4,558 道路，春笋是唯一核验地标', () => {
    const data = parseCityData(nanshanRaw());
    expect(data.buildings.length).toBe(12194);
    expect(data.roads.length).toBe(4558);
    // 南山用 landmarks[]（多核验地标写法）；单数 landmark 字段必须不存在，避免信息卡只认一个。
    expect(data.landmark).toBeUndefined();
    const verified = data.buildings.filter(b => b.heightSource === 'ctbuh');
    expect(verified).toHaveLength(1);
    expect(verified[0]!.height).toBeCloseTo(392.5, 1);
    expect(data.landmarks).toHaveLength(1);
    expect(data.landmarks![0]!.id).toBe(verified[0]!.id);
    expect(data.landmarks![0]!.name).toContain('春笋');
    expect(data.water!.rings).toHaveLength(1);
    expect(data.water!.level).toBeCloseTo(-0.1, 5);
    expect(data.street.placements).toHaveLength(40);
  });
  it('南山出生点在 bounds 内，距最近建筑轮廓 >2m 且不在任何建筑内部', () => {
    const data = parseCityData(nanshanRaw());
    const [x, , z] = data.spawn;
    expect(x).toBeGreaterThan(data.bounds[0]);
    expect(x).toBeLessThan(data.bounds[2]);
    expect(z).toBeGreaterThan(data.bounds[1]);
    expect(z).toBeLessThan(data.bounds[3]);
    let nearest = Infinity;
    for (const building of data.buildings) nearest = Math.min(nearest, distanceToBuilding(building, x, z));
    expect(nearest).toBeGreaterThan(2);
    expect(data.buildings.filter(b => insideRing(b.rings[0]!, x, z))).toHaveLength(0);
  });
  it('南山 CityScene：地面块 ≤128m，建筑分块 ≤4 且碰撞顶点逐项等于渲染顶点', () => {
    const data = parseCityData(nanshanRaw());
    const city = new CityScene(data, undefined, 'nanshan');
    expect(city.sceneKey).toBe('nanshan');
    expect(city.room.name).toBe(data.name);
    expect(city.room.spawn[0]).toEqual(data.spawn);
    expect(() => parseRoom(city.room)).not.toThrow();
    expect(city.room.static.filter(s => s.mat === 'floor')).not.toHaveLength(0);
    expect(city.room.static.filter(s => s.mat === 'floor')
      .every(s => s.type === 'box' && s.size[0] <= 128 && s.size[2] <= 128)).toBe(true);
    const geometries = buildingChunks(data);
    expect(geometries.length).toBeLessThanOrEqual(4);
    for (const geometry of geometries) {
      const { vertices, indices } = colliderArrays(geometry);
      expect(vertices).toEqual(geometry.getAttribute('position').array);
      expect(indices.length % 3).toBe(0);
      geometry.dispose();
    }
  });
  it('南山街道层来自数据：placements 40（30 树 / 10 灯），铺装仍为空不烘焙', () => {
    const data = parseCityData(nanshanRaw());
    expect(data.street.placements.filter(p => p.kind === 'tree')).toHaveLength(30);
    expect(data.street.placements.filter(p => p.kind === 'lamp')).toHaveLength(10);
    expect(data.street.paving).toHaveLength(0);
    const kit = buildStreetKit(data);
    expect(kit.labels).toHaveLength(0);
    const parts = streetKitParts(kit);
    // 只有树/灯 → 实体网格 + 灯具亮面；没有铺装。
    expect(parts.map(part => part.name)).toEqual(['city-street-kit', 'city-lamp-glow']);
    expect(parts.filter(part => part.collision).map(part => part.name)).toEqual(['city-street-kit']);
    for (const geometry of [kit.paving, kit.solids, kit.lamps]) geometry.dispose();
  });
  it('南山出生点落地后按真实胶囊跑过地板块接缝不下沉', async () => {
    const data = parseCityData(nanshanRaw());
    const city = new CityScene(data);
    const pw = await PhysicsWorld.create(RAPIER, city.room, { propPoolSize: 0 });
    for (const geometry of buildingChunks(data)) {
      const arrays = colliderArrays(geometry);
      bakeTrimesh(RAPIER, pw.world, arrays.vertices, arrays.indices);
      geometry.dispose();
    }
    const character = new CharacterController(RAPIER, pw, data.spawn[0], data.spawn[1] + 0.9, data.spawn[2]);
    let minY = Infinity;
    for (let i = 0; i < 240; i++) {
      character.update({ dirX: 1, dirZ: 1, run: true, jump: false });
      pw.step();
      character.writeTransform(t => { minY = Math.min(minY, t.p[1]); });
    }
    pw.dispose();
    // 南山没有铺装（street.paving=[]），脚下就是 y=0 的地面块；掉下去的只有出生高度差。
    expect(minY).toBeGreaterThan(0.8);
  });
});

describe('空街区与可选字段', () => {
  it('combine 对空零件清单返回空几何而不是 null', () => {
    const kit = buildStreetKit(parseCityData(fixtureRaw()));
    for (const geometry of [kit.paving, kit.solids, kit.lamps]) {
      // mergeGeometries([]) 返回 null；拿到 null 会在 mount 里抛在 new THREE.Mesh 上。
      expect(geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(geometry.getAttribute('position').count).toBe(0);
      expect(hasVertices(geometry)).toBe(false);
      geometry.dispose();
    }
  });
  it('空 street 的 CityScene 构造不抛异常，地面仍是 ≤128m 小块', () => {
    const data: CityData = parseCityData(fixtureRaw());
    const city = new CityScene(data);
    expect(city.sceneKey).toBe('futian');
    expect(city.room.name).toBe('空街 fixture');
    expect(() => parseRoom(city.room)).not.toThrow();
    expect(city.room.static.filter(s => s.mat === 'floor').length).toBeGreaterThan(0);
    // 只有地面块受 128m 约束；四面边界墙本来就是长条（不在这条物理规则里）。
    expect(city.room.static.filter(s => s.mat === 'floor')
      .every(s => s.type === 'box' && s.size[0] <= 128 && s.size[2] <= 128)).toBe(true);
  });
  it('装配清单只含有顶点的零件：空 street 不建 mesh、不烘焙碰撞', () => {
    // mount 本身要 DOM/WebGL（镜头反射、信息卡），node 里不假装渲染；
    // 它遍历的就是 streetKitParts()/cityLayerParts()，所以这里锁"清单为空"这个不变式。
    const parts = streetKitParts(buildStreetKit(parseCityData(fixtureRaw())));
    expect(parts).toHaveLength(0);
    expect(cityLayerParts(parseCityData(fixtureRaw()))).toHaveLength(0);
    const futian = streetKitParts(buildStreetKit(parseCityData(raw())));
    expect(futian.map(part => part.name)).toEqual(['city-paving', 'city-street-kit', 'city-lamp-glow']);
    expect(futian.filter(part => part.collision).map(part => part.name)).toEqual(['city-paving', 'city-street-kit']);
  });
  it('地标竖向构件只在 landmark 存在且能按 id 找回建筑时生成', () => {
    const landmark: CityLandmark = { id: 'fixture-tower', name: '测试塔', height: 200, profile: [[0, 1], [100, 0.5], [200, 0.1]] };
    const withLandmark = buildStreetKit(parseCityData(fixtureRaw({ landmark })));
    expect(withLandmark.solids.getAttribute('position').count).toBeGreaterThan(0);
    const without = buildStreetKit(parseCityData(fixtureRaw()));
    expect(without.solids.getAttribute('position').count).toBe(0);
    // id 对不上就不建：不拿「最近的那栋楼」冒充地标。
    const wrongId = buildStreetKit(parseCityData(fixtureRaw({ landmark: { ...landmark, id: 'way/not-here' } })));
    expect(wrongId.solids.getAttribute('position').count).toBe(0);
    for (const kit of [withLandmark, without, wrongId]) {
      kit.paving.dispose(); kit.solids.dispose(); kit.lamps.dispose();
    }
  });
  it('多核验地标：landmarks[] 里每一条都按自己 profile 建竖向构件，找不到 id 的跳过', () => {
    const second: CityLandmark = { id: 'fixture-block', name: '测试副塔', height: 12, profile: [[0, 1], [12, 0.5]] };
    const missing: CityLandmark = { id: 'way/not-here', name: '不存在', height: 90, profile: [[0, 1], [90, 0.5]] };
    const kit = buildStreetKit(parseCityData(fixtureRaw({ landmarks: [SPRING_BAMBOO, second, missing] })));
    // SPRING_BAMBOO 在 fixture 里没有对应建筑；second 有 → 只有它的构件被建出来。
    expect(kit.solids.getAttribute('position').count).toBeGreaterThan(0);
    const single = buildStreetKit(parseCityData(fixtureRaw({ landmarks: [second] })));
    expect(kit.solids.getAttribute('position').count).toBe(single.solids.getAttribute('position').count);
    kit.paving.dispose(); kit.solids.dispose(); kit.lamps.dispose();
    single.paving.dispose(); single.solids.dispose(); single.lamps.dispose();
  });
  it('没有铺装时街道零件基座落在地面 y=0，有铺装时才抬到 pavingHeight', () => {
    const placement: StreetPlacement = { kind: 'tree', x: 0, z: 0, yaw: 0 };
    const barren = buildStreetKit(parseCityData(fixtureRaw({ placements: [placement] })));
    barren.solids.computeBoundingBox();
    // 南山 paving=[]：树若仍按 0.12 摆放，会整体悬空（数据线报的 bug）。
    expect(barren.solids.boundingBox!.min.y).toBeCloseTo(0, 4);
    const paving: Point2[][][] = [[[[-10, -10], [10, -10], [10, 10], [-10, 10]]]];
    const paved = buildStreetKit(parseCityData(fixtureRaw({ placements: [placement], paving })));
    paved.solids.computeBoundingBox();
    expect(paved.solids.boundingBox!.min.y).toBeCloseTo(0.12, 4);
    // 福田的 placements 落在铺装多边形内 → 基座仍是 0.12。
    // 雨棚立柱与地标竖向构件从 y=0 起，所以先去掉这两类再看街道零件的基座。
    const futianData = parseCityData(raw());
    const futian = buildStreetKit({ ...futianData, landmark: undefined, street: { ...futianData.street, canopy: undefined } });
    futian.solids.computeBoundingBox();
    expect(futian.solids.boundingBox!.min.y).toBeCloseTo(0.12, 4);
    for (const kit of [barren, paved, futian]) {
      kit.paving.dispose(); kit.solids.dispose(); kit.lamps.dispose();
    }
  });
  it('入口雨棚完全来自 data.street.canopy，没有就不建', () => {
    const canopy: CityCanopy = { x: 10, z: -20, width: 9, depth: 12, height: 4.5, label: '测试入口' };
    const withCanopy = buildStreetKit(parseCityData(fixtureRaw({ canopy })));
    expect(withCanopy.labels.map(label => label.text)).toEqual(['测试入口']);
    expect(withCanopy.solids.getAttribute('position').count).toBeGreaterThan(0);
    const without = buildStreetKit(parseCityData(fixtureRaw()));
    expect(without.labels).toHaveLength(0);
    for (const kit of [withCanopy, without]) {
      kit.paving.dispose(); kit.solids.dispose(); kit.lamps.dispose();
    }
  });
  it('路牌文字用 placement.label，缺省用通用词且不写死真实街名', () => {
    const labeled = buildStreetKit(parseCityData(fixtureRaw({ placements: [{ kind: 'sign', x: 0, z: 0, yaw: 0, label: '测试路' }] })));
    expect(labeled.labels.map(label => label.text)).toEqual(['测试路']);
    const generic = buildStreetKit(parseCityData(fixtureRaw({ placements: [{ kind: 'sign', x: 0, z: 0, yaw: 0 }] })));
    expect(generic.labels.map(label => label.text)).toEqual([GENERIC_SIGN_LABEL]);
    for (const text of ['福田', '益田', '平安']) {
      expect(generic.labels.some(label => label.text.includes(text))).toBe(false);
    }
    for (const kit of [labeled, generic]) {
      kit.paving.dispose(); kit.solids.dispose(); kit.lamps.dispose();
    }
  });
  it('信息卡：标题用 data.name，地标说明只在 landmark 存在时写，note 可覆盖', () => {
    const futian = cityInfoText(parseCityData(raw()));
    expect(futian.title).toBe('福田 CBD · 街区原型');
    expect(futian.note).toContain('平安金融中心 599.1m');
    expect(futian.note).toContain('模型估算');
    expect(futian.summary).toContain('1,230');
    const nanshan = cityInfoText(parseCityData(nanshanRaw()));
    expect(nanshan.title).toBe('南山 · 街区原型');
    expect(nanshan.note).not.toContain('平安');
    expect(nanshan.note).not.toContain('599.1');
    expect(nanshan.note).toContain('模型估算');
    // landmarks[] 也要进信息卡：南山的地标是春笋，不是"没有地标"。
    expect(nanshan.note).toContain('春笋');
    expect(nanshan.note).toContain('392.5');
    const bare = cityInfoText(parseCityData(fixtureRaw()));
    expect(bare.note).not.toContain('平安');
    expect(bare.note).not.toContain('599.1');
    const overridden = cityInfoText({ ...parseCityData(fixtureRaw()), note: '自定义说明' });
    expect(overridden.note).toContain('自定义说明');
  });
  it('landmarkScale 对任意曲线插值，不外推', () => {
    const profile = [[0, 1], [100, 0.5], [200, 0.1]] as const;
    expect(landmarkScale(profile, 0)).toBe(1);
    expect(landmarkScale(profile, 50)).toBeCloseTo(0.75);
    expect(landmarkScale(profile, 100)).toBeCloseTo(0.5);
    expect(landmarkScale(profile, 999)).toBeCloseTo(0.1);
    // 旧签名仍按平安曲线走（kit.test.ts 依赖它，别悄悄改语义）
    expect(landmarkScale(0)).toBe(1);
    expect(landmarkScale(599.1)).toBeCloseTo(0.025);
  });
  it('海雾：城市白天预设的雾更远、颜色暖灰，原房间预设不被修改', () => {
    const city = CITY_LIGHTING.day!, room = LIGHTING_PRESETS.day!;
    expect(city.fog.far).toBeGreaterThan(room.fog.far);
    expect(city.fog.color).toBe(0xd8d3c9);
    expect(city.background).toBe(0xc4d0d8);
    expect(room.fog.color).toBe(0x1a2028);
    expect(room.background).toBe(0x1a2028);
    expect(city).not.toBe(room);
  });
});
