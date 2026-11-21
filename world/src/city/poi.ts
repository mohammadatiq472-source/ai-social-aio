/**
 * 互动点（POI）数据结构。玩法 Agent 往区域数据里填，渲染/交互层按 `kind` 分派。
 * 只定结构与校验，不定外观；文字一律当纯文本（textContent），不能当 HTML。
 */
export const POI_KINDS = [
  'landmark-info',   // 地标信息卡
  'viewpoint',       // 观景点：切光照 / 拍照
  'ride',            // 可乘坐：摩天轮等（相机轨迹）
  'seat',            // 长椅/台阶：E 坐下
  'transit',         // 地铁站口：快速前往其他瓦片
  'shop',            // 小店：Agent 扮演店主
  'message-pin',     // 地点留言（AIO 群聊）
  'checkin',         // 街道打卡点
] as const;
export type PoiKind = typeof POI_KINDS[number];

export interface PoiAction {
  /** 键位提示，如 'E' / 'F'。 */
  key: string;
  label: string;
  /** 交互层识别的动作名；未知动作被忽略并在 dev 下告警。 */
  action: string;
}

export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  /** 区域米制 [x, y, z]。 */
  position: [number, number, number];
  /** 触发半径（米）。 */
  radius: number;
  /** 所属街道（打卡册分组用），如 '新安'。 */
  street?: string;
  description?: string;
  actions: PoiAction[];
  /** 可选：负责这个点的 Agent 身份（AIO 里的 agent id）。 */
  agent?: string;
}

export function parsePois(raw: unknown): Poi[] {
  if (!Array.isArray(raw)) throw new Error('互动点不合法：应为数组');
  const ids = new Set<string>();
  return raw.map((item, index) => {
    const p = item as Record<string, unknown>;
    const where = `#${index}`;
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id)) throw new Error(`互动点不合法：${where} id`);
    ids.add(p.id);
    if (!POI_KINDS.includes(p.kind as PoiKind)) throw new Error(`互动点不合法：${where} kind`);
    if (typeof p.name !== 'string' || !p.name || p.name.length > 40) throw new Error(`互动点不合法：${where} name`);
    if (!Array.isArray(p.position) || p.position.length !== 3 || !p.position.every(Number.isFinite)) throw new Error(`互动点不合法：${where} position`);
    if (typeof p.radius !== 'number' || !(p.radius > 0 && p.radius <= 100)) throw new Error(`互动点不合法：${where} radius`);
    if (!Array.isArray(p.actions)) throw new Error(`互动点不合法：${where} actions`);
    return p as unknown as Poi;
  });
}

/** 玩家位置附近、半径内最近的互动点（交互卡只显示一个）。 */
export function nearestPoi(pois: readonly Poi[], x: number, z: number): Poi | null {
  let best: Poi | null = null;
  let bestDistance = Infinity;
  for (const poi of pois) {
    const d = Math.hypot(poi.position[0] - x, poi.position[2] - z);
    if (d <= poi.radius && d < bestDistance) { best = poi; bestDistance = d; }
  }
  return best;
}
