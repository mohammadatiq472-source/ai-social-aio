/**
 * 碰撞层常量与交互矩阵（spec §2.2 第 2 条 / §6 M3 第 4 条）。
 *
 * 为什么把矩阵写死在代码里并配注释：碰撞层最容易出的事故是"角色和地板不碰"，
 * 这类 bug 在运行时表现为"角色一直往下掉"，极难从日志反推。所以层号、实心响应、
 * 事件响应三件事必须一眼能读，不允许散落在各个 collider 创建处各写一份掩码。
 *
 * 关键设计：**实心响应和事件响应是两张不同的表**。
 * Rapier 的 interactionGroups 只有一对 (membership, filter)，且两边必须互相匹配才会被考虑。
 * 传感器要求"只与 character 产生事件、不产生任何物理响应"——用一张表做不到：
 * 若 sensor 的 filter 含 CHARACTER 而 CHARACTER 的 filter 不含 SENSOR，事件不会触发；
 * 若两边都含，则会被当成可碰撞对（对 sensor 来说仍然没有推力，但语义上就不该叫"碰撞"）。
 * 所以这里拆成 SOLID（谁挡住谁）和 EVENTS（谁跟谁出事件），实际 filter 是两者按位或。
 */

/**
 * 位掩码。Rapier 的 interactionGroups = (membership << 16) | filter。
 * 一个 collider 只有一个 membership 位；filter 是"我愿意和哪些层互动"的位集合。
 */
export const LAYERS = {
  /** 墙、地、楼梯（烘焙出来的静态几何）。 */
  WORLD_STATIC: 1 << 0, // 1
  /** 角色胶囊（人类与 Agent 共用的身体）。 */
  CHARACTER: 1 << 1, // 2
  /** 可推动的箱子等动态刚体。 */
  PROP: 1 << 2, // 4
  /** 触发器（座位、交互区），不产生物理响应，只产生事件。 */
  SENSOR: 1 << 3, // 8
  /** Agent 专属层（v0.1 与 CHARACTER 同层，预留给 v0.2 做差异规则）。 */
  AGENT: 1 << 4, // 16
} as const;

export type LayerName = keyof typeof LAYERS;

/** 层名列表（顺序固定，调试面板与测试都依赖它）。 */
export const ALL_LAYERS: readonly LayerName[] = [
  'WORLD_STATIC',
  'CHARACTER',
  'PROP',
  'SENSOR',
  'AGENT',
];

/**
 * 实心响应矩阵：`SOLID[a] & LAYERS[b]` 非 0 表示 a 会被 b 挡住（有推力/接触流形）。
 *
 *              static  character  prop  sensor  agent
 *  static        ✗        ✓        ✓      ✗      ✓
 *  character     ✓        ✓        ✓      ✗      ✓
 *  prop          ✓        ✓        ✓      ✗      ✗
 *  sensor        ✗        ✗        ✗      ✗      ✗   ← 传感器永不产生物理响应
 *  agent         ✓        ✓        ✗      ✗      ✓
 *
 * 两处刻意的"✗"：
 * - static 与 static 不互碰：静态几何烘焙后永不移动，让它们互碰只是白白增加窄相位负担。
 * - AGENT 与 PROP 不互碰：Agent 是外部驱动的，允许它推箱会让"意图执行结果"不可预测
 *   （spec §4.2 要求意图失败要能回报，被箱子顶飞就没法归因）。
 */
const SOLID: Record<LayerName, number> = {
  WORLD_STATIC: LAYERS.CHARACTER | LAYERS.PROP | LAYERS.AGENT,
  CHARACTER: LAYERS.WORLD_STATIC | LAYERS.CHARACTER | LAYERS.PROP | LAYERS.AGENT,
  PROP: LAYERS.WORLD_STATIC | LAYERS.CHARACTER | LAYERS.PROP,
  SENSOR: 0,
  AGENT: LAYERS.WORLD_STATIC | LAYERS.CHARACTER | LAYERS.AGENT,
};

/**
 * 事件响应矩阵：只用于 collision events，不代表物理响应。
 *
 *              static  character  prop  sensor  agent
 *  static        ✗        ✗        ✗      ✗      ✗
 *  character     ✗        ✗        ✗      ✓      ✗
 *  prop          ✗        ✗        ✗      ✗      ✗
 *  sensor        ✗        ✓        ✗      ✗      ✗
 *  agent         ✗        ✗        ✗      ✓      ✗
 *
 * 只有 SENSOR ↔ CHARACTER / SENSOR ↔ AGENT 这一组会产生事件（spec：sensor 只与 character 产生事件）。
 * 其余组合不开事件：每开一对就多一次窄相位记账，v0.1 用不到。
 */
const EVENTS: Record<LayerName, number> = {
  WORLD_STATIC: 0,
  CHARACTER: LAYERS.SENSOR,
  PROP: 0,
  SENSOR: LAYERS.CHARACTER | LAYERS.AGENT,
  AGENT: LAYERS.SENSOR,
};

/** 该层实际写进 interactionGroups 低 16 位的 filter。 */
export function filterMask(member: LayerName): number {
  return SOLID[member] | EVENTS[member];
}

/** 实心响应掩码（不含事件位）。 */
export function solidMask(member: LayerName): number {
  return SOLID[member];
}

/** 事件响应掩码（不含实心位）。 */
export function eventMask(member: LayerName): number {
  return EVENTS[member];
}

/** 组装 Rapier 的 interactionGroups 整数。filter 不传则用该层的默认值。 */
export function interactionGroups(member: LayerName, filter?: number): number {
  const f = filter ?? filterMask(member);
  return ((LAYERS[member] & 0xffff) << 16) | (f & 0xffff);
}

/**
 * 两层之间是否有实心响应（写单测用，也是矩阵的唯一解释权）。
 * 必须双向都愿意才算碰：单向声明在 Rapier 里同样不生效，这里保持一致以免自欺。
 */
export function layersCollide(a: LayerName, b: LayerName): boolean {
  return (SOLID[a] & LAYERS[b]) !== 0 && (SOLID[b] & LAYERS[a]) !== 0;
}

/** 两层之间是否会产生 collision event。同样要求双向声明。 */
export function layersEmitEvents(a: LayerName, b: LayerName): boolean {
  return (EVENTS[a] & LAYERS[b]) !== 0 && (EVENTS[b] & LAYERS[a]) !== 0;
}

/** 从 interactionGroups 反解 membership 层名（debug draw 按层着色用）。 */
export function layerOfGroups(groups: number): LayerName | null {
  const member = (groups >>> 16) & 0xffff;
  for (const name of ALL_LAYERS) {
    if (LAYERS[name] === member) return name;
  }
  return null;
}

/**
 * 调试线框配色（spec §6 M3 第 7 条：按层着色）。
 * 用 0xRRGGBB 而不是 CSS 字符串：three 的 Color 直接吃数字，热路径少一次解析。
 */
export const LAYER_COLORS: Record<LayerName, number> = {
  WORLD_STATIC: 0x5b6577, // 冷灰：背景，不抢眼
  CHARACTER: 0x4fc3f7, // 青蓝：角色
  PROP: 0xffb74d, // 琥珀：可推道具
  SENSOR: 0xba68c8, // 紫：触发器
  AGENT: 0x81c784, // 绿：Agent
};
