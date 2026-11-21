import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityBuilding, CityData, CityRoad, CityShell, Point2 } from './data';
import { buildingBounds, landmarkScale, PING_AN_ID, PING_AN_PROFILE, type LandmarkProfile } from './landmark';
import { facadeStyle, facadeTint, stableHash, RIDGE_COLOR, windowSeed, WINDOW_SEED_ATTRIBUTE, WINDOW_SEED_ROOF, type FacadeStyle, type FacadeTint } from './materials';

/**
 * 数据声明的地标 id → 收分曲线。
 *
 * `landmark`（福田单地标写法）与 `landmarks[]`（南山多核验地标）合并；同一 id 先到先得，
 * 不改数据的优先级。**没有任何声明就是空表**，普通建筑照旧是 1 段直筒。
 *
 * 壳体地标（`kind: 'shell'`，如春茧）**没有楼体收分曲线**，不进这张表：
 * 它由 `shellGeometry()` 单独生成，不能被 `buildingGeometry()` 当成塔楼收分。
 */
export function landmarkProfiles(data: CityData): Map<string, LandmarkProfile> {
  const profiles = new Map<string, LandmarkProfile>();
  if (data.landmark?.profile) profiles.set(data.landmark.id, data.landmark.profile);
  for (const landmark of data.landmarks ?? []) {
    if (landmark.profile && !profiles.has(landmark.id)) profiles.set(landmark.id, landmark.profile);
  }
  return profiles;
}

/**
 * 数据声明的壳体（`landmarks[].kind === 'shell'`），同 id 去重、保持数据顺序。
 *
 * 没有声明 = 空表 = 不建壳；壳体是**纯视觉层**，不进 `colliderArrays()`（见 runtime.ts）。
 */
export function shellSpecs(data: CityData): CityShell[] {
  const specs: CityShell[] = [];
  const seen = new Set<string>();
  const declared = [...(data.landmark ? [data.landmark] : []), ...(data.landmarks ?? [])];
  for (const landmark of declared) {
    if (seen.has(landmark.id)) continue;
    seen.add(landmark.id);
    if (landmark.kind === 'shell' && landmark.shell) specs.push(landmark.shell);
  }
  return specs;
}

/** 点是否在壳体平面椭圆内（含边界；`eps` 只吸收浮点误差，不放过真的在壳外的点）。 */
function insideShellPlan(spec: CityShell, x: number, z: number, eps = 1e-6): boolean {
  const dx = (x - spec.center[0]) / spec.radii[0];
  const dz = (z - spec.center[1]) / spec.radii[1];
  return dx * dx + dz * dz <= 1 + eps;
}

/**
 * 壳体覆盖的体量 id（壳内体量）：轮廓整体落在壳体平面椭圆内、且不高于壳顶。
 *
 * **为什么需要这份清单**：壳顶 40m 与两馆 40m 同高，任何"落到地面"的壳面在两馆的
 * 边角处都低于 40m，方盒会从壳里戳出来。地标数据里的说法是"两馆作为壳内体量"，
 * 所以在 LOD0 由**壳体本身**表达这 251 万 m³ 体量，不再重复绘制方盒；
 * 数据/计数/瓦片全部不动，LOD1（600m 外）仍然画盒子（那时不加载壳）。
 */
export function shellCoveredBuildingIds(data: CityData): Set<string> {
  const ids = new Set<string>();
  const shells = shellSpecs(data);
  if (!shells.length) return ids;
  for (const building of data.buildings) {
    for (const spec of shells) {
      if (building.height > spec.height) continue;
      let inside = true;
      for (const ring of building.rings) {
        for (const [x, z] of ring) {
          if (!insideShellPlan(spec, x, z)) { inside = false; break; }
        }
        if (!inside) break;
      }
      if (inside) { ids.add(building.id); break; }
    }
  }
  return ids;
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
  // 逐窗亮的 seed：同一栋楼所有墙面顶点同一个 0..1 hash，屋顶/底面写 -1（永不亮）。
  // 为什么要进几何而不是每栋一个材质：立面按 样式×色调 合并成 9 批，材质是跨楼共享的；
  // 把"哪几扇窗亮"放进顶点属性 + 片元 hash，才能在不动 draw call 的前提下逐楼不同。
  const seeds = new Float32Array(positions.count).fill(windowSeed(building.id));
  const tint = 0.88 + [...building.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 13 / 100;
  for (let i = 0; i < positions.count; i++) {
    const roof = Math.abs(normals.getY(i)) > 0.9;
    uv.setXY(i, roof ? 0 : Math.abs(normals.getX(i)) > Math.abs(normals.getZ(i)) ? positions.getZ(i) : positions.getX(i), roof ? 0 : positions.getY(i));
    colors.set(roof ? [0.65, 0.7, 0.7] : [tint, tint, tint], i * 3);
    if (roof) seeds[i] = WINDOW_SEED_ROOF;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute(WINDOW_SEED_ATTRIBUTE, new THREE.BufferAttribute(seeds, 1));
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
  // 壳内体量在 LOD0 由壳体表达（见 `shellCoveredBuildingIds`）：这里跳过它们的方盒，
  // 但 buildings[]/counts 一个不动，LOD1 的 `lod1Geometry()` 也照旧画盒子。
  const covered = shellCoveredBuildingIds(data);
  const buckets = new Map<string, { style: FacadeStyle; tint: FacadeTint; parts: THREE.BufferGeometry[] }>();
  for (const building of data.buildings) {
    if (covered.has(building.id)) continue;
    const style = facadeStyle(building, landmarkIds);
    const tint = facadeTint(building.id);
    const key = `${style}:${tint}`;
    const bucket = buckets.get(key) ?? { style, tint, parts: [] };
    bucket.parts.push(buildingGeometry(building, profiles.get(building.id)));
    buckets.set(key, bucket);
  }
  const chunks: FacadeChunk[] = [];
  for (const { style, tint, parts } of buckets.values()) {
    if (!parts.length) continue;
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

/**
 * 把一组静态车（位置/朝向/颜色）合并成一个几何：车身 + 车顶两个盒子，每辆 24 三角。
 *
 * 单 JSON 路径一次给 10 辆；瓦片路径由 `TileStreamer` 收集**已加载 LOD0 片**的候选后
 * 调这个函数，全局仍然只有 **1 个 `city-cars` mesh**（不是每片 +1 批，否则 9 片会到 126）。
 */
export function carGeometryFromPlacements(placements: readonly CarPlacement[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const placement of placements) {
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

/** 车身 + 车顶两个盒子的低模车，全部合并成一个静态 mesh；不参与碰撞。 */
export function carGeometry(data: CityData, count = CAR_COUNT): THREE.BufferGeometry {
  return carGeometryFromPlacements(carPlacements(data, count));
}

// ───────────────────────────── 程序化壳体（春茧） ─────────────────────────────

/**
 * 壳体网格参数。壳体本身的中心/半径/高度来自数据（`CityLandmark.shell`），
 * 这里只放"怎么分格、肋条多粗"的程序化参数——换街区/换地标不用改代码。
 */
export const SHELL = {
  /** 环向分段（θ）：128 段在 350m 壳上约 9m 一段。 */
  segments: 128,
  /** 径向分段（v 从壳顶到壳沿）。 */
  rings: 24,
  /** 每族肋条数默认 28 → 两族共 56 条交叉成菱形网格。 */
  ribs: 28,
  /** 肋条截面：宽 0.9m、厚 0.5m。远景里细于 0.5m 的肋条会糊进面板。 */
  ribWidth: 0.9,
  ribThickness: 0.5,
  /** 肋条整体外移：共面会 z-fighting，浮起来才像"肋"而不是画在膜上的线。 */
  ribLift: 0.28,
  /** 肋条折线步长（米）：12m 一段在 350m 壳上看不出棱角，也不把三角形堆满。 */
  ribStep: 12,
  /** 两瓣之间的凹槽：深度按壳顶比例、半宽按 rx 比例（0.24 ≈ 43m 宽的浅槽）。 */
  valleyDepth: 0.28,
  valleyWidth: 0.24,
  /** 法线用有限差分（米）；斜率上限（≈80°）挡住壳沿的无穷梯度。 */
  normalStep: 1.5,
  normalMaxSlope: 6,
} as const;

/**
 * 凹槽系数让壳面矮了 `(1 - valleyDepth)`：这里求"高度因子"的实际最大值，
 * 用它把整片壳归一——**数据里的 `height` 就是真实壳顶高度**，而不是一个被凹槽
 * 偷偷削掉 20% 的名义值。
 *
 * 为什么最大值一定落在 z=0 那条线上：凹槽只随 x 变化，固定 dx 时
 * `√(1-v²)` 在 dz=0 取最大；所以对 u=dx/rx 采样 200 点即可（只算一次）。
 */
const SHELL_CREST = ((): number => {
  let max = 0;
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const factor = Math.sqrt(Math.max(0, 1 - u * u)) *
      (1 - SHELL.valleyDepth * Math.exp(-((u / SHELL.valleyWidth) ** 2)));
    if (factor > max) max = factor;
  }
  return max;
})();

/**
 * 壳面高度（米）。`v² = ((x-cx)/rx)² + ((z-cz)/rz)²`：
 *
 * - `y = H·√(1-v²)`：椭球的**上半壳**，壳沿 y=0（不是球、也不是半球盖在地面上）；
 * - 再乘一条沿 x 的浅凹槽：把"两馆"读成**两瓣相连**，而不是一个大圆包。
 *   凹槽是连续函数（高斯），所以壳面没有折痕，肋条跨过去也是平滑的；
 * - 最后按 `SHELL_CREST` 归一：壳顶（两瓣的脊）正好等于 `height`，凹槽处的鞍部约 0.8H。
 *
 * `v ≥ 1` 返回 0：调用方拿到的点一定在 y≥0 的上半壳里。
 */
export function shellHeightAt(spec: CityShell, x: number, z: number): number {
  const dx = (x - spec.center[0]) / spec.radii[0];
  const dz = (z - spec.center[1]) / spec.radii[1];
  const v2 = dx * dx + dz * dz;
  if (v2 >= 1) return 0;
  const valley = 1 - SHELL.valleyDepth * Math.exp(-((dx / SHELL.valleyWidth) ** 2));
  return spec.height * Math.sqrt(1 - v2) * valley / SHELL_CREST;
}

/**
 * 壳面法线（**朝外朝上**）：高度场 `y = h(x,z)` 的梯度方向。
 *
 * 为什么用有限差分而不是解析式：凹槽是高斯、壳沿是 √ 的无穷梯度，解析式要分好几段；
 * 差分只要 4 次取值，且斜率上限天然把壳沿的奇点压住（否则壳沿法线会是 NaN）。
 */
function shellNormalAt(spec: CityShell, x: number, z: number, out: [number, number, number]): void {
  const step = SHELL.normalStep;
  let gx = (shellHeightAt(spec, x + step, z) - shellHeightAt(spec, x - step, z)) / (2 * step);
  let gz = (shellHeightAt(spec, x, z + step) - shellHeightAt(spec, x, z - step)) / (2 * step);
  const slope = Math.hypot(gx, gz);
  if (slope > SHELL.normalMaxSlope) {
    const k = SHELL.normalMaxSlope / slope;
    gx *= k; gz *= k;
  }
  const length = Math.hypot(gx, 1, gz);
  out[0] = -gx / length; out[1] = 1 / length; out[2] = -gz / length;
}

/**
 * 壳体面板：极点扇形 + 环带四边形，索引化、**平滑法线**、无 uv（材质是纯色半透明）。
 *
 * 为什么是椭圆极坐标而不是高度场方格：壳沿必须正好落在数据给的椭圆上（方格会在
 * 壳沿留锯齿）；壳顶退化成一个点，用扇形收口比一堆退化四边形干净。
 */
export function shellPanelGeometry(spec: CityShell): THREE.BufferGeometry {
  const { segments, rings } = SHELL;
  const [cx, cz] = spec.center;
  const [rx, rz] = spec.radii;
  const positions: number[] = [], normals: number[] = [];
  const normal: [number, number, number] = [0, 1, 0];
  const push = (x: number, y: number, z: number): number => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    shellNormalAt(spec, x, z, normal);
    normals.push(normal[0], normal[1], normal[2]);
    return index;
  };
  const ringStart: number[] = [];
  const apex = push(cx, shellHeightAt(spec, cx, cz), cz);
  for (let j = 1; j <= rings; j++) {
    ringStart[j] = positions.length / 3;
    const v = j / rings;
    for (let i = 0; i < segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const x = cx + rx * v * Math.cos(theta);
      const z = cz + rz * v * Math.sin(theta);
      push(x, shellHeightAt(spec, x, z), z);
    }
  }
  const at = (j: number, i: number): number => ringStart[j]! + (i % segments);
  const index: number[] = [];
  for (let i = 0; i < segments; i++) index.push(apex, at(1, i), at(1, i + 1));
  for (let j = 1; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      index.push(at(j, i), at(j, i + 1), at(j + 1, i + 1), at(j, i), at(j + 1, i + 1), at(j + 1, i));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * 一条肋条在椭圆平面里的位置：`sign` 是族（+1 斜向 `/`、−1 斜向 `\`），
 * `s` 是法向偏移（米），`t0/t1` 是沿线方向的起止参数（米）。
 */
export interface ShellRibSpan {
  sign: 1 | -1;
  s: number;
  t0: number;
  t1: number;
}

/**
 * 把两条 ±45° 的等值线族裁到椭圆平面里（纯数学，可单独断言）。
 *
 * 直线 `(dx ± dz)/√2 = s` 与椭圆 `(dx/rx)²+(dz/rz)²=1` 联立得到一元二次方程：
 * `A·t² + B·t + C = 0`，`A = 1/(2rx²)+1/(2rz²)`、`B = s·(1/rx²−1/rz²)`、`C = s²A−1`。
 * 两族的 A/B 相同，差别只在切向/法向，所以先算一次再各建一遍几何。
 * 判别式 ≤0 或弦长 <6m 的线直接丢掉（退化成切点的线只会留一个点，画不出肋）。
 */
export function shellRibSpans(spec: CityShell): ShellRibSpan[] {
  const ribs = Math.max(2, Math.round(spec.ribs ?? SHELL.ribs));
  const [rx, rz] = spec.radii;
  const halfSpan = Math.hypot(rx, rz) * Math.SQRT1_2;
  const quadraticA = 0.5 / (rx * rx) + 0.5 / (rz * rz);
  const quadraticB = 1 / (rx * rx) - 1 / (rz * rz);
  const spans: ShellRibSpan[] = [];
  const step = 2 * halfSpan / ribs;
  for (const sign of [1, -1] as const) {
    for (let k = 0; k < ribs; k++) {
      // 0.5 偏移：避免 s=±halfSpan 的退化切线（只在椭圆上切一个点）。
      const s = -halfSpan + (k + 0.5) * step;
      const b = s * quadraticB;
      const c = s * s * quadraticA - 1;
      const discriminant = b * b - 4 * quadraticA * c;
      if (discriminant <= 0) continue;
      const root = Math.sqrt(discriminant);
      const t0 = (-b - root) / (2 * quadraticA), t1 = (-b + root) / (2 * quadraticA);
      if (t1 - t0 < 6) continue;
      spans.push({ sign, s, t0, t1 });
    }
  }
  return spans;
}

/**
 * 壳体肋条：两族 ±45° 的等值线（`(dx±dz)/√2 = s`），裁到数据给的椭圆平面内，沿壳面起伏。
 *
 * 为什么是两族斜线而不是经纬线：经纬线会全部收在壳顶一个点上，看着像雷达罩；
 * 斜向交叉的菱形网格才是"蚕茧/编织壳"的读法。每条肋的起止参数来自 `shellRibSpans()`，
 * 端点正好落在壳沿（y=0），不会悬在半空中。
 *
 * 每段是 4 个侧面组成的细方条（8 三角），沿法线外移 `ribLift`，平直法线保证棱角清楚。
 * **纯视觉**：不进 `colliderArrays()`，也不 bake。
 */
export function shellRibGeometry(spec: CityShell): THREE.BufferGeometry {
  const [cx, cz] = spec.center;
  const a = Math.SQRT1_2;
  const positions: number[] = [], normals: number[] = [];
  const normal: [number, number, number] = [0, 1, 0];
  const lift = SHELL.ribLift + SHELL.ribThickness / 2;
  const halfWidth = SHELL.ribWidth / 2, halfThickness = SHELL.ribThickness / 2;

  const triangle = (ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    dx: number, dy: number, dz: number): void => {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    positions.push(ax, ay, az, bx, by, bz, dx, dy, dz);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  };
  /** 一个四边形（4 个角，各 3 个数）拆两个三角；绕序无所谓（材质 DoubleSide，法线由几何算）。 */
  const quad = (q: readonly number[]): void => {
    triangle(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, q[6]!, q[7]!, q[8]!);
    triangle(q[0]!, q[1]!, q[2]!, q[6]!, q[7]!, q[8]!, q[9]!, q[10]!, q[11]!);
  };
  /** 一个采样点的 4 个截面角（外/内 × 左右），12 个数。 */
  const section = (x: number, y: number, z: number, tx: number, tz: number): number[] => {
    shellNormalAt(spec, x, z, normal);
    const nx = normal[0], ny = normal[1], nz = normal[2];
    // 横向 = 壳面法线 × 肋条的水平走向：与壳面相切、垂直于肋条，宽度方向才不会穿面。
    let bx = ny * tz, by = nz * tx - nx * tz, bz = -ny * tx;
    const length = Math.hypot(bx, by, bz) || 1;
    bx /= length; by /= length; bz /= length;
    const ox = x + nx * lift, oy = y + ny * lift, oz = z + nz * lift;
    return [
      ox + bx * halfWidth + nx * halfThickness, oy + by * halfWidth + ny * halfThickness, oz + bz * halfWidth + nz * halfThickness,
      ox - bx * halfWidth + nx * halfThickness, oy - by * halfWidth + ny * halfThickness, oz - bz * halfWidth + nz * halfThickness,
      ox - bx * halfWidth - nx * halfThickness, oy - by * halfWidth - ny * halfThickness, oz - bz * halfWidth - nz * halfThickness,
      ox + bx * halfWidth - nx * halfThickness, oy + by * halfWidth - ny * halfThickness, oz + bz * halfWidth - nz * halfThickness,
    ];
  };

  for (const { sign, s, t0, t1 } of shellRibSpans(spec)) {
    // sign=+1：`(dx+dz)/√2 = s` 的等值线；sign=-1：`(dx-dz)/√2 = s`。两族方向互为镜像。
    const px = a, pz = sign * a;        // 法向：这条线离中心多远
    const tx = a, tz = -sign * a;       // 沿线方向
    const span = t1 - t0;
    const steps = Math.max(2, Math.ceil(span / SHELL.ribStep));
    let previous: number[] | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = t0 + span * i / steps;
      const x = cx + s * px + t * tx;
      const z = cz + s * pz + t * tz;
      const current = section(x, shellHeightAt(spec, x, z), z, tx, tz);
      if (previous) {
        for (let side = 0; side < 4; side++) {
          const next = (side + 1) % 4;
          quad([
            previous[side * 3]!, previous[side * 3 + 1]!, previous[side * 3 + 2]!,
            previous[next * 3]!, previous[next * 3 + 1]!, previous[next * 3 + 2]!,
            current[next * 3]!, current[next * 3 + 1]!, current[next * 3 + 2]!,
            current[side * 3]!, current[side * 3 + 1]!, current[side * 3 + 2]!,
          ]);
        }
      }
      previous = current;
    }
  }
  if (!positions.length) return emptyGeometry();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** 一个壳体的两层几何：半透明面板 + 白色肋条（两个 mesh、两个材质 = 2 draw call）。 */
export interface ShellParts {
  panels: THREE.BufferGeometry;
  ribs: THREE.BufferGeometry;
}

export function shellGeometry(spec: CityShell): ShellParts {
  return { panels: shellPanelGeometry(spec), ribs: shellRibGeometry(spec) };
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
  /**
   * 北/东侧上限（米）：比南/西低一档。羊台山/梧桐山方向的天际线不能高过
   * 腾讯滨海（约 245m）与春笋（392.5m），否则从城里看会把真实地标"压"进山影里。
   */
  northEastMaxHeight: 230,
  /** 每条边的基准分段数（另两侧按长度等比缩放，保持三角形尺度一致）。 */
  segments: 56,
  /** 远景地坪（补掉"水面尽头与山脚之间"的空白）比水面低这么多米。 */
  apronDrop: 2.0,
} as const;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 沿环位置的"高度上限"：南/西 = `maxHeight`，北/东 = `northEastMaxHeight`，
 * 四个角用一段过渡带平滑换挡（直接按边切换会在角上留一道高度台阶）。
 */
function ridgeCap(t: number, options: typeof RIDGE): number {
  const blend = 0.06;
  // t=0 是东南角；0..0.5 是南+西，0.5..1 是北+东；两头各自淡入淡出，环闭合处连续。
  const weight = Math.min(1, 1 - smoothstep(0.5 - blend, 0.5, t) + smoothstep(1 - blend, 1, t));
  return options.northEastMaxHeight + (options.maxHeight - options.northEastMaxHeight) * weight;
}

/**
 * 山脊高度：沿折线位置 t（0..1）的**平滑**起伏。
 *
 * 为什么不是每个顶点各取一次 hash：那样得到的是"锯齿梳子"，远看像一堵碎掉的高墙；
 * 山脊是低频起伏，用两个正整数频率的正弦叠加（相位由固定常量给，不依赖场景），
 * 再叠 5% 的 hash 细节，才有"山"的轮廓而不失确定性。
 */
function ridgeHeight(t: number, options: typeof RIDGE, cap?: number): number {
  const top = cap ?? options.maxHeight;
  const broad = Math.sin(t * Math.PI * 3.1 + 0.7) * 0.62 + Math.sin(t * Math.PI * 7.7 + 2.1) * 0.38;
  const detail = ((stableHash(`ridge-detail:${Math.round(t * 4096)}`) & 0xff) / 0xff - 0.5) * 0.1;
  const clamped = Math.max(-1, Math.min(1, broad + detail));
  // clipped: 0.5..1 的起伏 → 高度区间；谷底不会压到 0（那一带是海湾/滩涂）。
  return options.minHeight + (0.5 + clamped * 0.5) * (top - options.minHeight);
}

/**
 * 城市外一圈的低模山脊（南山/塘朗山/羊台山剪影）+ 远景地坪（P2 从南/西扩到北/东）。
 *
 * 三条硬要求，改这里要同时复查：
 * 1. **只渲染**：不建碰撞、不 bake（`mount` 只把它当视觉层挂在 group 上）；
 * 2. **不挡地标**：山脊全在 `bounds` 之外、南/西 ≤260m、北/东 ≤230m（低于腾讯滨海/春笋），
 *    且被雾吃掉（Basic + fog）；
 * 3. **闭环**：四条边首尾相接，不能只画南/西——从城东/城北看会露出两堵墙的断头。
 *
 * 地坪（`apron`）不是装饰：南山的水面只铺到 bounds 南沿外 2km，再往南就是"没有几何"，
 * 不补一层远景地坪，海尽头与山脚之间会露出一条背景色带（看起来像倒置的地平线）。
 * 北/东侧同理：山脊绕过去以后，山脚与城市边缘之间也要有地坪，否则同样露背景色。
 */
export function ridgeGeometry(bounds: readonly [number, number, number, number], options: typeof RIDGE = RIDGE): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [];
  const base = new THREE.Color(RIDGE_COLOR);
  /** 顶点色只做很轻的亮度扰动 + 上下渐变；远山靠雾和轮廓，不靠细节。 */
  const tint = (level: number, variation: number): void => {
    colors.push(base.r * level * variation, base.g * level * variation, base.b * level * variation);
  };
  const [minX, minZ, maxX, maxZ] = bounds;
  // ── 远景地坪：城市外一圈（四面 + 四个角），轴对齐、互不重叠。
  // 以前的矩形从 minZ 一直铺到 farZ，等于在整座城市下面又铺了一层 y=-0.25 的板，
  // 鸟瞰时和 ground/water 叠出大片条纹；现在按"外圈环"铺，绝不盖住城市本体。
  // 北/东侧也必须铺：山脊绕到那边以后，山脚与城市边缘之间同样会露出背景色。
  const reach = options.distance + options.slope + 400;
  const farX = minX - reach, farZ = maxZ + reach, farEastX = maxX + reach, farNorthZ = minZ - reach;
  const apronY = -options.apronDrop;
  const apronQuads: [Point2, Point2, Point2, Point2][] = [
    [[minX, maxZ], [farEastX, maxZ], [farEastX, farZ], [minX, farZ]],
    [[minX, farNorthZ], [farEastX, farNorthZ], [farEastX, minZ], [minX, minZ]],
    [[farX, minZ], [minX, minZ], [minX, maxZ], [farX, maxZ]],
    [[maxX, minZ], [farEastX, minZ], [farEastX, maxZ], [maxX, maxZ]],
    [[farX, farNorthZ], [minX, farNorthZ], [minX, minZ], [farX, minZ]],
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

  // ── 山脊折线：绕城市边界一整圈（南 → 西 → 北 → 东 → 闭合）。
  // 只做南/西时，从城东/城北看过去会看到两堵墙的断头；闭环把四个角接上，
  // 北/东用更低的上限（`ridgeCap`），不压腾讯滨海/春笋的轮廓。
  // 每条边按长度等比给分段，短边不会堆出过密的三角形。
  const southZ = maxZ + options.distance, northZ = minZ - options.distance;
  const westX = minX - options.distance, eastX = maxX + options.distance;
  const baseSegments = Math.max(8, options.segments);
  const corners: Point2[] = [[eastX, southZ], [westX, southZ], [westX, northZ], [eastX, northZ], [eastX, southZ]];
  const path: Point2[] = [];
  const perimeter = Math.hypot(eastX - westX, 0) * 2 + Math.hypot(0, southZ - northZ) * 2;
  for (let side = 0; side < 4; side++) {
    const a = corners[side]!, b = corners[side + 1]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const count = Math.max(8, Math.round(baseSegments * length / (perimeter / 4)));
    for (let i = 0; i < count; i++) {
      const t = i / count;
      path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  // 闭合点与首点重合：环采样连续，不会在第 4 条边结尾留缺口。
  path.push([corners[4]![0], corners[4]![1]]);
  const height = path.map((_, index) => {
    const t = index / (path.length - 1);
    return ridgeHeight(t, options, ridgeCap(t, options));
  });
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
