import { describe, it, expect } from 'vitest';
import { World } from '../core/world';
import { parseRoom } from '../core/room';
import { AgentSystem } from '../agents/system';
import {
  buildDemoAgents,
  loopIntents,
  phaseOffsetSeconds,
  LOOP_PERIOD,
} from './agents-demo';

/**
 * 6 Agent 的**相位调度**回归测试（纯逻辑，无物理）。
 *
 * 为什么要在 vitest 里再测一遍（`tools/demo-agents.mts` 已经测了真实物理）：
 * 那条真实链路的相位错误（预热 0.5s 把 index 0 与 1 压到同一时刻）
 * 只有在跑满 30s 的脚本输出里才看得出来。这个文件把"相位调度"抽成
 * 一个 60 行的纯逻辑仿真，于是同样的 bug 会在 `npx vitest run` 里立刻红。
 *
 * 仿真的规则与 tools/demo-agents.mts 的 maybeSubmit 逐条对应：
 *   1. 世界时间过了 `phaseOffsetSeconds(i)` 才允许第一次提交
 *   2. 队列空且执行器不忙 → 提交下一圈（move + say + wait）
 *   3. say 在提交的那一 tick 就生效（executor 的旁路车道）
 */
interface SimResult {
  /** 每个 Agent 的首次开口时刻。 */
  firstSpeech: Map<string, number>;
  /** 所有发言记录。 */
  speech: Array<{ id: string; at: number; text: string }>;
  /** 每个 Agent 的开口次数。 */
  speechCount: Map<string, number>;
}

function simulate(opts: { seconds: number; warmupSeconds?: number }): SimResult {
  const world = new World();
  const room = parseRoom({
    name: 'phase-sim',
    spawn: [[0, 0, 0]],
    lights: [],
    static: [],
    props: [],
    seats: [],
  });
  const system = new AgentSystem({ world, room });

  const speech: SimResult['speech'] = [];
  world.events.on('actor:say', (e) => {
    speech.push({ id: e.id, at: world.now, text: e.text });
  });

  const specs = buildDemoAgents(6);
  const runtimes = specs.map((spec) => ({
    rt: system.join({ name: spec.name, spawnPos: spec.spawn }),
    spec,
  }));

  // 预热：把世界时间推一段（复现真实脚本的行为）
  const warmup = opts.warmupSeconds ?? 0;
  const warmupSteps = Math.round(warmup / (1 / 60));
  for (let i = 0; i < warmupSteps; i++) {
    world.tick(1 / 60);
    system.tick();
  }
  const demoStart = world.now;

  const started = new Set<number>();
  const laps = new Map<string, number>();
  const steps = Math.round(opts.seconds / (1 / 60));

  for (let step = 0; step < steps; step++) {
    for (let i = 0; i < runtimes.length; i++) {
      const { rt, spec } = runtimes[i]!;
      if (!started.has(i)) {
        const elapsed = world.now - demoStart;
        if (elapsed + 1e-9 >= phaseOffsetSeconds(i, runtimes.length, LOOP_PERIOD)) {
          started.add(i);
        } else {
          continue;
        }
      }
      if (rt.queue.isEmpty && !rt.executor.busy) {
        const lap = laps.get(rt.id) ?? 0;
        system.submitMany(rt.id, loopIntents(spec, lap));
        laps.set(rt.id, lap + 1);
      }
    }
    system.tick();
    world.tick(1 / 60);
  }

  const firstSpeech = new Map<string, number>();
  const speechCount = new Map<string, number>();
  for (const s of speech) {
    if (!firstSpeech.has(s.id)) firstSpeech.set(s.id, s.at);
    speechCount.set(s.id, (speechCount.get(s.id) ?? 0) + 1);
  }

  system.dispose();
  return { firstSpeech, speech, speechCount };
}

describe('6 Agent 相位调度（回归：预热不能吃掉相位）', () => {
  it('无预热时：首轮开口间隔严格等于 LOOP_PERIOD/6 = 0.5s', () => {
    const { firstSpeech } = simulate({ seconds: 10 });
    expect(firstSpeech.size).toBe(6);

    const times = [...firstSpeech.values()].sort((a, b) => a - b);
    const expectedGap = LOOP_PERIOD / 6;
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeCloseTo(expectedGap, 2);
    }
    // 跨度 = 5 × 0.5 = 2.5s
    expect(times[times.length - 1]! - times[0]!).toBeCloseTo(2.5, 2);
  });

  it('有 0.5s 预热时仍然间隔 0.5s（相位相对主循环起点算，不是绝对 world.now）', () => {
    // 这正是 tools/demo-agents.mts 第一版的 bug：
    // 用绝对 world.now 判相位时，预热 0.5s 会让 index=0（相位 0）与
    // index=1（相位 0.5）在同一时刻开口，间隔变成 0.00s。
    const { firstSpeech } = simulate({ seconds: 10, warmupSeconds: 0.5 });
    expect(firstSpeech.size).toBe(6);

    const times = [...firstSpeech.values()].sort((a, b) => a - b);
    const expectedGap = LOOP_PERIOD / 6;
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeCloseTo(expectedGap, 2);
    }
  });

  it('6 个人都在前 3.5 秒内开口（没有谁被饿死）', () => {
    const { firstSpeech } = simulate({ seconds: 10, warmupSeconds: 0.5 });
    const demoStart = 0.5; // 预热
    for (const [id, at] of firstSpeech) {
      expect(at - demoStart, `${id} 的首次开口太晚`).toBeLessThan(LOOP_PERIOD + 0.6);
    }
  });

  it('长期运行：每个人都反复开口（循环真的在转）', () => {
    const { speechCount } = simulate({ seconds: 30 });
    expect(speechCount.size).toBe(6);
    for (const [id, n] of speechCount) {
      // 30s / 3s 周期 ≈ 10 圈，至少要说 5 次
      expect(n, `${id} 只说了 ${n} 次`).toBeGreaterThanOrEqual(5);
    }
  });

  it('开口总数接近 6 × 圈数（不会重复提交导致爆量）', () => {
    const { speech } = simulate({ seconds: 30 });
    const laps = Math.floor(30 / LOOP_PERIOD);
    // 每圈每人说 1 次：期望 ≈ 6 × 10 = 60，允许 ±50% 的边界误差
    expect(speech.length).toBeGreaterThan(laps * 6 * 0.5);
    expect(speech.length).toBeLessThan(laps * 6 * 2);
  });

  it('同样的仿真跑两次，首次开口时刻逐位相同（确定性）', () => {
    const a = simulate({ seconds: 10, warmupSeconds: 0.5 });
    const b = simulate({ seconds: 10, warmupSeconds: 0.5 });
    const norm = (m: Map<string, number>): string =>
      [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k}@${v.toFixed(6)}`).join('|');
    expect(norm(b.firstSpeech)).toBe(norm(a.firstSpeech));
  });

  it('相位偏移量本身：index=0 是 0，index=5 是 2.5s', () => {
    expect(phaseOffsetSeconds(0, 6, LOOP_PERIOD)).toBe(0);
    expect(phaseOffsetSeconds(5, 6, LOOP_PERIOD)).toBeCloseTo(2.5, 12);
  });
});
