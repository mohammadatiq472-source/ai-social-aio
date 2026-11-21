import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityBuilding, CityData, CityRoad } from './data';
import { buildingBounds, landmarkScale, PING_AN_ID } from './landmark';
import { facadeStyle, type FacadeStyle } from './materials';

export function buildingGeometry(building: CityBuilding): THREE.BufferGeometry {
  const paths = building.rings.map(ring => new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
  const outline = new THREE.Shape(paths[0]!.getPoints());
  outline.holes = paths.slice(1);
  const landmark = building.id === PING_AN_ID;
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: building.height, bevelEnabled: false, steps: landmark ? 60 : 1, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position');
  if (landmark) {
    const center = buildingBounds(building);
    for (let i = 0; i < positions.count; i++) {
      const scale = landmarkScale(positions.getY(i));
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

export function facadeChunks(data: CityData): { geometry: THREE.BufferGeometry; style: FacadeStyle }[] {
  const buckets = new Map<string, { style: FacadeStyle; parts: THREE.BufferGeometry[] }>();
  for (const building of data.buildings) {
    const center = buildingBounds(building), style = facadeStyle(building);
    const key = `${center.x < 0 ? 0 : 1}:${center.z < 0 ? 0 : 1}:${style}`;
    const bucket = buckets.get(key) ?? { style, parts: [] };
    bucket.parts.push(buildingGeometry(building));
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(({ style, parts }) => {
    const geometry = mergeGeometries(parts, false)!;
    parts.forEach(part => part.dispose());
    geometry.computeBoundingSphere();
    return { style, geometry };
  });
}

export function buildingChunks(data: CityData): THREE.BufferGeometry[] {
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  for (const building of data.buildings) {
    const ring = building.rings[0]!;
    const x = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
    const z = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const key = `${x < 0 ? 0 : 1}:${z < 0 ? 0 : 1}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(buildingGeometry(building));
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(parts => {
    const merged = mergeGeometries(parts, false)!;
    parts.forEach(part => part.dispose());
    merged.computeBoundingSphere();
    return merged;
  });
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

export function colliderArrays(geometry: THREE.BufferGeometry): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array(geometry.getAttribute('position').array);
  const indices = geometry.index ? new Uint32Array(geometry.index.array) :
    Uint32Array.from({ length: vertices.length / 3 }, (_, index) => index);
  return { vertices, indices };
}
