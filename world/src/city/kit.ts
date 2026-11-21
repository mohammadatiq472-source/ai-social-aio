import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityData } from './data';
import { buildingGeometry } from './geometry';
import { buildingBounds, landmarkScale, type LandmarkProfile } from './landmark';
import { STREET_PALETTE as C } from './materials';

/**
 * 街树/灯/长椅参数（米）。
 *
 * 树整体缩到原来的约 0.82（冠半径 2.1→1.75、冠中心高 4.6→3.8、干高 3.4→2.8）：
 * 近景里 2.1m 半径的树冠比路灯横臂还宽，人行道被树冠糊满、挡住立面一层的窗；
 * 缩一圈之后树仍然高过 2m（冠底 3.8−1.75×0.78 ≈ 2.4m），能钻过但不穿模。
 * 树池/灯/长椅的尺寸不动——它们本来就按建筑模数，不是"看着大"的问题。
 */
export const STREET_KIT = {
  tree: { trunkHeight: 2.8, trunkRadius: 0.16, crownRadius: 1.75, crownHeight: 3.8 },
  lamp: { height: 6, radius: 0.075, arm: 1.8 },
  bench: { width: 2.2, depth: 0.65, seatHeight: 0.46, backHeight: 0.9 },
} as const;

/**
 * 入口雨棚**不再**是这里写死的常量：位置/尺寸/文字来自 `data.street.canopy`（数据文件），
 * 没有这个字段就不建。福田的雨棚现在写在 `assets/city/futian.json`，换街区不用改代码。
 */

/**
 * sign 类零件没有 `label` 时的通用占位文字。
 *
 * 为什么不用「福田 / 益田路」之类的真名：路牌只标**已知地名**，把某个街区的名字写进
 * 通用零件代码，会让别的街区凭空出现一条不存在的路（README「不编造商户或设施」）。
 */
export const GENERIC_SIGN_LABEL = '街区示意';

export interface StreetKitGeometry {
  paving: THREE.BufferGeometry;
  solids: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry;
  labels: { text: string; x: number; y: number; z: number; yaw: number; width: number }[];
}

/** 点是否在环内（射线交叉）。铺装是带孔洞的多边形，不能用包围盒判断。 */
function ringContains(ring: readonly [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function buildStreetKit(data: CityData): StreetKitGeometry {
  const solids: THREE.BufferGeometry[] = [], lamps: THREE.BufferGeometry[] = [];
  const labels: StreetKitGeometry['labels'] = [];
  const add = (geometry: THREE.BufferGeometry, color: number, glowing = false): void => {
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    const c = new THREE.Color(color);
    for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const surface = new Float32Array(geometry.getAttribute('position').count * 2);
    const metal = color === C.steel || color === C.metal;
    for (let i = 0; i < surface.length; i += 2) surface.set([metal ? .28 : .88, metal ? .85 : 0], i);
    geometry.setAttribute('surface', new THREE.BufferAttribute(surface, 2));
    geometry.deleteAttribute('uv');
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    (glowing ? lamps : solids).push(flat);
  };
  const box = (x: number, y: number, z: number, width: number, height: number, depth: number, color: number, glowing = false): void => {
    add(new THREE.BoxGeometry(width, height, depth).translate(x, y, z), color, glowing);
  };
  const beam = (a: THREE.Vector3, b: THREE.Vector3, radius: number, color: number): void => {
    const direction = b.clone().sub(a);
    const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), 8);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    add(geometry, color);
  };
  const y0 = data.street.pavingHeight;
  /**
   * 树干/灯杆的基座 y：**只有脚下真有铺装**时才用 pavingHeight。
   *
   * 南山 street.paving=[]（第一版不铺装），若仍按 pavingHeight 摆放，40 个树/灯会整体悬空 0.12m。
   * 福田的 placements 都落在铺装多边形内，所以行为不变。
   */
  const groundHeightAt = (x: number, z: number): number => {
    if (!data.street.paving.length) return 0;
    for (const rings of data.street.paving) {
      if (!rings[0] || !ringContains(rings[0], x, z)) continue;
      if (rings.slice(1).some(hole => ringContains(hole, x, z))) continue;
      return y0;
    }
    return 0;
  };
  for (const placement of data.street.placements) {
    const { x, z, kind } = placement;
    // 每个零件用自己的脚下高度：铺装是局部多边形，不是全城统一台面。
    const base = groundHeightAt(x, z);
    if (kind === 'tree') {
      const tree = STREET_KIT.tree;
      beam(new THREE.Vector3(x, base, z), new THREE.Vector3(x, base + tree.trunkHeight, z), tree.trunkRadius, C.trunk);
      for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3;
        const geometry = new THREE.IcosahedronGeometry(tree.crownRadius, 1);
        geometry.scale(1, 0.78, 1).translate(x + Math.cos(angle) * 0.65, base + tree.crownHeight + i * 0.14, z + Math.sin(angle) * 0.65);
        add(geometry, C.leaves[i]!);
      }
      for (const sign of [-1, 1]) {
        box(x + sign * 1.4, base + 0.12, z, 0.18, 0.24, 2.9, C.paving);
        box(x, base + 0.12, z + sign * 1.4, 2.9, 0.24, 0.18, C.paving);
      }
    } else if (kind === 'lamp') {
      const lamp = STREET_KIT.lamp;
      beam(new THREE.Vector3(x, base, z), new THREE.Vector3(x, base + lamp.height, z), lamp.radius, C.metal);
      beam(new THREE.Vector3(x, base + lamp.height, z), new THREE.Vector3(x + lamp.arm, base + lamp.height - 0.2, z), 0.06, C.metal);
      box(x + lamp.arm, base + lamp.height - 0.27, z, 0.9, 0.12, 0.34, C.metal);
      box(x + lamp.arm, base + lamp.height - 0.34, z, 0.75, 0.025, 0.26, C.lamp, true);
    } else if (kind === 'bench') {
      const bench = STREET_KIT.bench;
      for (const side of [-1, 1]) box(x + side * 0.8, base + 0.23, z, 0.09, 0.46, bench.depth, C.metal);
      for (let i = 0; i < 4; i++) box(x, base + bench.seatHeight, z - 0.24 + i * 0.16, bench.width, 0.055, 0.13, C.timber);
      for (let i = 0; i < 3; i++) box(x, base + 0.64 + i * 0.11, z - 0.29, bench.width, 0.085, 0.055, C.timber);
    } else {
      box(x, base + 1.25, z, 0.1, 2.5, 0.1, C.metal);
      box(x, base + 2.2, z, 3.3, 0.85, 0.12, C.metal);
      labels.push({ text: placement.label ?? GENERIC_SIGN_LABEL, x, y: base + 2.2, z: z + 0.07, yaw: 0, width: 3.1 });
    }
  }
  const canopy = data.street.canopy;
  if (canopy) {
    // 顶板 + 两根立柱 + 两侧檐口，尺寸全部按数据等比推导（不是福田写死的 2.8 / 7.3 / 7.8）。
    const halfWidth = canopy.width / 2, halfDepth = canopy.depth / 2;
    box(canopy.x, canopy.height, canopy.z, canopy.width, 0.22, canopy.depth, C.steel);
    for (const side of [-1, 1]) {
      box(canopy.x + halfWidth - 0.7, canopy.height / 2, canopy.z + side * (halfDepth - 0.7), 0.22, canopy.height, 0.22, C.steel);
      box(canopy.x, canopy.height - 0.03, canopy.z + side * (halfDepth - 0.2), canopy.width, 0.3, 0.18, C.steel);
    }
    if (canopy.label) {
      labels.push({ text: canopy.label, x: canopy.x + halfWidth + 0.02, y: canopy.height - 0.1, z: canopy.z, yaw: Math.PI / 2, width: 8 });
    }
  }
  // 地标竖向构件只对**数据声明的**地标生成，且必须能按 id 找回建筑；找不到就不建（不猜）。
  // `landmark` 是福田的单地标写法，`landmarks[]` 是南山的多核验地标；两者合并遍历，同 id 去重。
  const landmarks = [...(data.landmark ? [data.landmark] : []), ...(data.landmarks ?? [])];
  const done = new Set<string>();
  for (const landmark of landmarks) {
    if (done.has(landmark.id)) continue;
    done.add(landmark.id);
    // 壳体地标（`kind: 'shell'`）没有楼体、也没有收分曲线：不建竖向构件。
    // 壳由 `geometry.ts#shellGeometry` 单独生成（纯视觉层，不碰撞）。
    const profile: LandmarkProfile | undefined = landmark.profile;
    if (!profile) continue;
    const tower = data.buildings.find(building => building.id === landmark.id);
    if (!tower) continue;
    const bounds = buildingBounds(tower);
    // 基底锚点从外轮廓内缩；小体块按 1/3 边长收，避免某个街区的小楼把锚点挤到反方向。
    const inset = Math.max(1, Math.min(9, Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 3));
    const anchors: [number, number][] = [[bounds.minX, bounds.minZ + inset], [bounds.minX + inset, bounds.minZ],
      [bounds.maxX - inset, bounds.minZ], [bounds.maxX, bounds.minZ + inset],
      [bounds.maxX, bounds.maxZ - inset], [bounds.maxX - inset, bounds.maxZ],
      [bounds.minX + inset, bounds.maxZ], [bounds.minX, bounds.maxZ - inset]];
    // 顶部收细：曲线末段（冠部）用 0.3m，其余 0.8m。阈值取曲线倒数第二个节点，不写死 565。
    const tip = profile[profile.length - 2]?.[0] ?? profile[profile.length - 1]![0];
    for (const [x, z] of anchors) {
      for (let i = 1; i < profile.length; i++) {
        const ya = profile[i - 1]![0], yb = profile[i]![0];
        const a = new THREE.Vector3(bounds.x + (x - bounds.x) * landmarkScale(profile, ya), ya, bounds.z + (z - bounds.z) * landmarkScale(profile, ya));
        const b = new THREE.Vector3(bounds.x + (x - bounds.x) * landmarkScale(profile, yb), yb, bounds.z + (z - bounds.z) * landmarkScale(profile, yb));
        beam(a, b, yb > tip ? 0.3 : 0.8, C.steel);
      }
    }
  }
  const combine = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    // mergeGeometries([]) 返回 null：南山第一版没有铺装/零件，空街不能让调用方拿到 null。
    if (!parts.length) {
      const empty = new THREE.BufferGeometry();
      empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      return empty;
    }
    const geometry = mergeGeometries(parts, false)!;
    parts.forEach(part => part.dispose());
    geometry.computeBoundingSphere();
    return geometry;
  };
  const paving = data.street.paving.map((rings, i) => {
    const geometry = buildingGeometry({ id: `paving-${i}`, rings, height: y0, heightSource: 'estimate' });
    const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    for (let j = 0; j < positions.count; j++) uv.setXY(j, positions.getX(j), positions.getZ(j));
    return geometry;
  });
  return { paving: combine(paving), solids: combine(solids), lamps: combine(lamps), labels };
}

export function streetSign(text: string, width: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const buildingSign = width > 4;
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = buildingSign ? 128 : 256;
  const context = canvas.getContext('2d')!;
  if (!buildingSign) { context.fillStyle = '#2d4954'; context.fillRect(0, 0, 1024, 256); }
  context.font = `500 ${buildingSign ? 58 : 92}px "Microsoft YaHei", sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillStyle = buildingSign ? '#e0e5e6' : '#edf1e4'; context.fillText(text, 512, canvas.height / 2, 960);
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(width, width / (buildingSign ? 8 : 4)),
    new THREE.MeshBasicMaterial({ map, transparent: buildingSign, depthWrite: !buildingSign }));
}
