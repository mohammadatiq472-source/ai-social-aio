import type { CityBuilding } from './data';

/**
 * 收分曲线：`[高度 m, 水平比例]`，高度严格递增。
 *
 * 曲线现在住在**数据**里（`CityData.landmark.profile`，见 `data.ts`），而不是这里。
 * 换街区/换地标只改 JSON；本文件只负责插值。
 */
export type LandmarkProfile = readonly (readonly [number, number])[];

/** 平安金融中心的 OSM 实体 id（福田数据里唯一 ctbuh 建筑）。 */
export const PING_AN_ID = 'way/535860513';

/**
 * 平安金融中心的收分曲线，保留为具名常量：
 * 既给 `landmarkScale(height)` 旧签名兜底，也作为生成器写 `data.landmark.profile` 的参考值。
 */
export const PING_AN_PROFILE: LandmarkProfile = [
  [0, 1], [12, 1], [60, 0.985], [400, 0.86], [540, 0.76], [565, 0.66], [599.1, 0.025],
];

/**
 * 曲线在 `height`（米）处的水平比例。
 *
 * 分段线性插值；低于首节点取首节点比例、高于末节点取末节点比例（**不外推**）——
 * 外推会在地标顶部造出负比例，把体块翻面。
 */
export function landmarkScale(profile: LandmarkProfile, height: number): number;
/** @deprecated 旧签名（写死平安金融中心曲线）。新代码请传 `data.landmark.profile`。 */
export function landmarkScale(height: number): number;
export function landmarkScale(profileOrHeight: LandmarkProfile | number, height?: number): number {
  const profile = typeof profileOrHeight === 'number' ? PING_AN_PROFILE : profileOrHeight;
  const value = typeof profileOrHeight === 'number' ? profileOrHeight : height!;
  const first = profile[0];
  if (!first || profile.length < 2) return 1;
  if (value <= first[0]) return first[1];
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!, b = profile[i]!;
    if (value <= b[0]) {
      const t = Math.max(0, (value - a[0]) / (b[0] - a[0]));
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return profile[profile.length - 1]![1];
}

export function buildingBounds(building: CityBuilding): { minX: number; maxX: number; minZ: number; maxZ: number; x: number; z: number } {
  const ring = building.rings[0]!;
  const minX = Math.min(...ring.map(p => p[0])), maxX = Math.max(...ring.map(p => p[0]));
  const minZ = Math.min(...ring.map(p => p[1])), maxZ = Math.max(...ring.map(p => p[1]));
  return { minX, maxX, minZ, maxZ, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}
