#!/usr/bin/env node
/**
 * 6 Agent 演示的可复跑验收脚本（spec §6 M9 第 5 条 / 验收证据 2、3、5）。
 *
 * ───────────────────────── 它测什么、不测什么 ─────────────────────────
 *
 * **测**（node 里能测准的）：
 *   - 6 个 Agent 在同一物理世界里各跑 1800 步（30 秒）的真实物理步耗时 avg/p50/p95/max
 *   - 每个 Agent 的位移、最终位置、完成的意图数、失败数
 *   - 意图失败的**真实样例输出**（不是构造的）
 *   - 队列上限行为（第 9 条被拒）
 *   - perceive 前后世界指纹一致
 *
 * **不测**（沙箱里起不了 Chromium，mojo 管道被禁）：
 *   - 画面 fps、drawCall、GPU 帧时间
 *   - "同屏看着不卡不抖"这种视觉判断
 *   这些如实标注为「未验证」，见输出末尾的 UNVERIFIED 段。
 *
 * 用法：
 *   node --import ./tools/ts-transform-loader.mjs tools/demo-agents.mts
 *   node --import ./tools/ts-transform-loader.mjs tools/demo-agents.mts --seconds 10
 *
 * 为什么不用 `npm run measure:fps`：那个要浏览器。这里测的是**物理与逻辑**，
 * 与渲染无关，所以数字可信且可在 CI 复跑。
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { Clock } from '../src/core/clock.ts';
import { World } from '../src/core/world.ts';
import { PHYSICS_DT } from '../src/core/types.ts';
import { parseRoom } from '../src/core/room.ts';
import { PhysicsWorld } from '../src/physics/engine.ts';
import { CharacterController, DEFAULT_CHARACTER } from '../src/physics/character.ts';
import { AgentSystem } from '../src/agents/system.ts';
import { buildDemoAgents, loopIntents, phaseOffsetSeconds, LOOP_PERIOD } from '../src/demo/agents-demo.ts';

// ───────────────────────────── 参数 ─────────────────────────────

const argv = process.argv.slice(2);
function argNum(name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const SECONDS = argNum('seconds', 30);
const AGENTS = argNum('agents', 6);
const STEPS = Math.round(SECONDS / PHYSICS_DT);

// ───────────────────────────── 房间 ─────────────────────────────

/**
 * 演示房间：一块 24×24 地板 + 一道墙 + 两个座位。
 *
 * 墙的位置是**算过的**，不是随手放的。`buildDemoAgents` 里：
 *   index=4 站位 (cos240°, sin240°)×4 = (-2.00, -3.46)
 *   index=5 站位 (cos300°, sin300°)×4 = ( 2.00, -3.46)
 * 它们的巡逻点最小 z ≈ -4.85（站位 -3.46 再减 PATROL_RADIUS 1.6 的 z 分量）。
 * 墙放在 z=-4.9（厚 0.2 → 面在 -4.8），角色半径 0.30 → 中心最多到 -4.50。
 * 于是 4 号与 5 号会**真的顶到墙上**，`blocked` 是物理产生的，不是我构造的字符串。
 *
 * 改了 `agents-demo.ts` 的 RING_RADIUS / PATROL_RADIUS 就要重算这面墙，
 * 否则那份失败证据会消失（脚本末尾的自检会报"没有意图失败"）。
 */
function demoRoom() {
  return parseRoom({
    name: 'agents-demo',
    spawn: [[0, 0, 0]],
    lights: [],
    static: [
      { type: 'box', size: [24, 0.2, 24], pos: [0, -0.1, 0], mat: 'floor' },
      { type: 'box', size: [16, 2.4, 0.2], pos: [0, 1.2, -4.9], mat: 'wall' },
    ],
    props: [],
    seats: [
      { id: 'seat-a', pos: [2, 0, 2], rot: Math.PI },
      { id: 'seat-b', pos: [-2, 0, 2], rot: 0 },
    ],
  });
}

// ───────────────────────────── 统计工具 ─────────────────────────────

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[i]!;
}

function round(v: number, d = 3): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** 世界指纹：perceive 无副作用的自检用（与 perceive.test.ts 同口径，但更粗）。 */
function fingerprint(world: World): string {
  const actors = world
    .listActors()
    .map((a) => `${a.id}:${a.transform.p.map((v) => v.toFixed(6)).join(',')}:${a.bubble?.text ?? '-'}`)
    .join('|');
  return `${world.actorCount}/${world.tickCount}/${world.now.toFixed(6)}/${actors}`;
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main(): Promise<void> {
  const room = demoRoom();
  const world = new World();
  const physics = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 32 });
  const clock = new Clock();

  // 物理控制器工厂：每个 Agent 一个胶囊。
  // y 用 CAPSULE_CENTER_HEIGHT + 一点余量，落地由物理负责（不写死贴地）。
  const capsuleCenter = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;
  const controllers = new Map<string, CharacterController>();

  const system = new AgentSystem({
    world,
    room,
    createController: (id) => {
      const c = new CharacterController(RAPIER, physics, 0, capsuleCenter + 0.05, 0);
      controllers.set(id, c);
      return c;
    },
  });

  // ── 失败记录：这就是"意图失败回报的样例输出"的来源 ──
  const failures: Array<{ id: string; reason: string; intent?: string; at: number }> = [];
  system.onFailure((e) => {
    failures.push({
      id: e.id,
      reason: e.reason,
      ...(e.intent ? { intent: e.intent } : {}),
      at: world.now,
    });
  });

  /**
   * 说话时间线。这是「相位错开」的**直接证据**：
   * 6 个 Agent 的开口时刻如果都挤在同一秒，说明相位没生效。
   * 记录 world.say 的实际发生时刻（订阅事件总线，不另算一遍）。
   */
  const speech: Array<{ id: string; at: number; text: string }> = [];
  world.events.on('actor:say', (e) => {
    speech.push({ id: e.id, at: world.now, text: e.text });
  });

  // ── 进场 6 个 Agent ──
  const specs = buildDemoAgents(AGENTS);
  const runtimes = specs.map((spec) => {
    const rt = system.join({
      name: spec.name,
      tint: spec.tint,
      spawnPos: spec.spawn,
    });
    // 控制器出生点必须和 world 里的位置一致，否则第一帧会瞬移
    const c = controllers.get(rt.id)!;
    c.teleport(spec.spawn[0], capsuleCenter + 0.05, spec.spawn[2]);
    return { rt, spec };
  });

  // ── 相位错开：每个 Agent 的第一次提交延迟 phaseOffsetSeconds ──
  // 用"到点才提交第一圈"而不是"先排队等着"，这样队列不会被提前占满。
  const started = new Set<number>();
  const laps = new Map<string, number>();

  const submitLap = (index: number): void => {
    const { rt, spec } = runtimes[index]!;
    const lap = laps.get(rt.id) ?? 0;
    const intents = loopIntents(spec, lap);
    const results = system.submitMany(rt.id, intents);
    for (const r of results) {
      if ('t' in r && r.t === 'failed') {
        failures.push({
          id: rt.id,
          reason: r.reason,
          ...(r.intent ? { intent: r.intent } : {}),
          at: world.now,
        });
      }
    }
    laps.set(rt.id, lap + 1);
  };

  // ── 主循环：1800 步 ──
  const stepMs: number[] = [];
  const frameMs: number[] = [];
  const perAgentSteps = new Map<string, number>();
  const startPos = new Map<string, [number, number, number]>();
  /** 累计路径长度（每步位移之和）。直线位移看不出"绕圈"，路径长度能。 */
  const pathLen = new Map<string, number>();
  const lastPos = new Map<string, [number, number, number]>();
  for (const { rt } of runtimes) {
    const p = world.getActor(rt.id)!.transform.p;
    startPos.set(rt.id, [p[0], p[1], p[2]]);
    lastPos.set(rt.id, [p[0], p[1], p[2]]);
    pathLen.set(rt.id, 0);
    perAgentSteps.set(rt.id, 0);
  }

  /**
   * 一个物理步。顺序与 `main.ts` **完全一致**：物理先结算，系统再读结果。
   *
   * 第一版写成 `system.tick() → physics.step()`，结果控制器快照与实体表位置
   * 稳定差 0.0367m —— 那正好是 2.2m/s × 1/60 的**一帧滞后**，不是物理 bug，
   * 是顺序错了：`controller.update()` 设的是 `setNextKinematicTranslation`
   * （下一步才生效），所以它必须在 step 之后跑，`writeTransform()` 才能读到
   * 本步结算完的真实位置。这个错在 e2e-physics.test.ts 里被断言抓住过。
   */
  const stepOnce = (): void => {
    physics.step(PHYSICS_DT);
    system.tick();
    world.tick(PHYSICS_DT);
  };

  // 预热 30 步：让角色落地、JIT 稳定。预热不计入统计。
  //
  // 注意：预热会把 `world.now` 推到 0.5s。相位判断必须相对**主循环起点**，
  // 不能直接用绝对 `world.now` —— 否则 index=0（相位 0）与 index=1（相位 0.5）
  // 会被预热吃掉，两人在同一时刻开口，"错开"就只剩 4 个人在错开。
  // 第一版就是这么错的：实测 a:1 与 a:2 首次开口都是 0.500s，相邻间隔 0.00s。
  // 这条已固化成 src/demo/phase-schedule.test.ts 的回归用例。
  for (let i = 0; i < 30; i++) stepOnce();
  /** 相位计时基准：主循环开始时的世界时间。 */
  const demoStart = world.now;

  // 每次系统 tick 里轮询每个 Agent：当前没意图在跑就提交下一圈。
  // 这样"walk→say→wait"是真正一条条走的，而不是每帧灌一堆意图。
  const maybeSubmit = (): void => {
    for (let i = 0; i < runtimes.length; i++) {
      const { rt, spec } = runtimes[i]!;
      // 相位：主循环开始后的世界时间过了该 Agent 的偏移才允许第一次提交
      if (!started.has(i)) {
        const elapsed = world.now - demoStart;
        if (elapsed + 1e-9 >= phaseOffsetSeconds(i, runtimes.length, LOOP_PERIOD)) {
          started.add(i);
        } else {
          continue;
        }
      }
      // 队列空了且执行器不忙 → 提交下一圈
      if (rt.queue.isEmpty && !rt.executor.busy) submitLap(i);
      void spec;
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const t0 = performance.now();

    maybeSubmit();
    stepOnce();

    const ms = performance.now() - t0;
    stepMs.push(ms);

    for (const { rt } of runtimes) {
      perAgentSteps.set(rt.id, (perAgentSteps.get(rt.id) ?? 0) + 1);
      // 累计路径长度：直线位移会掩盖绕圈，这个数字才说明"它真的在走"
      const p = world.getActor(rt.id)?.transform.p;
      const prev = lastPos.get(rt.id);
      if (p && prev) {
        const d = Math.hypot(p[0] - prev[0], p[2] - prev[2]);
        // 过滤瞬移（>1m/步 不可能是走路，是 teleport/重生）
        if (d < 1) pathLen.set(rt.id, (pathLen.get(rt.id) ?? 0) + d);
        prev[0] = p[0];
        prev[1] = p[1];
        prev[2] = p[2];
      }
    }
  }

  // 顺带测一下 Clock 在 60fps 输入下的表现（不是墙钟 fps，是"每帧几步"）
  for (let i = 0; i < 600; i++) {
    const t0 = performance.now();
    clock.runSteps(1 / 60, (dt) => {
      // 与 stepOnce 同序：物理先结算，系统再读（dt 就是 PHYSICS_DT）
      physics.step(dt);
      system.tick();
      world.tick(dt);
    });
    frameMs.push(performance.now() - t0);
  }

  // ── 汇总 ──
  const sortedStep = [...stepMs].sort((a, b) => a - b);
  const sortedFrame = [...frameMs].sort((a, b) => a - b);
  const avg = stepMs.reduce((a, b) => a + b, 0) / stepMs.length;

  console.log('═══ 6 Agent 演示 · 实测 ═══');
  console.log(`环境      node ${process.version} / ${process.platform} ${process.arch}`);
  console.log(`房间      ${room.name}（地板 24×24 + 一面墙 + 2 座位）`);
  console.log(`Agent     ${runtimes.length} 个，各自 walk→say→wait 循环，相位 index/6 错开`);
  console.log(`时长      ${SECONDS}s = ${STEPS} 步 @ 1/60（另有 600 帧 60fps 的 Clock 压测）`);
  console.log('');

  console.log('── 物理+逻辑单步耗时（毫秒，含 system.tick + physics.step + world.tick）──');
  console.log(`  avg   ${round(avg, 4)}`);
  console.log(`  p50   ${round(percentile(sortedStep, 0.5), 4)}`);
  console.log(`  p95   ${round(percentile(sortedStep, 0.95), 4)}`);
  console.log(`  p99   ${round(percentile(sortedStep, 0.99), 4)}`);
  console.log(`  max   ${round(sortedStep[sortedStep.length - 1] ?? 0, 4)}`);
  console.log(`  预算  16.67ms/帧（60fps）→ 占用 ${round((percentile(sortedStep, 0.95) / 16.67) * 100, 2)}%（p95）`);
  console.log('');

  console.log('── Clock 60fps 输入下每帧耗时（毫秒，1 帧 = 1 物理步）──');
  console.log(`  avg   ${round(sortedFrame.reduce((a, b) => a + b, 0) / sortedFrame.length, 4)}`);
  console.log(`  p95   ${round(percentile(sortedFrame, 0.95), 4)}`);
  console.log(`  max   ${round(sortedFrame[sortedFrame.length - 1] ?? 0, 4)}`);
  console.log(`  overruns ${clock.overruns}（单帧超 3 步被丢弃的次数，应为 0）`);
  console.log('');

  console.log('── 每个 Agent 的最终状态 ──');
  console.log('  id        name    steps  路径长(m)  净位移(m)  最终位置                  完成  失败');
  for (const { rt, spec } of runtimes) {
    const p = world.getActor(rt.id)?.transform.p;
    const s = startPos.get(rt.id)!;
    const moved = p ? Math.hypot(p[0] - s[0], p[2] - s[2]) : 0;
    const walked = pathLen.get(rt.id) ?? 0;
    const st = rt.executor.stats;
    console.log(
      `  ${rt.id.padEnd(8)} ${spec.name.padEnd(6)} ${String(perAgentSteps.get(rt.id)).padEnd(6)} ` +
        `${walked.toFixed(2).padStart(9)}  ${moved.toFixed(2).padStart(9)}  ` +
        `${p ? `[${p.map((v) => v.toFixed(2)).join(', ')}]` : 'despawned'}`.padEnd(26) +
        `${String(st.completed).padStart(4)}  ${String(st.failed).padStart(4)}`,
    );
  }
  console.log('');

  // ── 说话时间线：相位错开的直接证据 ──
  console.log('── 说话时间线（相位错开的直接证据）──');
  if (speech.length === 0) {
    console.log('  没有任何 Agent 说过话。');
  } else {
    const firstRound = new Map<string, number>();
    for (const s of speech) {
      if (!firstRound.has(s.id)) firstRound.set(s.id, s.at);
    }
    const firstTimes = [...firstRound.values()].sort((a, b) => a - b);
    console.log(`  总发言 ${speech.length} 次，前 8 条：`);
    for (const s of speech.slice(0, 8)) {
      console.log(`    ${s.at.toFixed(3).padStart(7)}s  ${s.id.padEnd(6)}  「${s.text}」`);
    }
    console.log('');
    console.log('  每个 Agent 的**首次开口时刻**（相位 = index/6 × 3s = 0/0.5/1.0/1.5/2.0/2.5s）：');
    for (const [id, t] of [...firstRound].sort((a, b) => a[1] - b[1])) {
      console.log(`    ${id.padEnd(6)} ${t.toFixed(3)}s`);
    }
    const spread = firstTimes[firstTimes.length - 1]! - firstTimes[0]!;
    console.log(`  首轮开口时刻跨度 = ${spread.toFixed(3)}s（若为 0 说明 6 个人齐步走）`);
    // 相邻间隔
    const gaps: number[] = [];
    for (let i = 1; i < firstTimes.length; i++) gaps.push(firstTimes[i]! - firstTimes[i - 1]!);
    if (gaps.length > 0) {
      console.log(`  相邻间隔 = [${gaps.map((g) => g.toFixed(2)).join(', ')}]s`);
    }
  }
  console.log('');

  console.log('── 物理指标 ──');
  const stats = physics.stats();
  console.log(`  steps ${stats.steps}  colliders ${stats.colliders}  dynamicBodies ${stats.dynamicBodies}`);
  console.log(`  avgStepMs ${stats.avgStepMs}  maxStepMs ${stats.maxStepMs}  pooledCreated ${stats.pooledCreated}`);
  console.log('');

  // ── 意图失败样例 ──
  console.log('── 意图失败回报（真实发生，不是构造的）──');
  if (failures.length === 0) {
    console.log('  本次运行没有意图失败。');
    console.log('  提示：--seconds 调长，或确认 6 号 Agent 的巡逻点确实落在墙后。');
  } else {
    for (const f of failures.slice(0, 12)) {
      console.log(
        `  { t:'failed', id:'${f.id}', reason:'${f.reason}', intent:'${f.intent ?? '-'}', at:${f.at.toFixed(3)}s }`,
      );
    }
    if (failures.length > 12) console.log(`  ... 另有 ${failures.length - 12} 条`);
    const byReason = new Map<string, number>();
    for (const f of failures) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
    console.log(`  合计 ${failures.length} 条，按原因：${[...byReason].map(([k, v]) => `${k}×${v}`).join(', ')}`);
  }
  console.log('');

  // ── 队列上限实测 ──
  console.log('── 队列上限行为实测（MAX_PENDING_INTENTS = 8）──');
  const probe = runtimes[0]!.rt;
  // 先把队列灌满：直接往 queue 里 push，不经过执行器
  const pushed: boolean[] = [];
  for (let i = 0; i < 10; i++) {
    const r = probe.queue.push({ t: 'wait', ms: 60000 }, world.now);
    pushed.push('ok' in r);
  }
  console.log(`  连续 push 10 条：成功 ${pushed.filter(Boolean).length} 条，被拒 ${pushed.filter((v) => !v).length} 条`);
  console.log(`  队列实际 size = ${probe.queue.size}（capacity = ${probe.queue.capacity}）`);
  const s = probe.queue.stats();
  console.log(`  stats: pushed=${s.pushed} rejected=${s.rejected} pending=${s.pending}`);
  probe.queue.clear();
  console.log('');

  // ── perceive 无副作用自检 ──
  console.log('── perceive 无副作用自检 ──');
  const target = runtimes[0]!.rt.id;
  const before = fingerprint(world);
  for (let i = 0; i < 100; i++) system.perceive(target);
  const after = fingerprint(world);
  console.log(`  连续 perceive 100 次：世界指纹${before === after ? '完全一致 ✓' : '发生变化 ✗'}`);
  if (before !== after) {
    console.log(`    before: ${before.slice(0, 120)}…`);
    console.log(`    after : ${after.slice(0, 120)}…`);
  }
  const perception = system.perceive(target)!;
  console.log(`  样例感知：self=${perception.self.name} p=[${perception.self.p.map((v) => v.toFixed(2)).join(',')}] anim=${perception.self.anim}`);
  console.log(`           nearby=${perception.nearby.length} 个，最近：${perception.nearby[0]?.name ?? '无'} @ ${perception.nearby[0]?.dist.toFixed(2) ?? '-'}m`);
  console.log(`           bubbles=${perception.bubbles.length} 条`);
  console.log('');

  // ── 未验证项（诚实清单）──
  console.log('── 未验证（沙箱限制，不编数字）──');
  console.log('  ✗ 画面 fps / drawCall / GPU 帧时间：沙箱起不了 Chromium（mojo 管道被禁）。');
  console.log('  ✗ "6 Agent 同屏不卡不抖"的视觉判断：需要人在真机 GPU 上看。');
  console.log('  ✗ 气泡在屏幕上的位置与淡出：属于渲染层（M1/M5）。');
  console.log('  ✓ 以上三项的复跑方式：在正常机器上 `npm run dev` 后看 __worldDebug.read().fps，');
  console.log('    或 `npm run measure:fps`（需浏览器）。');
  console.log('');

  // ── 断言（脚本自身也是验收：失败要非零退出）──
  const problems: string[] = [];
  const maxStep = sortedStep[sortedStep.length - 1] ?? 0;
  if (maxStep > 16.67) {
    problems.push(`单步最大耗时 ${round(maxStep, 4)}ms 超过 16.67ms 帧预算`);
  }
  if (before !== after) problems.push('perceive 改变了世界状态');
  if (pushed.filter(Boolean).length !== 8) {
    problems.push(`队列上限不是 8（实际接受 ${pushed.filter(Boolean).length} 条）`);
  }
  if (runtimes.some(({ rt }) => (perAgentSteps.get(rt.id) ?? 0) !== STEPS)) {
    problems.push('有 Agent 没有跑满全部步数');
  }
  // 每个 Agent 都真的走过（路径长度 > 1m），不是站着不动
  for (const { rt, spec } of runtimes) {
    const walked = pathLen.get(rt.id) ?? 0;
    if (walked < 1) problems.push(`${spec.name}(${rt.id}) 路径长度只有 ${walked.toFixed(2)}m，几乎没有走动`);
  }
  // 走位是"绕圈"：路径长度必须明显大于净位移（否则可能只是直线漂移）
  const anyLoop = runtimes.some(({ rt }) => {
    const walked = pathLen.get(rt.id) ?? 0;
    const p = world.getActor(rt.id)?.transform.p;
    const s = startPos.get(rt.id)!;
    const net = p ? Math.hypot(p[0] - s[0], p[2] - s[2]) : 0;
    return walked > net * 2 && walked > 5;
  });
  if (!anyLoop) problems.push('没有任何 Agent 表现出"绕圈"（路径长度未显著大于净位移）');
  // 相位错开：首轮开口时刻的跨度必须接近 5/6 个周期（2.5s），而不是 0
  if (speech.length > 0) {
    const firstRound = new Map<string, number>();
    for (const s of speech) if (!firstRound.has(s.id)) firstRound.set(s.id, s.at);
    if (firstRound.size === runtimes.length) {
      const times = [...firstRound.values()];
      const spread = Math.max(...times) - Math.min(...times);
      if (spread < LOOP_PERIOD * 0.5) {
        problems.push(
          `首轮开口跨度只有 ${spread.toFixed(2)}s（期望 ≈${((5 / 6) * LOOP_PERIOD).toFixed(2)}s）——相位可能没生效`,
        );
      }
      // 相邻间隔必须接近 LOOP_PERIOD/N。第一版因为用绝对 world.now 判相位，
      // 预热 0.5s 把 index=0 与 index=1 压成同一时刻（间隔 0.00s），这条断言会抓住它。
      const sorted = [...times].sort((a, b) => a - b);
      const expectedGap = LOOP_PERIOD / runtimes.length;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i]! - sorted[i - 1]!;
        if (Math.abs(gap - expectedGap) > expectedGap * 0.5) {
          problems.push(
            `首轮开口相邻间隔 ${gap.toFixed(2)}s 偏离期望 ${expectedGap.toFixed(2)}s 超过 50%`,
          );
          break;
        }
      }
    }
  } else {
    problems.push('没有任何 Agent 说话');
  }

  console.log(problems.length === 0 ? '自检：全部通过 ✓' : `自检：${problems.length} 项不通过 ✗`);
  for (const p of problems) console.log(`  - ${p}`);

  system.dispose();
  physics.dispose();

  if (problems.length > 0) process.exit(1);
}

await main();
