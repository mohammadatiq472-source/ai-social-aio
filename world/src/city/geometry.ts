import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityBuilding, CityData, CityRoad, Point2 } from './data';
import { buildingBounds, landmarkScale, PING_AN_ID, PING_AN_PROFILE, type LandmarkProfile } from './landmark';
import { facadeStyle, facadeTint, stableHash, RIDGE_COLOR, type FacadeStyle, type FacadeTint } from './materials';

/**
 * 数据声明的地标 id → 收分曲线。
 *
 * `landmark`（福田单地标写法）与 `landmarks[]`（南山多核验地标）合并；同一 id 先到先得，
 * 不改数据的优先级。**没有任何声明就是空表**，普通建筑照旧是 1 段直筒。
 */
export function landmarkProfiles(data: CityData): Map<string, LandmarkProfile> {
  const profiles = new Map<string, LandmarkProfile>();
  if (data.landmark) profiles.set(data.landmark.id, data.landmark.profile);
  for (const landmark of data.landmarks ?? []) {
    if (!profiles.has(landmark.id)) profiles.set(landmark.id, landmark.profile);
  }
  return profiles;
}

/**
 * 单栋楼的挤出体块。
 *
 * `profile` 是数据给的收分曲线（[高度m, 水平比例]）；不传时保留旧行为：
 * 平安金融中心（`PING_AN_ID`）按 `PING_AN_PROFILE` 收 60 段，其它建筑 1 段。
 * 渲染与碰撞用的是**同一份返回值**，所以两条路径不会各自漂移。
 */
export function buildingGeometry(building: CityBuilding, profile?: LandmarkProfile): THREE.BufferGeometry {
  const paths = building.rings.map(ring => new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
  const outline = new THREE.Shape(paths[0]!.getPoints());
  outline.holes = paths.slice(1);
  // 数据给了曲线就用曲线的；没给才回落到旧的平安 id 判断（福田行为不变）。
  const taper = profile ?? (building.id === PING_AN_ID ? PING_AN_PROFILE : undefined);
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: building.height, bevelEnabled: false, steps: taper ? 60 : 1, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position');
  if (taper) {
    const center = buildingBounds(building);
    for (let i = 0; i < positions.count; i++) {
      const scale = landmarkScale(taper, positions.getY(i));
      positions.setX(i, center.x + (positions.getX(i) - center.x) * scale);
      positions.setZ(i, center.z + (positions.getZ(i) - center.z) * scale);
    }
    geometry.computeVertexNormals();
  }
  const normals = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  const colors = new Float32Array(positions.count * 3);
  const tint = 0.88 + [...building.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 13 / 100;
  for (let i = 0; i < positions.count; i++) {
    const roof = Math.abs(normals.getY(i)) > 0.9;
    uv.setXY(i, roof ? 0 : Math.abs(normals.getX(i)) > Math.abs(normals.getZ(i)) ? positions.getZ(i) : positions.getX(i), roof ? 0 : positions.getY(i));
    colors.set(roof ? [0.65, 0.7, 0.7] : [tint, tint, tint], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.clearGroups();
  return geometry;
}

export interface FacadeChunk {
  geometry: THREE.BufferGeometry;
  style: FacadeStyle;
  tint: FacadeTint;
}

/**
 * 立面分桶：`样式 × 色调`，最多 3×3 = 9 批。
 *
 * 为什么不再按四象限分：色调分桶已经让批次从 3 涨到 9，再叠四象限会到 36 批；
 * 36 批虽然仍在预算内，但**合并成 9 批的 draw call 更少、且每批仍然只有一种材质**。
 * 视锥剔除的粒度换 draw call 数量，这个交易在 2~4km 的城市尺度上是划算的。
 * （`buildingChunks()` 仍保留四象限分桶，给低层几何/碰撞测试用。）
 */
export function facadeChunks(data: CityData): FacadeChunk[] {
  const profiles = landmarkProfiles(data);
  const landmarkIds = new Set(profiles.keys());
  const buckets = new Map<string, { style: FacadeStyle; tint: FacadeTint; parts: THREE.BufferGeometry[] }>();
  for (const building of data.buildings) {
    const style = facadeStyle(building, landmarkIds);
    const tint = facadeTint(building.id);
    const key = `${style}:${tint}`;
    const bucket = buckets.get(key) ?? { style, tint, parts: [] };
    bucket.parts.push(buildingGeometry(building, profiles.get(building.id)));
    buckets.set(key, bucket);
  }
  const chunks: FacadeChunk[] = [];
  for (const { style, tint, parts } of buckets.values()) {
    const geometry = mergeParts(parts);
    if (!hasPositions(geometry)) { geometry.dispose(); continue; }
    chunks.push({ geometry, style, tint });
  }
  return chunks;
}

export function buildingChunks(data: CityData): THREE.BufferGeometry[] {
  const profiles = landmarkProfiles(data);
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  for (const building of data.buildings) {
    const ring = building.rings[0]!;
    const x = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
    const z = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const key = `${x < 0 ? 0 : 1}:${z < 0 ? 0 : 1}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(buildingGeometry(building, profiles.get(building.id)));
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(parts => mergeParts(parts));
}

export function roadGeometry(roads: CityRoad[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const road of roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!;
      const b = road.points[i]!;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      if (length < 0.01) continue;
      const nx = -dz / length * road.width / 2, nz = dx / length * road.width / 2;
      const corners = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz],
        [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
      for (const index of [0, 1, 2, 0, 2, 3]) {
        const p = corners[index]!;
        positions.push(p[0]!, road.walkway ? 0.018 : 0.012, p[1]!);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const uv: number[] = [];
  for (let i = 0; i < positions.length; i += 3) uv.push(positions[i]!, positions[i + 2]!);
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** 人行道抬高 0.035m：高于沥青(0.012)/步道(0.018)，低于铺装顶(0.12)，不参与碰撞。 */
export const SIDEWALK_HEIGHT = 0.035;

/** 人行道宽度 1.2–1.8m：按道路 id 稳定取（同一条路每次一样，不是运行时随机）。 */
export function sidewalkWidth(roadId: string): number {
  return 1.2 + (stableHash(roadId) % 7) * 0.1;
}

/**
 * 道路两侧的人行道条带（合并成一个 mesh）。
 *
 * 只铺**车行道**（`walkway=false` 且宽度 ≥7m）：步道本身就是铺装，再加一条会重叠。
 * 只贴浅灰面、不进碰撞——人行道是视觉层，玩家脚下还是原来的地面/铺装。
 */
export function sidewalkGeometry(roads: CityRoad[]): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [];
  const quad = (a: Point2, b: Point2, c: Point2, d: Point2): void => {
    for (const [x, z] of [a, b, c, a, c, d]) {
      positions.push(x, SIDEWALK_HEIGHT, z);
      uvs.push(x, z);
    }
  };
  for (const road of roads) {
    if (road.walkway || road.width < 7) continue;
    const width = sidewalkWidth(road.id);
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!;
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      if (length < 0.5) continue;
      const nx = -dz / length, nz = dx / length;
      const inner = road.width / 2, outer = inner + width;
      for (const side of [1, -1] as const) {
        const aIn: Point2 = [a[0] + nx * inner * side, a[1] + nz * inner * side];
        const bIn: Point2 = [b[0] + nx * inner * side, b[1] + nz * inner * side];
        const bOut: Point2 = [b[0] + nx * outer * side, b[1] + nz * outer * side];
        const aOut: Point2 = [a[0] + nx * outer * side, a[1] + nz * outer * side];
        // 绕序按边侧翻转，保证法线朝上（否则从上方看是背面，直接消失）。
        // 判据：u×v 的 y 分量 = u_z·v_x − u_x·v_z > 0。
        if (side > 0) quad(aIn, aOut, bOut, bIn);
        else quad(aIn, bIn, bOut, aOut);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** 画在车行道上的车辆数（8–12 辆；候选不足时按实际数量）。 */
export const CAR_COUNT = 10;
const CAR_SURFACE = 0.012;
const CAR_COLORS = [0xb9c2c7, 0x2f3d4a, 0x8a2f2f, 0xd8d8d2, 0x35505e, 0x7a7f86];

export interface CarPlacement {
  x: number;
  z: number;
  yaw: number;
  color: number;
}

function distanceToSegment(px: number, pz: number, a: Point2, b: Point2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / lengthSq));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

interface BuildingBox { minX: number; maxX: number; minZ: number; maxZ: number }

/** 一次预处理所有建筑的包围盒：车辆净空检查要扫几百个候选 × 几千栋楼，不能每次都重算轮廓。 */
function buildingBoxes(buildings: CityBuilding[]): BuildingBox[] {
  return buildings.map(building => {
    const ring = building.rings[0]!;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    return { minX, maxX, minZ, maxZ };
  });
}

/** 车心到最近建筑轮廓的净空是否足够（包围盒粗筛 + 只在附近算精确距离）。 */
function clearOfBuildings(buildings: CityBuilding[], boxes: BuildingBox[], x: number, z: number, clearance: number): boolean {
  for (let index = 0; index < buildings.length; index++) {
    const box = boxes[index]!;
    if (x < box.minX - clearance || x > box.maxX + clearance || z < box.minZ - clearance || z > box.maxZ + clearance) continue;
    for (const ring of buildings[index]!.rings) {
      for (let i = 0; i < ring.length; i++) {
        if (distanceToSegment(x, z, ring[i]!, ring[(i + 1) % ring.length]!) <= clearance) return false;
      }
    }
  }
  return true;
}

/**
 * 静态低模车的位置：只挑车行道里最长的路段中点，按 id 排序后等距取 `count` 辆。
 *
 * 不随机、不逐帧更新。车心离最近楼墙至少 `半路宽 + 4m`，避免车头插进建筑；
 * 水面/超出 bbox 的路段不在候选里（道路本身已裁到 bbox，海面在 bbox 之外）。
 * `count` 可覆盖：整城（单 JSON）取 10 辆，瓦片如果想按片撒车就传 1–2。
 */
export function carPlacements(data: CityData, count = CAR_COUNT): CarPlacement[] {
  const candidates: { id: string; x: number; z: number; yaw: number }[] = [];
  const boxes = buildingBoxes(data.buildings);
  for (const road of data.roads) {
    if (road.walkway || road.width < 10) continue;
    let best = { length: 0, x: 0, z: 0, yaw: 0 };
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!;
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      if (length <= best.length) continue;
      best = { length, x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, yaw: Math.atan2(dx, dz) };
    }
    if (best.length < 40) continue;
    if (!clearOfBuildings(data.buildings, boxes, best.x, best.z, road.width / 2 + 4)) continue;
    candidates.push({ id: road.id, x: best.x, z: best.z, yaw: best.yaw });
  }
  // 按 id 排：id 是 OSM 实体编号，稳定且与文件顺序无关。
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pick = Math.min(count, candidates.length);
  if (!pick) return [];
  const step = candidates.length / pick;
  const placements: CarPlacement[] = [];
  for (let i = 0; i < pick; i++) {
    const candidate = candidates[Math.floor(i * step)]!;
    placements.push({ x: candidate.x, z: candidate.z, yaw: candidate.yaw, color: CAR_COLORS[i % CAR_COLORS.length]! });
  }
  return placements;
}

function paint(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** 车身 + 车顶两个盒子的低模车，全部合并成一个静态 mesh；不参与碰撞。 */
export function carGeometry(data: CityData, count = CAR_COUNT): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const placement of carPlacements(data, count)) {
    const body = paint(new THREE.BoxGeometry(1.85, 0.62, 4.3).translate(0, CAR_SURFACE + 0.18 + 0.31, 0), placement.color);
    const roofColor = new THREE.Color(placement.color).multiplyScalar(0.82).getHex();
    const roof = paint(new THREE.BoxGeometry(1.6, 0.5, 2.4).translate(0, CAR_SURFACE + 0.18 + 0.62 + 0.25, -0.2), roofColor);
    for (const part of [body, roof]) {
      part.rotateY(placement.yaw);
      part.translate(placement.x, 0, placement.z);
      parts.push(part);
    }
  }
  return mergeParts(parts);
}

/**
 * 水面多边形（局部坐标，米）。
 *
 * `rings` 每个环是一个填充多边形；逐环绕序归一到逆时针后再三角化，
 * 这样 ShapeGeometry 法线一定朝上（朝下会在 FrontSide 材质上直接消失）。
 * 只渲染，不产生碰撞几何。
 */
export function waterGeometry(rings: Point2[][], level = -0.1): THREE.BufferGeometry {
  const shapes = rings.filter(ring => ring.length >= 3).map(ring => {
    const points = ring.map(([x, z]) => new THREE.Vector2(x, -z));
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      area += a.x * b.y - b.x * a.y;
    }
    if (area < 0) points.reverse();
    return new THREE.Shape(points);
  });
  if (!shapes.length) return emptyGeometry();
  const geometry = new THREE.ShapeGeometry(shapes);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, level, 0);
  const positions = geometry.getAttribute('position'), uvs = geometry.getAttribute('uv');
  for (let i = 0; i < positions.count; i++) uvs.setXY(i, positions.getX(i), positions.getZ(i));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// ───────────────────────────── 岸线泡沫/沙线 ─────────────────────────────

/** 岸线亮带宽度（米）：从水岸往水里铺，太长会变成"河堤"，太短看不见。 */
export const SHORE_WIDTH = 7;
/** 亮带比水面高 0.02m：共面会 z-fighting，抬一点又不会被看成台阶。 */
export const SHORE_LIFT = 0.02;

/**
 * 岸线泡沫/沙线：沿每个水环的内侧铺一条亮带（纯色几何，不用贴图）。
 *
 * 为什么逐边铺四边形而不是"往内缩一圈的环"：水环可能自交/凹进（OSM 岸线），
 * 环的向内偏移会翻折；逐边 + 顶点补一块三角形，任何形状都不会裂开。
 * 内侧方向由水环绕序决定（与 `waterGeometry` 同一套 (x,-z) 逆时针约定）。
 */
export function shoreGeometry(rings: Point2[][], level = -0.1, width = SHORE_WIDTH): THREE.BufferGeometry {
  const positions: number[] = [];
  /**
   * 朝上的三角形：绕序按几何法线判一次，保证 FrontSide 从上往下看是正面。
   * 手写顺序很容易在某条边上反掉，整条带子就"消失"（背面剔除）——比性能更值得防。
   */
  const triangle = (a: Point2, b: Point2, c: Point2, y: number): void => {
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const order = cross < 0 ? [a, c, b] : [a, b, c];
    for (const [x, z] of order) positions.push(x, y, z);
  };
  const y = level + SHORE_LIFT;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const points = ring.map(([x, z]) => new THREE.Vector2(x, -z));
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      area += a.x * b.y - b.x * a.y;
    }
    if (area < 0) points.reverse();
    // 关键：几何顶点必须用**归一化后**的环。反向后的 points 与原始 ring 下标不同，
    // 混用会让法线与顶点错位（带子跑到岸外）。
    const outline: Point2[] = points.map(point => [point.x, -point.y]);
    const normals: Point2[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      // (x,-z) 平面里逆时针多边形的左侧是内部；换回 XZ 后内法线 = (dz, -dx)，其中 dz=-dv。
      const dx = b.x - a.x, dv = b.y - a.y, length = Math.hypot(dx, dv) || 1;
      normals.push([-dv / length, -dx / length]);
    }
    for (let i = 0; i < points.length; i++) {
      const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue;
      const n = normals[i]!;
      const aIn: Point2 = [a[0] + n[0] * width, a[1] + n[1] * width];
      const bIn: Point2 = [b[0] + n[0] * width, b[1] + n[1] * width];
      triangle(a, b, bIn, y);
      triangle(a, bIn, aIn, y);
      // 转角补片：在下一条边的起点 b 用"下一条边的内法线"再内移一段。
      // 两条边的内移带各自是平行条，转角处会留一个缺口；补片把缺口填上，且不会伸出水环。
      const m = normals[(i + 1) % normals.length]!;
      const corner: Point2 = [b[0] + m[0] * width, b[1] + m[1] * width];
      triangle(b, bIn, corner, y);
    }
  }
  if (!positions.length) return emptyGeometry();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

// ───────────────────────────── 远山剪影 + 远景地坪 ─────────────────────────────

/**
 * 远山参数。**相对城市 bounds 计算，不写死任何街区坐标**（换街区/换城市照旧成立）。
 *
 * 高度上限 260m 是有意的：春笋 392.5m 是唯一核验地标，远山不能把它压掉。
 *
 * 距离 2000m 而不是"边界外 3–5km"：**相机远裁剪面是 6000m**（`main.ts` 公共脊柱里
 * `camera.camera.far = 6000`）。南山 5.5km 南北，山脚再往外 3km 会离出生点 4.1km；
 * 取 2000m 后：南山南岸（水面尽头 z=4768）正好接山脚，从出生点看约 2.9km，
 * 相对**城市中心**仍是 4.8km（符合"城市 3–5km 外"的尺度感）。
 */
export const RIDGE = {
  /** 山脚离城市边界多远（米）。见上面为什么是 2000 而不是 3000+。 */
  distance: 2000,
  /** 山脚到山脊顶点的后退（米）：给剪影一点坡度，不是一堵竖墙。 */
  slope: 260,
  /** 山脊高度区间（米）。 */
  minHeight: 90,
  maxHeight: 260,
  /** 沿南/西边界的分段数。 */
  segments: 56,
  /** 远景地坪（补掉"水面尽头与山脚之间"的空白）比水面低这么多米。 */
  apronDrop: 0.25,
} as const;

/**
 * 山脊高度：沿折线位置 t（0..1）的**平滑**起伏。
 *
 * 为什么不是每个顶点各取一次 hash：那样得到的是"锯齿梳子"，远看像一堵碎掉的高墙；
 * 山脊是低频起伏，用两个正整数频率的正弦叠加（相位由固定常量给，不依赖场景），
 * 再叠 5% 的 hash 细节，才有"山"的轮廓而不失确定性。
 */
function ridgeHeight(t: number, options: typeof RIDGE): number {
  const broad = Math.sin(t * Math.PI * 3.1 + 0.7) * 0.62 + Math.sin(t * Math.PI * 7.7 + 2.1) * 0.38;
  const detail = ((stableHash(`ridge-detail:${Math.round(t * 4096)}`) & 0xff) / 0xff - 0.5) * 0.1;
  const clamped = Math.max(-1, Math.min(1, broad + detail));
  // clipped: 0.5..1 的起伏 → 高度区间；谷底不会压到 0（那一带是海湾/滩涂）。
  return options.minHeight + (0.5 + clamped * 0.5) * (options.maxHeight - options.minHeight);
}

/**
 * 城市南/西 3–5km 外的低模山脊（南山/塘朗山剪影）+ 一片远景地坪。
 *
 * 两条硬要求，改这里要同时复查：
 * 1. **只渲染**：不建碰撞、不 bake（`mount` 只把它当视觉层挂在 group 上）；
 * 2. **不挡地标**：山脊全在 `bounds` 之外、最高点 < 春笋，且被雾吃掉（Basic + fog）。
 *
 * 地坪（`apron`）不是装饰：南山的水面只铺到 bounds 南沿外 2km，再往南就是"没有几何"，
 * 不补一层远景地坪，海尽头与山脚之间会露出一条背景色带（看起来像倒置的地平线）。
 */
export function ridgeGeometry(bounds: readonly [number, number, number, number], options: typeof RIDGE = RIDGE): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [];
  const base = new THREE.Color(RIDGE_COLOR);
  /** 顶点色只做很轻的亮度扰动 + 上下渐变；远山靠雾和轮廓，不靠细节。 */
  const tint = (level: number, variation: number): void => {
    colors.push(base.r * level * variation, base.g * level * variation, base.b * level * variation);
  };
  const [minX, minZ, maxX, maxZ] = bounds;
  // ── 远景地坪：南 + 西两个方向各延伸 distance+slope，北/东侧不铺（不凭空造地）。
  const farX = minX - options.distance - options.slope - 400;
  const farZ = maxZ + options.distance + options.slope + 400;
  const apronY = -options.apronDrop;
  const apronEast = maxX + options.distance + 1800;
  const apronNorth = minZ - options.distance - 1800;
  // 地坪只铺在**城市外**（南、西、西南角），不要盖住城市本体：
  // 之前的矩形从 minZ 一直铺到 farZ，等于在整座城市下面又铺了一层 y=-0.25 的板，
  // 鸟瞰时和 ground/water 叠出大片条纹。现在按三个不重叠的四边形铺。
  const apronQuads: [Point2, Point2, Point2, Point2][] = [
    [[minX, maxZ], [apronEast, maxZ], [apronEast, farZ], [minX, farZ]],
    [[farX, apronNorth], [minX, apronNorth], [minX, maxZ], [farX, maxZ]],
    [[farX, maxZ], [minX, maxZ], [minX, farZ], [farX, farZ]],
  ];
  for (const corners of apronQuads) {
    // 绕序让法线朝上（XZ 里 (p1-p0)×(p2-p0) 的 +Y 分量
    // 对应 (x,-z) 逆时针，所以第二个三角要反向写：[0,2,1] 与 [0,3,2]）。
    for (const index of [0, 2, 1, 0, 3, 2]) {
      const [x, z] = corners[index]!;
      positions.push(x, apronY, z);
      tint(0.95, 1);
    }
  }

  // ── 山脊折线：南边由东向西，到西南角后沿西边向北；拐角处连续，不叠两堵墙。
  // 两端各多伸出去 1800m：不然从城东看过去会看到山脊"断掉"的端头（一堵墙的侧边）。
  const southZ = maxZ + options.distance, westX = minX - options.distance;
  const overrun = 1800;
  const path: Point2[] = [];
  const segments = Math.max(8, options.segments);
  const eastEnd = maxX + options.distance + overrun, northEnd = minZ - options.distance - overrun;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    path.push([eastEnd - t * (eastEnd - westX), southZ]);
  }
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    path.push([westX, southZ - t * (southZ - northEnd)]);
  }
  const height = path.map((_, index) => ridgeHeight(index / (path.length - 1), options));
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  // 顶点级的"后退"偏移：相邻两段共用同一个顶点，否则每段各按自己的外法线后退，
  // 接缝处会裂出一条条白缝（看起来像山脊被切成一排板子）。
  const tops: Point2[] = path.map(([x, z]) => {
    const length = Math.hypot(x - centerX, z - centerZ) || 1;
    return [x + (x - centerX) / length * options.slope, z + (z - centerZ) / length * options.slope] as Point2;
  });
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!, b = path[i + 1]!;
    const topA = tops[i]!, topB = tops[i + 1]!;
    const ha = height[i]!, hb = height[i + 1]!;
    // 每段两片三角：山脚（贴地坪）→ 山脊顶（后退 slope 米），等价于一条倾斜的剪影。
    const quad: { p: Point2; y: number; variation: number }[] = [
      { p: a, y: -0.5, variation: 0.82 },
      { p: b, y: -0.5, variation: 0.82 },
      { p: topB, y: hb, variation: 1.02 },
      { p: topA, y: ha, variation: 1.02 },
    ];
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const { p, y, variation } = quad[index]!;
      positions.push(p[0], y, p[1]);
      tint(variation, 1);
    }
  }
  if (!positions.length) return emptyGeometry();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

// ───────────────────────────── LOD0 屋顶细节 ─────────────────────────────

/**
 * 女儿墙参数。高度按 `building.id` 稳定取 0.5–0.8m（不是运行时随机）；
 * 厚度 0.28m 只是为了让顶面有一条可见的"帽沿"，不是构造尺寸。
 */
export const ROOF_PARAPET = {
  minHeight: 0.5,
  maxHeight: 0.8,
  thickness: 0.28,
  /** 短于这个长度的墙段不做（碎片轮廓上的 0.3m 小边只会制造破面）。 */
  minEdge: 3,
  /** 轮廓包围盒任一方向小于这个尺寸就不做屋顶细节（太小放不下设备盒）。 */
  minFootprint: 6,
} as const;
/** 超过这个高度的楼才有屋顶设备盒（空调机组/电梯机房/水箱）。 */
export const ROOF_EQUIPMENT_MIN_HEIGHT = 60;
/** 每栋楼最多几个设备盒（1–3，按 id hash）。 */
export const ROOF_EQUIPMENT_MAX = 3;
/** 屋顶细节的顶点色：比立面深一档（立面 roof 面是 0.65/0.70/0.70）。 */
export const ROOF_COLORS = {
  parapet: [0.30, 0.35, 0.38] as const,
  cap: [0.38, 0.43, 0.46] as const,
  equipment: [0.60, 0.65, 0.66] as const,
} as const;

interface RoofBuilder {
  positions: number[];
  normals: number[];
  colors: number[];
}

/**
 * 追加一个三角形，**绕序按期望法线自动纠正**（只写扁平数字，不建 Vector3）。
 *
 * 为什么手写而不是用 BoxGeometry：屋顶细节每栋楼几个小盒，用几何类会留下一堆
 * 临时 BufferGeometry 再合并（属性不一致 + 内存抖动）。一片 1170 栋的瓦片要生成
 * ~2 万个三角形，这里每次分配都会直接变成加载时的卡顿。
 */
function pushTriangle(
  builder: RoofBuilder,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number,
  color: readonly number[],
): void {
  // 几何法线 = (b-a)×(c-a)；与期望法线反向就交换后两个顶点（否则 FrontSide 上看不到）。
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const dot = (e1y * e2z - e1z * e2y) * nx + (e1z * e2x - e1x * e2z) * ny + (e1x * e2y - e1y * e2x) * nz;
  const flip = dot < 0;
  const qx = flip ? cx : bx, qy = flip ? cy : by, qz = flip ? cz : bz;
  const rx = flip ? bx : cx, ry = flip ? by : cy, rz = flip ? bz : cz;
  builder.positions.push(ax, ay, az, qx, qy, qz, rx, ry, rz);
  builder.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  // 颜色按字节存（normalized Uint8）：一张 12k 栋的整城屋顶几何，Float32 颜色要多占 7.5MB。
  const r = Math.round(color[0]! * 255), g = Math.round(color[1]! * 255), b = Math.round(color[2]! * 255);
  builder.colors.push(r, g, b, r, g, b, r, g, b);
}

/** 追加一个凸四边形（扇形三角化：2 个三角），绕序同样自动纠正。 */
function pushQuad(
  builder: RoofBuilder,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  nx: number, ny: number, nz: number,
  color: readonly number[],
): void {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const dot = (e1y * e2z - e1z * e2y) * nx + (e1z * e2x - e1x * e2z) * ny + (e1x * e2y - e1y * e2x) * nz;
  if (dot < 0) {
    // 反向：a→d→c 与 a→c→b 与 a→b→c→d 等价（同一个四边形，绕序相反）。
    pushTriangle(builder, ax, ay, az, dx, dy, dz, cx, cy, cz, nx, ny, nz, color);
    pushTriangle(builder, ax, ay, az, cx, cy, cz, bx, by, bz, nx, ny, nz, color);
    return;
  }
  pushTriangle(builder, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, color);
  pushTriangle(builder, ax, ay, az, cx, cy, cz, dx, dy, dz, nx, ny, nz, color);
}

/** 一个轴对齐盒子（6 面 × 2 三角），给屋顶设备用。 */
function pushBox(builder: RoofBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: readonly number[]): void {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  pushQuad(builder, x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 1, 0, 0, color);
  pushQuad(builder, x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, -1, 0, 0, color);
  pushQuad(builder, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0, color);
  pushQuad(builder, x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1, 0, -1, 0, color);
  pushQuad(builder, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, color);
  pushQuad(builder, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, color);
}

/**
 * LOD0 屋顶细节：女儿墙（每栋楼）+ 屋顶设备盒（>60m 的楼，1–3 个）。
 *
 * 三条边界，动它之前先读：
 * 1. **不参与碰撞**：返回值由 `mount`/`TileStreamer` 单独挂成 `city-roofs` mesh，
 *    绝不放进 `facadeChunks()` 的几何（那份几何会进 `colliderArrays()` → `bakeTrimesh`）。
 * 2. **只给 LOD0**：LOD1 是 600m 外的盒子，加屋顶细节纯属浪费三角形。
 * 3. **确定性**：高度/设备数量/位置全部来自 `stableHash(id)`，同一栋楼每次加载一样。
 *
 * `profiles` 是数据声明的收分曲线（春笋这类地标）：屋顶轮廓必须按顶部比例缩，
 * 否则女儿墙会悬在收分后的塔冠外面。
 */
export function roofGeometry(
  buildings: readonly CityBuilding[],
  profiles?: ReadonlyMap<string, LandmarkProfile>,
): THREE.BufferGeometry {
  const builder: RoofBuilder = { positions: [], normals: [], colors: [] };
  for (const building of buildings) {
    const ring = building.rings[0];
    if (!ring || ring.length < 3 || building.height <= 0) continue;
    // 轮廓绕序统一到 (x,-z) 逆时针：内/外侧方向由绕序决定，混着来会把女儿墙修到楼里去。
    // 这里用扁平 [x, z, ...] 复用同一份点序，避免每栋楼建一遍 Vector2 数组。
    const flat: number[] = [];
    for (const [x, z] of ring) flat.push(x, z);
    let area = 0;
    for (let i = 0; i < flat.length; i += 2) {
      const j = (i + 2) % flat.length;
      // (x,-z) 平面上的有向面积：u=x、v=-z，所以每项是 -x_i*z_j + x_j*z_i。
      area += -flat[i]! * flat[j + 1]! + flat[j]! * flat[i + 1]!;
    }
    if (area < 0) {
      const reversed: number[] = [];
      for (let i = flat.length - 2; i >= 0; i -= 2) reversed.push(flat[i]!, flat[i + 1]!);
      flat.length = 0;
      flat.push(...reversed);
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i]!, z = flat[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (maxX - minX < ROOF_PARAPET.minFootprint || maxZ - minZ < ROOF_PARAPET.minFootprint) continue;
    const top = building.height;
    const scale = profiles?.has(building.id) ? landmarkScale(profiles.get(building.id)!, top) : 1;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const hash = stableHash(building.id);
    const parapet = ROOF_PARAPET.minHeight + (hash % 1000) / 1000 * (ROOF_PARAPET.maxHeight - ROOF_PARAPET.minHeight);
    const thickness = ROOF_PARAPET.thickness;
    for (let i = 0; i < flat.length; i += 2) {
      const j = (i + 2) % flat.length;
      const axRaw = flat[i]!, azRaw = flat[i + 1]!, bxRaw = flat[j]!, bzRaw = flat[j + 1]!;
      // (x,-z) 里的边向量 = (dx, dv) = (bx-ax, -(bz-az))；外法线 XZ = (dv, dx)。
      const dx = bxRaw - axRaw, dv = -(bzRaw - azRaw), length = Math.hypot(dx, dv);
      if (length < ROOF_PARAPET.minEdge) continue;
      const nx = dv / length, nz = dx / length;
      const ax = cx + (axRaw - cx) * scale, az = cz + (azRaw - cz) * scale;
      const bx = cx + (bxRaw - cx) * scale, bz = cz + (bzRaw - cz) * scale;
      const ox = nx * thickness, oz = nz * thickness;
      // 外立面（从街上能看到的"墙帽"）
      pushQuad(builder,
        ax + ox, top, az + oz, bx + ox, top, bz + oz,
        bx + ox, top + parapet, bz + oz, ax + ox, top + parapet, az + oz,
        nx, 0, nz, ROOF_COLORS.parapet);
      // 顶面（从鸟瞰/高处能看到的一条帽沿）
      pushQuad(builder,
        ax, top + parapet, az, ax + ox, top + parapet, az + oz,
        bx + ox, top + parapet, bz + oz, bx, top + parapet, bz,
        0, 1, 0, ROOF_COLORS.cap);
    }
    if (building.height < ROOF_EQUIPMENT_MIN_HEIGHT) continue;
    const count = 1 + (hash >> 11) % ROOF_EQUIPMENT_MAX;
    const width = (maxX - minX) * scale, depth = (maxZ - minZ) * scale;
    for (let i = 0; i < count; i++) {
      const seed = stableHash(`${building.id}#${i}`);
      // 设备盒尺寸按楼顶尺寸收：小楼顶不能放 8m 的机组。
      const sx = Math.min(3 + (seed & 0xf) / 5, Math.max(2, width - 3));
      const sz = Math.min(3 + ((seed >> 4) & 0xf) / 5, Math.max(2, depth - 3));
      const sy = 1.2 + ((seed >> 8) & 0xf) / 8;
      const halfW = (width - sx) / 2, halfD = (depth - sz) / 2;
      const fx = ((seed >> 12) & 0xff) / 0xff, fz = ((seed >> 20) & 0xff) / 0xff;
      const ex = cx + (halfW > 0 ? -halfW + fx * halfW * 2 : 0);
      const ez = cz + (halfD > 0 ? -halfD + fz * halfD * 2 : 0);
      pushBox(builder, ex, top + sy / 2, ez, sx, sy, sz, ROOF_COLORS.equipment);
    }
  }
  if (!builder.positions.length) return emptyGeometry();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(builder.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(builder.colors), 3, true));
  geometry.computeBoundingSphere();
  return geometry;
}

export function emptyGeometry(): THREE.BufferGeometry {
  // mergeGeometries([]) 返回 null；空街区/空水面不能让调用方拿到 null。
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  return geometry;
}

function hasPositions(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  return position !== undefined && position.count > 0;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (!parts.length) return emptyGeometry();
  const merged = mergeGeometries(parts, false);
  parts.forEach(part => part.dispose());
  if (!merged) return emptyGeometry();
  merged.computeBoundingSphere();
  return merged;
}

export function colliderArrays(geometry: THREE.BufferGeometry): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array(geometry.getAttribute('position').array);
  const indices = geometry.index ? new Uint32Array(geometry.index.array) :
    Uint32Array.from({ length: vertices.length / 3 }, (_, index) => index);
  return { vertices, indices };
}
