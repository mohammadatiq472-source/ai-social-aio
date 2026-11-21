import { stableHash } from './materials';

/**
 * 建筑类别。数据里还没有这个字段（data.ts 冻结 schema 未扩展），所以 `categoryOf()` 先按高度推断；
 * 等宝安数据带上 OSM 用地/建筑标签后，由生成器写入真实类别，再走同一个 `facadeSpec()`。
 */
export const BUILDING_CATEGORIES = [
  'tower', 'office', 'residential', 'urban_village', 'industrial', 'civic', 'landmark', 'generic',
] as const;
export type BuildingCategory = typeof BUILDING_CATEGORIES[number];

export interface GrammarInput {
  id: string;
  height: number;
  category?: BuildingCategory;
}

/** 没有类别字段时的退路：与现有 facadeStyle 的高度阈值一致（≥65m 塔楼，≥24m 办公，其余普通）。 */
export function categoryOf(building: GrammarInput): BuildingCategory {
  if (building.category) return building.category;
  return building.height >= 65 ? 'tower' : building.height >= 24 ? 'office' : 'generic';
}

/**
 * 立面语法：把一栋楼拆成「底商 / 楼身 / 楼顶」三段，每段的参数由 类别 + seed 决定。
 *
 * 为什么要有它：现有街区（福田/罗湖）整面墙是同一张窗格 atlas 平铺，底层与顶层没有区别，
 * 所有楼都长一样。这里只定**参数**，不画贴图；材质/几何模块读这些参数去生成外观。
 * 同一栋楼每次加载结果一致（只用 seed，禁止 Math.random）。
 */
export interface FacadeSpec {
  category: BuildingCategory;
  /** 底商层高（米），0 = 没有底商。 */
  baseHeight: number;
  /** 标准层层高（米）。 */
  floorHeight: number;
  /** 窗型变体编号，材质模块按类别解释。 */
  windowVariant: number;
  /** 窗间距（米）。 */
  bayWidth: number;
  /** 色相/明度偏移，范围 [-1, 1]，材质模块自行缩放。 */
  tintShift: number;
  /** 墙面污渍/老化程度 [0, 1]。 */
  weathering: number;
  /** 墙面挂件密度（空调外机/阳台/防盗网），每个开间的期望个数。 */
  attachments: { ac: number; balcony: number; grille: number };
  /** 楼顶处理。 */
  crown: 'flat' | 'parapet' | 'mechanical' | 'water-tank' | 'setback' | 'helipad';
}

/** mulberry32：从 seed 派生确定的伪随机序列。 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T => items.at(Math.floor(rand() * items.length)) as T;
const range = (rand: () => number, lo: number, hi: number) => lo + (hi - lo) * rand();

/**
 * 每个类别的参数范围。数值是设计取值，不是测绘；外观 Agent 可以调，但要同步改测试里的范围断言。
 * TODO(外观 Agent)：按验收截图迭代这些范围。
 */
export function facadeSpec(building: GrammarInput): FacadeSpec {
  const rand = seeded(stableHash(building.id));
  const c = categoryOf(building);
  switch (c) {
    case 'urban_village':
      return { category: c, baseHeight: rand() < 0.7 ? range(rand, 3.6, 4.5) : 0, floorHeight: range(rand, 2.8, 3.1),
        windowVariant: Math.floor(rand() * 4), bayWidth: range(rand, 2.4, 3.4), tintShift: range(rand, -1, 1),
        weathering: range(rand, 0.4, 0.95), attachments: { ac: range(rand, 0.5, 1.2), balcony: range(rand, 0, 0.4), grille: range(rand, 0.4, 1) },
        crown: pick(rand, ['flat', 'parapet', 'water-tank'] as const) };
    case 'industrial':
      return { category: c, baseHeight: 0, floorHeight: range(rand, 4.5, 7), windowVariant: Math.floor(rand() * 3),
        bayWidth: range(rand, 6, 9), tintShift: range(rand, -1, 1), weathering: range(rand, 0.3, 0.8),
        attachments: { ac: range(rand, 0, 0.1), balcony: 0, grille: 0 }, crown: pick(rand, ['flat', 'mechanical'] as const) };
    case 'residential':
      return { category: c, baseHeight: rand() < 0.5 ? range(rand, 4, 6) : 0, floorHeight: range(rand, 2.9, 3.1),
        windowVariant: Math.floor(rand() * 5), bayWidth: range(rand, 3, 4.2), tintShift: range(rand, -1, 1),
        weathering: range(rand, 0.1, 0.5), attachments: { ac: range(rand, 0.4, 0.9), balcony: range(rand, 0.3, 0.8), grille: range(rand, 0, 0.3) },
        crown: pick(rand, ['parapet', 'mechanical', 'setback'] as const) };
    case 'tower':
    case 'landmark':
      return { category: c, baseHeight: range(rand, 8, 14), floorHeight: range(rand, 3.8, 4.4), windowVariant: Math.floor(rand() * 6),
        bayWidth: range(rand, 1.5, 3), tintShift: range(rand, -1, 1), weathering: range(rand, 0, 0.15),
        attachments: { ac: 0, balcony: 0, grille: 0 }, crown: building.height > 150 ? pick(rand, ['helipad', 'setback'] as const) : 'mechanical' };
    case 'office':
    case 'civic':
    case 'generic':
    default:
      return { category: c, baseHeight: range(rand, 4.5, 6), floorHeight: range(rand, 3.4, 4), windowVariant: Math.floor(rand() * 5),
        bayWidth: range(rand, 2.4, 3.6), tintShift: range(rand, -1, 1), weathering: range(rand, 0.05, 0.35),
        attachments: { ac: range(rand, 0, 0.3), balcony: 0, grille: 0 }, crown: pick(rand, ['parapet', 'mechanical', 'flat'] as const) };
  }
}
