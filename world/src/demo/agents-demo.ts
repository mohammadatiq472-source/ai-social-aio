/**
 * 6 Agent 演示（spec §6 M9 第 5 条：各自循环 walk→say→wait，相位错开）。
 *
 * ═══════════════ 相位必须确定性，不许 Math.random() ═══════════════
 *
 * 规格书 §2.2 第 5 条「确定性纪律」：禁用随机。原因不只是"可复现"这么抽象——
 * 一旦用了随机，下面这些验收全都做不了：
 *
 * - **不能回归**。改一行物理代码，6 个 Agent 走的路线全变，你无法判断
 *   "行为变差"是代码退化还是随机种子不同。
 * - **不能录屏/回放**。v0.2 的网络快照要靠同一 tick 的状态对齐。
 * - **不能对比两个版本**。A/B 两组 Agent 的轨迹没有可比性。
 *
 * 所以相位用**纯算术**分配：第 i 个 Agent 的起始相位 = `i / N`，
 * 再乘上循环总周期。6 个 Agent 的 speak 时刻天然落在 1/6 的间隔上，
 * 画面上看起来就是"错开说话"，而同一个 i 每次都得到同一时刻。
 *
 * ═══════════════ 循环结构 ═══════════════
 *
 * 每个 Agent 的循环（周期 `PERIOD` 秒）：
 *
 *   walk  ──(走到目标)──▶ say ──(说完)──▶ wait ──▶ 下一个目标
 *
 * 目标点是**预定的环形路径**（`PATROL`），按 `(index + lap) % PATROL.length`
 * 取，所以每个 Agent 沿自己的子序列绕圈，不会互相踩。走位半径 1.6m，
 * 6 个 Agent 均匀分布在半径 4m 的圆上，两两间距 ≈ 4m，不会挤在一起。
 *
 * 相位错开落在**起点**上：`phase = index / N`，起点沿圆周偏移 `phase * 2π`。
 * 这样不需要"等相位"就能保证开口时刻错开——它们走到各自目标的时间本来就不同。
 */

import type { Intent } from '../core/types';

/** 一个演示 Agent 的静态配置（确定性：全部由 index 推导，无随机）。 */
export interface DemoAgentSpec {
  /** 0..N-1。 */
  index: number;
  name: string;
  /** 染色变体 key（M2 的一份几何 × N 份材质）。 */
  tint: string;
  /** 起始位置（圆周上的一个点）。 */
  spawn: [number, number, number];
  /** 巡逻目标点（按顺序循环）。 */
  patrol: Array<[number, number, number]>;
  /** 这个 Agent 说的话（循环使用）。 */
  lines: string[];
}

/** 圆周半径（米）。6 个 Agent 均分，两两弦长 ≈ 4.0m。 */
export const RING_RADIUS = 4;

/** 每个 Agent 的巡逻半径（相对自己的站位，米）。 */
export const PATROL_RADIUS = 1.6;

/** 循环周期（秒）。walk(≈2.2m/2.2mps≈1s) + say(0.4s) + wait(1.6s) ≈ 3s。 */
export const LOOP_PERIOD = 3;

/** 名字表。刻意用中性名，不暗示任何真实人物。 */
const NAMES = ['阿岩', '小满', '林澈', '南枝', '老周', '青禾'] as const;

/** 染色 key 表。与 assets/registry 的变体命名一致（`tint-0`..`tint-5`）。 */
const TINTS = ['tint-0', 'tint-1', 'tint-2', 'tint-3', 'tint-4', 'tint-5'] as const;

/** 台词表。短句，气泡 3s 内能读完。 */
const LINES: readonly (readonly string[])[] = [
  ['这边光线不错。', '我先绕一圈。'],
  ['有人吗？', '这地方比想象的大。'],
  ['地面挺平的。', '要不要一起走走？'],
  ['我站这儿一会儿。', '风从那边吹过来。'],
  ['刚进来，还在认路。', '台阶能上去吗？'],
  ['箱子好像能推。', '我试试走过去。'],
];

/**
 * 生成 N 个演示 Agent 的配置。
 *
 * **纯函数**：同样的 `count` 永远得到逐字段相同的数组。
 * 相位错开用 `index / count`，不用随机数、不用 `Date.now()`、不用 Map 迭代顺序。
 */
export function buildDemoAgents(count = 6): DemoAgentSpec[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`buildDemoAgents: count 必须是 ≥1 的整数，收到 ${count}`);
  }
  const out: DemoAgentSpec[] = [];
  for (let i = 0; i < count; i++) {
    // 相位：i/N 圈。这是"错开"的唯一来源，必须确定性。
    const phase = i / count;
    const baseAngle = phase * Math.PI * 2;
    const sx = Math.cos(baseAngle) * RING_RADIUS;
    const sz = Math.sin(baseAngle) * RING_RADIUS;

    // 巡逻点：绕自己的站位转 3 个点，方向再按 index 反向，避免所有人同向绕圈
    const dir = i % 2 === 0 ? 1 : -1;
    const patrol: Array<[number, number, number]> = [];
    for (let k = 0; k < 3; k++) {
      const a = baseAngle + dir * ((k + 1) / 3) * Math.PI * 2;
      patrol.push([
        round3(sx + Math.cos(a) * PATROL_RADIUS),
        0,
        round3(sz + Math.sin(a) * PATROL_RADIUS),
      ]);
    }

    out.push({
      index: i,
      name: NAMES[i % NAMES.length]!,
      tint: TINTS[i % TINTS.length]!,
      spawn: [round3(sx), 0, round3(sz)],
      patrol,
      lines: [...(LINES[i % LINES.length] ?? ['…'])],
    });
  }
  return out;
}

/**
 * 一个 Agent 在某个循环圈数里该提交的意图序列。
 *
 * 这是**纯函数**，单测可以直接断言"第 0 圈和第 1 圈的序列不同、但同一个
 * (index, lap) 永远得到同一份"。demo 脚本与测试共用它，避免两处各写一套。
 *
 * @param spec Agent 配置
 * @param lap  第几圈（从 0 开始）
 */
export function loopIntents(spec: DemoAgentSpec, lap: number): Intent[] {
  const target = spec.patrol[lap % spec.patrol.length]!;
  const line = spec.lines[lap % spec.lines.length]!;
  return [
    { t: 'move', to: [target[0], target[1], target[2]], speed: 'walk' },
    // say 与 move 一起提交：executor 的旁路车道会让它**立刻**开口，
    // 同时继续走（spec §6 M9 第 3 条：say 不阻塞移动）。
    { t: 'say', text: line, ms: 3000 },
    // wait 用相位微调：让 6 个 Agent 的 wait 时长不完全相同，
    // 长期看不会锁成"齐步走"。仍然确定性（index 决定，不是随机）。
    { t: 'wait', ms: 1200 + (spec.index % 3) * 200 },
  ];
}

/** 相位偏移（秒）：第 i 个 Agent 的循环起点比第 0 个晚多少。 */
export function phaseOffsetSeconds(index: number, count = 6, period = LOOP_PERIOD): number {
  return (index / count) * period;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
