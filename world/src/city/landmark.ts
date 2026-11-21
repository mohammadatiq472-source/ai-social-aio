import type { CityBuilding } from './data';

export const PING_AN_ID = 'way/535860513';
export const PING_AN_PROFILE = [
  [0, 1], [12, 1], [60, 0.985], [400, 0.86], [540, 0.76], [565, 0.66], [599.1, 0.025],
] as const;

export function landmarkScale(height: number): number {
  for (let i = 1; i < PING_AN_PROFILE.length; i++) {
    const a = PING_AN_PROFILE[i - 1]!, b = PING_AN_PROFILE[i]!;
    if (height <= b[0]) {
      const t = Math.max(0, (height - a[0]) / (b[0] - a[0]));
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return PING_AN_PROFILE[PING_AN_PROFILE.length - 1]![1];
}

export function buildingBounds(building: CityBuilding): { minX: number; maxX: number; minZ: number; maxZ: number; x: number; z: number } {
  const ring = building.rings[0]!;
  const minX = Math.min(...ring.map(p => p[0])), maxX = Math.max(...ring.map(p => p[0]));
  const minZ = Math.min(...ring.map(p => p[1])), maxZ = Math.max(...ring.map(p => p[1]));
  return { minX, maxX, minZ, maxZ, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}
