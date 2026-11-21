import { describe, it, expect } from 'vitest';
import {
  buildDemoAgents,
  loopIntents,
  phaseOffsetSeconds,
  RING_RADIUS,
  PATROL_RADIUS,
  LOOP_PERIOD,
} from './agents-demo';
import type { Intent } from '../core/types';

// ───────────────────────────── 类型守卫 ─────────────────────────────
//
// `Intent` 是**可辨识联合**。直接写 `loopIntents(...)[0] as Extract<{t:'move'}, {t:'move'}>`
// 是错的：`Extract` 的第一个类型参数必须是整个联合 `Intent`，写成 `{t:'move'}` 只会
// 提取出 `{t:'move'}` 这个**缺字段**的窄类型，于是 `.to` / `.ms` / `.text` 全都报
// "Property does not exist"。这正是本轮挡住构建的 5 个 TS 错误。
// 正确做法是用类型守卫把 `Intent` 收窄到带字段的那个成员。

function isMove(i: Intent | undefined): i is Extract<Intent, { t: 'move' }> {
  return i !== undefined && i.t === 'move';
}
function isSay(i: Intent | undefined): i is Extract<Intent, { t: 'say' }> {
  return i !== undefined && i.t === 'say';
}
function isWait(i: Intent | undefined): i is Extract<Intent, { t: 'wait' }> {
  return i !== undefined && i.t === 'wait';
}

/** 取第 `n` 条意图并按 `t` 收窄；类型不对直接抛（测试里宁可炸，也不要静默跳过）。 */
function nth(spec: ReturnType<typeof buildDemoAgents>[number], lap: number, n: number): Intent {
  const it = loopIntents(spec, lap)[n];
  if (!it) throw new Error(`第 ${lap} 圈没有第 ${n} 条意图`);
  return it;
}

function moveTarget(spec: ReturnType<typeof buildDemoAgents>[number], lap: number): [number, number, number] {
  const it = nth(spec, lap, 0);
  if (!isMove(it)) throw new Error(`第 ${lap} 圈第 0 条不是 move，而是 ${it.t}`);
  return it.to;
}

describe('buildDemoAgents：确定性（spec §2.2 禁用随机）', () => {
  it('同样的 count 两次构建，逐字段完全相同', () => {
    const a = buildDemoAgents(6);
    const b = buildDemoAgents(6);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('源码里不含 Math.random / Date.now（静态检查，防止后人"顺手"加随机）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('./agents-demo.ts', import.meta.url));
    const src = readFileSync(path, 'utf8');
    // 必须先剥注释：文件头注释里就写着"不许用 Math.random"，
    // 直接对原文匹配会把解释文字当成违规（这条断言自己踩过一次）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/performance\.now/);
  });

  it('生成 6 个 Agent，名字与 tint 各不相同', () => {
    const specs = buildDemoAgents(6);
    expect(specs).toHaveLength(6);
    expect(new Set(specs.map((s) => s.name)).size).toBe(6);
    expect(new Set(specs.map((s) => s.tint)).size).toBe(6);
    expect(specs.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('count 不是 6 也成立（1 / 3 / 12）', () => {
    for (const n of [1, 3, 12]) {
      const specs = buildDemoAgents(n);
      expect(specs).toHaveLength(n);
      expect(specs.map((s) => s.index)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('count 非法抛 RangeError', () => {
    expect(() => buildDemoAgents(0)).toThrow(RangeError);
    expect(() => buildDemoAgents(-1)).toThrow(RangeError);
    expect(() => buildDemoAgents(1.5)).toThrow(RangeError);
  });
});

describe('相位错开（本轮验收的核心：6 个 Agent 不齐步走）', () => {
  it('起始位置沿圆周均匀分布，两两间距足够（不重叠）', () => {
    const specs = buildDemoAgents(6);
    for (let i = 0; i < specs.length; i++) {
      const p = specs[i]!.spawn;
      // 每个人都在半径 RING_RADIUS 的圆上
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(RING_RADIUS, 2);
    }
    // 两两最小距离：正六边形边长 = R（半径 4 → 边长 4）
    let minDist = Infinity;
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        const a = specs[i]!.spawn;
        const b = specs[j]!.spawn;
        minDist = Math.min(minDist, Math.hypot(a[0] - b[0], a[2] - b[2]));
      }
    }
    // 圆上 6 点均分 → 相邻弦长 = 2R·sin(π/6) = R = 4；对顶点 = 8
    expect(minDist).toBeGreaterThan(RING_RADIUS * 0.95);
  });

  it('相位偏移严格等间隔：index/6 × 周期', () => {
    const offsets = [0, 1, 2, 3, 4, 5].map((i) => phaseOffsetSeconds(i, 6, LOOP_PERIOD));
    expect(offsets[0]).toBeCloseTo(0, 12);
    expect(offsets[5]).toBeCloseTo((5 / 6) * LOOP_PERIOD, 12);
    // 相邻间隔恒定
    const gaps = offsets.slice(1).map((v, i) => v - offsets[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(LOOP_PERIOD / 6, 12);
  });

  it('6 个相位两两不同（不是都从 0 开始）', () => {
    const phases = [0, 1, 2, 3, 4, 5].map((i) => phaseOffsetSeconds(i, 6, LOOP_PERIOD));
    expect(new Set(phases.map((p) => p.toFixed(6))).size).toBe(6);
  });

  it('起始角度也错开：任意两人朝向圆周的角度差 ≥ 30°', () => {
    const specs = buildDemoAgents(6);
    const angles = specs.map((s) => Math.atan2(s.spawn[2], s.spawn[0]));
    for (let i = 0; i < angles.length; i++) {
      for (let j = i + 1; j < angles.length; j++) {
        let d = Math.abs(angles[i]! - angles[j]!);
        if (d > Math.PI) d = Math.PI * 2 - d;
        // 30° = π/6，留一点浮点余量
        expect(d).toBeGreaterThanOrEqual(Math.PI / 6 - 1e-6);
      }
    }
  });
});

describe('loopIntents：walk → say → wait 循环', () => {
  it('每圈是 [move, say, wait] 三条，顺序固定', () => {
    const spec = buildDemoAgents(6)[0]!;
    for (let lap = 0; lap < 6; lap++) {
      const intents = loopIntents(spec, lap);
      expect(intents.map((i) => i.t)).toEqual(['move', 'say', 'wait']);
    }
  });

  it('同一 (index, lap) 永远得到同一份意图（可复现）', () => {
    const specs = buildDemoAgents(6);
    for (const spec of specs) {
      for (let lap = 0; lap < 3; lap++) {
        expect(JSON.stringify(loopIntents(spec, lap))).toBe(
          JSON.stringify(loopIntents(spec, lap)),
        );
      }
    }
  });

  it('不同圈数走不同目标点（会绕圈，不是原地踏步）', () => {
    const spec = buildDemoAgents(6)[0]!;
    const targets = [0, 1, 2].map((lap) => {
      const t = moveTarget(spec, lap);
      return `${t[0].toFixed(3)},${t[2].toFixed(3)}`;
    });
    expect(new Set(targets).size).toBe(3);
    // 第 3 圈回到第 0 圈（巡逻点数组循环）
    expect(moveTarget(spec, 3)).toEqual(moveTarget(spec, 0));
    expect(moveTarget(spec, 4)).toEqual(moveTarget(spec, 1));
  });

  it('巡逻目标都在自己的站位附近（不会跑到别人身上）', () => {
    const specs = buildDemoAgents(6);
    for (const spec of specs) {
      for (let lap = 0; lap < 3; lap++) {
        const to = moveTarget(spec, lap);
        const d = Math.hypot(to[0] - spec.spawn[0], to[2] - spec.spawn[2]);
        // 巡逻点离站位正好 PATROL_RADIUS
        expect(d).toBeCloseTo(PATROL_RADIUS, 2);
      }
    }
  });

  it('6 个 Agent 的同一圈台词不完全相同（画面不呆板）', () => {
    const specs = buildDemoAgents(6);
    const lines = specs.map((s) => {
      const it = nth(s, 0, 1);
      if (!isSay(it)) throw new Error(`第 1 条不是 say，而是 ${it.t}`);
      return it.text;
    });
    // 至少 3 种不同的台词
    expect(new Set(lines).size).toBeGreaterThanOrEqual(3);
  });

  it('say 的默认时长是 3000ms（规格书 3s）', () => {
    const spec = buildDemoAgents(6)[0]!;
    const it = nth(spec, 0, 1);
    if (!isSay(it)) throw new Error(`第 1 条不是 say，而是 ${it.t}`);
    expect(it.ms).toBe(3000);
  });

  it('wait 时长因 index 而不同（长期不锁成齐步走），但仍然确定性', () => {
    const specs = buildDemoAgents(6);
    const waits = specs.map((s) => {
      const it = nth(s, 0, 2);
      if (!isWait(it)) throw new Error(`第 2 条不是 wait，而是 ${it.t}`);
      return it.ms;
    });
    // 1200 + (index%3)*200 → [1200, 1400, 1600, 1200, 1400, 1600]
    expect(waits).toEqual([1200, 1400, 1600, 1200, 1400, 1600]);
    expect(new Set(waits).size).toBeGreaterThan(1);
  });

  it('所有 move 目标都是有限数（脏数据不该进队列）', () => {
    for (const spec of buildDemoAgents(6)) {
      for (let lap = 0; lap < 6; lap++) {
        const to = moveTarget(spec, lap);
        expect(Number.isFinite(to[0])).toBe(true);
        expect(Number.isFinite(to[1])).toBe(true);
        expect(Number.isFinite(to[2])).toBe(true);
      }
    }
  });
});
