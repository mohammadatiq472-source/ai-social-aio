import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityData } from './data';
import { buildingGeometry } from './geometry';
import { buildingBounds, landmarkScale, PING_AN_ID, PING_AN_PROFILE } from './landmark';
import { STREET_PALETTE as C } from './materials';

export const STREET_KIT = {
  tree: { trunkHeight: 3.4, trunkRadius: 0.19, crownRadius: 2.1, crownHeight: 4.6 },
  lamp: { height: 6, radius: 0.075, arm: 1.8 },
  bench: { width: 2.2, depth: 0.65, seatHeight: 0.46, backHeight: 0.9 },
  canopy: { x: -333.1, z: 372.08, width: 7, depth: 16, height: 4.2 },
} as const;

export interface StreetKitGeometry {
  paving: THREE.BufferGeometry;
  solids: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry;
  labels: { text: string; x: number; y: number; z: number; yaw: number; width: number }[];
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
  for (const placement of data.street.placements) {
    const { x, z, kind } = placement;
    if (kind === 'tree') {
      const tree = STREET_KIT.tree;
      beam(new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y0 + tree.trunkHeight, z), tree.trunkRadius, C.trunk);
      for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3;
        const geometry = new THREE.IcosahedronGeometry(tree.crownRadius, 1);
        geometry.scale(1, 0.78, 1).translate(x + Math.cos(angle) * 0.65, y0 + tree.crownHeight + i * 0.14, z + Math.sin(angle) * 0.65);
        add(geometry, C.leaves[i]!);
      }
      for (const sign of [-1, 1]) {
        box(x + sign * 1.4, y0 + 0.12, z, 0.18, 0.24, 2.9, C.paving);
        box(x, y0 + 0.12, z + sign * 1.4, 2.9, 0.24, 0.18, C.paving);
      }
    } else if (kind === 'lamp') {
      const lamp = STREET_KIT.lamp;
      beam(new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y0 + lamp.height, z), lamp.radius, C.metal);
      beam(new THREE.Vector3(x, y0 + lamp.height, z), new THREE.Vector3(x + lamp.arm, y0 + lamp.height - 0.2, z), 0.06, C.metal);
      box(x + lamp.arm, y0 + lamp.height - 0.27, z, 0.9, 0.12, 0.34, C.metal);
      box(x + lamp.arm, y0 + lamp.height - 0.34, z, 0.75, 0.025, 0.26, C.lamp, true);
    } else if (kind === 'bench') {
      const bench = STREET_KIT.bench;
      for (const side of [-1, 1]) box(x + side * 0.8, y0 + 0.23, z, 0.09, 0.46, bench.depth, C.metal);
      for (let i = 0; i < 4; i++) box(x, y0 + bench.seatHeight, z - 0.24 + i * 0.16, bench.width, 0.055, 0.13, C.timber);
      for (let i = 0; i < 3; i++) box(x, y0 + 0.64 + i * 0.11, z - 0.29, bench.width, 0.085, 0.055, C.timber);
    } else {
      box(x, y0 + 1.25, z, 0.1, 2.5, 0.1, C.metal);
      box(x, y0 + 2.2, z, 3.3, 0.85, 0.12, C.metal);
      labels.push({ text: '福田 / 益田路', x, y: y0 + 2.2, z: z + 0.07, yaw: 0, width: 3.1 });
    }
  }
  const canopy = STREET_KIT.canopy;
  box(canopy.x, canopy.height, canopy.z, canopy.width, 0.22, canopy.depth, C.steel);
  for (const side of [-1, 1]) {
    box(canopy.x + 2.8, canopy.height / 2, canopy.z + side * 7.3, 0.22, canopy.height, 0.22, C.steel);
    box(canopy.x, canopy.height - 0.03, canopy.z + side * 7.8, canopy.width, 0.3, 0.18, C.steel);
  }
  labels.push({ text: '平安金融中心', x: canopy.x + canopy.width / 2 + 0.02, y: canopy.height - 0.1, z: canopy.z, yaw: Math.PI / 2, width: 8 });
  const tower = data.buildings.find(building => building.id === PING_AN_ID)!;
  const bounds = buildingBounds(tower), inset = 9;
  const anchors = [[bounds.minX, bounds.minZ + inset], [bounds.minX + inset, bounds.minZ],
    [bounds.maxX - inset, bounds.minZ], [bounds.maxX, bounds.minZ + inset],
    [bounds.maxX, bounds.maxZ - inset], [bounds.maxX - inset, bounds.maxZ],
    [bounds.minX + inset, bounds.maxZ], [bounds.minX, bounds.maxZ - inset]];
  for (const [x, z] of anchors) {
    for (let i = 1; i < PING_AN_PROFILE.length; i++) {
      const ya = PING_AN_PROFILE[i - 1]![0], yb = PING_AN_PROFILE[i]![0];
      const a = new THREE.Vector3(bounds.x + (x! - bounds.x) * landmarkScale(ya), ya, bounds.z + (z! - bounds.z) * landmarkScale(ya));
      const b = new THREE.Vector3(bounds.x + (x! - bounds.x) * landmarkScale(yb), yb, bounds.z + (z! - bounds.z) * landmarkScale(yb));
      beam(a, b, yb > 565 ? 0.3 : 0.8, C.steel);
    }
  }
  const combine = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
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
