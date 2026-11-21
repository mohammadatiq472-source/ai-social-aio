import { describe, it, expect } from 'vitest';
import { IntentQueue } from './queue';
import {
  IntentExecutor,
  idleInput,
  toLocomotionInput,
  describeResult,
  type ControlInput,
  type ExecutorContext,
  type ExecutorHooks,
  type SeatRef,
} from './executor';
import type { Intent } from '../core/types';

// ───────────────────────────── 测试替身 ─────────────────────────────

/**
 * 记录型钩子。所有副作用都落进数组，测试直接断言"发生了什么"。
 * 这也证明了执行器**没有别的出口**：如果它偷偷改世界，这里看不到，世界也不会变。
 */
function makeHooks(): ExecutorHooks & {
  said: Array<{ text: string; ms: number }>;
  emoted: string[];
  sat: string[];
  left: number;
  failures: Array<{ reason: string; intent?: Intent['t'] }>;
} {
  const said: Array<{ text: string; ms: number }> = [];
  const emoted: string[] = [];
  const sat: string[] = [];
  const failures: Array<{ reason: string; intent?: Intent['t'] }> = [];
  let left = 0;
  return {
    said,
    emoted,
    sat,
    failures,
    get left() {
      return left;
    },
    say(text, ms) {
      said.push({ text, ms });
    },
    emote(name) {
      emoted.push(name);
    },
    sit(id) {
      sat.push(id);
    },
    leave() {
      left += 1;
    },
    fail(reason, intent) {
      failures.push(intent ? { reason, intent: intent.t } : { reason });
    },
  };
}

/** 可控上下文：位置由测试直接指定（模拟物理每 tick 报告的结果）。 */
function makeCtx(over: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    now: 0,
    dt: 1 / 60,
    pos: [0, 0.85, 0],
    yaw: 0,
    grounded: true,
    seats: [],
    ...over,
  };
}

/** 推进 n 步，位置按"沿最后一条 input 的方向走 dt 秒"演进（简化物理）。 */
function run(
  ex: IntentExecutor,
  q: IntentQueue,
  hooks: ExecutorHooks,
  steps: number,
  ctx: ExecutorContext,
  opts: { speed?: number; onStep?: (input: ControlInput, i: number) => void } = {},
): ControlInput {
  const speed = opts.speed ?? 2.2;
  let cur = ctx;
  let last = idleInput();
  for (let i = 0; i < steps; i++) {
    last = ex.step(q, cur, hooks);
    opts.onStep?.(last, i);
    // 假物理：只吃 dirX/dirZ，按 walk 速度积分（真物理在 physics/character.ts）
    cur = {
      ...cur,
      now: cur.now + cur.dt,
      pos: [
        cur.pos[0] + last.dirX * speed * cur.dt,
        cur.pos[1],
        cur.pos[2] + last.dirZ * speed * cur.dt,
      ],
    };
  }
  return last;
}

// ───────────────────────────── 核心不变量 ─────────────────────────────

describe('IntentExecutor：绝不直接改 transform（spec §4.2 硬规则）', () => {
  it('ControlInput 里没有任何位置字段', () => {
    const ci = idleInput();
    const keys = Object.keys(ci).sort();
    // 这是结构性证明：类型里没有 p/pos/transform，运行期也就写不出来
    expect(keys).toEqual([
      'dirX',
      'dirZ',
      'emote',
      'faceYaw',
      'jump',
      'leave',
      'run',
      'sit',
    ]);
  });

  it('move 意图执行中，输入只有方向（单位向量），没有"目标点直接落地"', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [5, 0, 0] }, 0);

    const input = ex.step(q, makeCtx(), hooks);
    expect(Math.hypot(input.dirX, input.dirZ)).toBeCloseTo(1, 9);
    // 方向是朝目标（+x），不是别的
    expect(input.dirX).toBeCloseTo(1, 9);
    expect(input.dirZ).toBeCloseTo(0, 9);
    // 关键：没有把目标坐标当位置交出去
    expect(Object.values(input)).not.toContain(5);
  });

  it('没有意图时输入全零（不会自作主张地动）', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const input = ex.step(q, makeCtx(), makeHooks());
    expect(input.dirX).toBe(0);
    expect(input.dirZ).toBe(0);
    expect(input.run).toBe(false);
    expect(input.jump).toBe(false);
  });
});

// ───────────────────────────── move ─────────────────────────────

describe('IntentExecutor：move', () => {
  it('走到目标（假物理）后完成，期间一直朝目标走', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [2, 0, 0] }, 0);

    const input = run(ex, q, hooks, 120, makeCtx());
    expect(hooks.failures).toEqual([]);
    expect(ex.busy).toBe(false);
    expect(ex.stats.completed).toBe(1);
    // 末帧已到达，不该还有方向
    expect(Math.hypot(input.dirX, input.dirZ)).toBeLessThan(1e-6);
  });

  it('已经在目标点上：立刻完成，不占 tick', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [0, 0, 0] }, 0);
    const input = ex.step(q, makeCtx(), hooks);
    expect(ex.busy).toBe(false);
    expect(ex.stats.completed).toBe(1);
    expect(input.dirX).toBe(0);
    expect(hooks.failures).toEqual([]);
  });

  it('run 速度位正确透传', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    q.push({ t: 'move', to: [10, 0, 0], speed: 'run' }, 0);
    const input = ex.step(q, makeCtx(), makeHooks());
    expect(input.run).toBe(true);
  });

  it('目标不是有限数 → failed(unreachable)，不是静默忽略', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [Number.NaN, 0, 0] }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.failures).toEqual([{ reason: 'unreachable', intent: 'move' }]);
    expect(ex.stats.failed).toBe(1);
    expect(ex.busy).toBe(false);
  });

  it('撞住（位置不再靠近目标）→ failed(blocked) 并停止', () => {
    const ex = new IntentExecutor({ stallSeconds: 0.3 });
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [10, 0, 0] }, 0);

    // 位置固定不动（模拟顶着一堵墙）：一直发方向但走不动
    let ctx = makeCtx();
    for (let i = 0; i < 40; i++) {
      ex.step(q, ctx, hooks);
      ctx = { ...ctx, now: ctx.now + ctx.dt };
    }
    expect(hooks.failures.some((f) => f.reason === 'blocked')).toBe(true);
    expect(ex.busy).toBe(false);
  });

  it('沿墙滑但离目标没更近，也算 blocked（不是只看位移是否为 0）', () => {
    const ex = new IntentExecutor({ stallSeconds: 0.2 });
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [10, 0, 0] }, 0);

    let ctx = makeCtx();
    for (let i = 0; i < 40; i++) {
      ex.step(q, ctx, hooks);
      // 每步沿 +z 滑 1cm：位移不为 0，但到 (10,0,0) 的距离不减
      ctx = { ...ctx, now: ctx.now + ctx.dt, pos: [0, 0.85, ctx.pos[2] + 0.01] };
    }
    expect(hooks.failures.some((f) => f.reason === 'blocked')).toBe(true);
  });

  it('超时 → failed(timeout)（距离远到走不完时不会永远卡住）', () => {
    // 把 stall 窗口设得很大，让超时先触发
    const ex = new IntentExecutor({
      stallSeconds: 999,
      timeoutFactor: 0.001,
      timeoutFloorSeconds: 0.05,
    });
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [100, 0, 0] }, 0);

    let ctx = makeCtx();
    for (let i = 0; i < 120; i++) {
      ex.step(q, ctx, hooks);
      // 每步挪 1mm，永远到不了
      ctx = { ...ctx, now: ctx.now + ctx.dt, pos: [ctx.pos[0] + 0.001, 0.85, 0] };
    }
    expect(hooks.failures.some((f) => f.reason === 'timeout')).toBe(true);
  });

  it('失败后队列里下一条立刻接着执行（一条失败不堵住队列）', () => {
    const ex = new IntentExecutor({ stallSeconds: 0.1 });
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [10, 0, 0] }, 0);
    q.push({ t: 'say', text: '我卡住了' }, 0);

    let ctx = makeCtx();
    for (let i = 0; i < 20; i++) {
      ex.step(q, ctx, hooks);
      ctx = { ...ctx, now: ctx.now + ctx.dt };
    }
    expect(hooks.failures.some((f) => f.reason === 'blocked')).toBe(true);
    expect(hooks.said.map((s) => s.text)).toContain('我卡住了');
  });
});

// ───────────────────────────── say ─────────────────────────────

describe('IntentExecutor：say 不阻塞移动（spec §6 M9 第 3 条）', () => {
  it('say 的默认时长是 3000ms（规格书写死 3s）', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'say', text: '你好' }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.said).toEqual([{ text: '你好', ms: 3000 }]);
  });

  it('显式 ms 被尊重', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'say', text: '短', ms: 800 }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.said).toEqual([{ text: '短', ms: 800 }]);
  });

  it('[move, say] → 第一 tick 就开口，同时仍在走', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [10, 0, 0] }, 0);
    q.push({ t: 'say', text: '边走边说' }, 0);

    const input = ex.step(q, makeCtx(), hooks);
    // 同一 tick 内：气泡已设 + 方向已给
    expect(hooks.said).toEqual([{ text: '边走边说', ms: 3000 }]);
    expect(Math.hypot(input.dirX, input.dirZ)).toBeCloseTo(1, 9);
    expect(ex.busy).toBe(true);
  });

  it('[say, move] → 同样第一 tick 开口，且不会"说完了才走"', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'say', text: '先说' }, 0);
    q.push({ t: 'move', to: [10, 0, 0] }, 0);

    const input = ex.step(q, makeCtx(), hooks);
    expect(hooks.said).toEqual([{ text: '先说', ms: 3000 }]);
    expect(Math.hypot(input.dirX, input.dirZ)).toBeCloseTo(1, 9);
  });

  it('多条 say 在同一 tick 内按入队顺序执行', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'say', text: '一' }, 0);
    q.push({ t: 'say', text: '二' }, 0);
    q.push({ t: 'say', text: '三' }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.said.map((s) => s.text)).toEqual(['一', '二', '三']);
  });

  it('空文本 say → failed(invalid_intent)，不静默跳过', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'say', text: '' }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.failures).toEqual([{ reason: 'invalid_intent', intent: 'say' }]);
    expect(hooks.said).toEqual([]);
  });

  it('say 不占执行槽：说话期间 busy 仍为 false（没有正在"执行"的身体动作）', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'say', text: '只说话' }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(ex.busy).toBe(false);
    expect(hooks.said).toHaveLength(1);
  });
});

// ───────────────────────────── wait / emote / look / sit / leave ─────────────────────────────

describe('IntentExecutor：wait', () => {
  it('等到时间才完成，期间不发方向', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'wait', ms: 100 }, 0);

    let ctx = makeCtx();
    let steps = 0;
    // 第一步之前 busy 还是 false（意图尚未取出），所以必须先跑一步再判
    for (; steps < 100; steps++) {
      const input = ex.step(q, ctx, hooks);
      expect(input.dirX).toBe(0);
      expect(input.dirZ).toBe(0);
      ctx = { ...ctx, now: ctx.now + ctx.dt };
      if (!ex.busy) break;
    }
    // 100ms ≈ 6 步（1/60），第一步已经把 remaining 扣到 0.0833
    expect(steps + 1).toBeGreaterThanOrEqual(6);
    expect(steps + 1).toBeLessThanOrEqual(8);
    expect(ex.stats.completed).toBe(1);
  });

  it('ms 非法（负数）→ failed(invalid_intent)', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'wait', ms: -5 }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.failures).toEqual([{ reason: 'invalid_intent', intent: 'wait' }]);
  });

  it('超长 wait 被夹到 maxWaitMs（不会一条 wait 堵死队列一小时）', () => {
    const ex = new IntentExecutor({ maxWaitMs: 100 });
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'wait', ms: 999999 }, 0);
    let ctx = makeCtx();
    let steps = 0;
    for (; steps < 500; steps++) {
      ex.step(q, ctx, hooks);
      ctx = { ...ctx, now: ctx.now + ctx.dt };
      if (!ex.busy) break;
    }
    expect(steps + 1).toBeLessThanOrEqual(8); // 100ms 就该结束
    expect(ex.stats.completed).toBe(1);
  });
});

describe('IntentExecutor：emote', () => {
  it('emote 立刻触发钩子，持续 emoteMs 后完成', () => {
    const ex = new IntentExecutor({ emoteMs: 100 });
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'emote', name: 'wave' }, 0);

    const first = ex.step(q, makeCtx(), hooks);
    expect(hooks.emoted).toEqual(['wave']);
    expect(first.emote).toBe('wave');

    let ctx = makeCtx();
    let steps = 0;
    while (ex.busy && steps < 100) {
      ex.step(q, ctx, hooks);
      ctx = { ...ctx, now: ctx.now + ctx.dt };
      steps += 1;
    }
    expect(steps).toBeLessThanOrEqual(8);
  });

  it('空 emote 名 → failed(invalid_intent)', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'emote', name: '' }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.failures).toEqual([{ reason: 'invalid_intent', intent: 'emote' }]);
  });
});

describe('IntentExecutor：look', () => {
  it('look 产出目标朝向的 faceYaw，一步完成', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    // 目标在 +x 方向 → yaw = atan2(1, 0) = π/2
    q.push({ t: 'look', at: [1, 0.85, 0] }, 0);

    const input = ex.step(q, makeCtx(), hooks);
    expect(input.faceYaw).toBeCloseTo(Math.PI / 2, 6);
    // 下一步收尾
    ex.step(q, makeCtx({ now: 1 / 60 }), hooks);
    expect(ex.busy).toBe(false);
    expect(ex.stats.completed).toBe(1);
  });

  it('look 到脚下（水平距离 0）按完成处理，不报失败', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'look', at: [0, 5, 0] }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.failures).toEqual([]);
    expect(ex.busy).toBe(false);
  });

  it('look 目标非有限数 → failed(unreachable)', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'look', at: [Number.POSITIVE_INFINITY, 0, 0] }, 0);
    ex.step(q, makeCtx(), hooks);
    expect(hooks.failures).toEqual([{ reason: 'unreachable', intent: 'look' }]);
  });
});

describe('IntentExecutor：sit', () => {
  const seat: SeatRef = { id: 's1', pos: [2, 0, 0], rot: Math.PI / 2 };

  it('走到座位边 → 发出 sit 位 → 结算后完成', () => {
    const ex = new IntentExecutor({ sitSettleSeconds: 0.1 });
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'sit', seat: 's1' }, 0);

    let ctx = makeCtx({ seats: [seat] });
    let sawSit = false;
    for (let i = 0; i < 300 && (ex.busy || i === 0); i++) {
      const input = ex.step(q, ctx, hooks);
      if (input.sit) sawSit = true;
      ctx = {
        ...ctx,
        now: ctx.now + ctx.dt,
        pos: [
          ctx.pos[0] + input.dirX * 2.2 * ctx.dt,
          ctx.pos[1],
          ctx.pos[2] + input.dirZ * 2.2 * ctx.dt,
        ],
      };
      if (!ex.busy) break;
    }
    expect(hooks.sat).toEqual(['s1']);
    expect(sawSit).toBe(true);
    expect(hooks.failures).toEqual([]);
    expect(ex.stats.completed).toBe(1);
  });

  it('座位不存在 → failed(no_such_seat)', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'sit', seat: 'nope' }, 0);
    ex.step(q, makeCtx({ seats: [seat] }), hooks);
    expect(hooks.failures).toEqual([{ reason: 'no_such_seat', intent: 'sit' }]);
  });

  it('房间没有座位 → failed(no_seats)（与"id 打错"区分开）', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'sit', seat: 's1' }, 0);
    ex.step(q, makeCtx({ seats: [] }), hooks);
    expect(hooks.failures).toEqual([{ reason: 'no_seats', intent: 'sit' }]);
  });
});

describe('IntentExecutor：leave', () => {
  it('leave 触发钩子并结束', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'leave' }, 0);
    const input = ex.step(q, makeCtx(), hooks);
    expect(input.leave).toBe(true);
    expect(hooks.left).toBe(1);
    expect(ex.busy).toBe(false);
  });
});

// ───────────────────────────── 队列联动 ─────────────────────────────

describe('IntentExecutor：与队列的联动', () => {
  it('按 FIFO 一条条执行：前一条完成才开始后一条', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'wait', ms: 50 }, 0);
    q.push({ t: 'emote', name: 'nod' }, 0);

    let ctx = makeCtx();
    // 前几步只有 wait 在跑，emote 不该提前触发
    for (let i = 0; i < 3; i++) {
      ex.step(q, ctx, hooks);
      ctx = { ...ctx, now: ctx.now + ctx.dt };
    }
    expect(hooks.emoted).toEqual([]);
    for (let i = 0; i < 10; i++) {
      ex.step(q, ctx, hooks);
      ctx = { ...ctx, now: ctx.now + ctx.dt };
    }
    expect(hooks.emoted).toEqual(['nod']);
  });

  it('队列满时 push 返回 failed(queue_full)，执行器不受影响继续跑当前意图', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue(2);
    const hooks = makeHooks();
    q.push({ t: 'move', to: [100, 0, 0] }, 0);
    q.push({ t: 'move', to: [200, 0, 0] }, 0);
    const rejected = q.push({ t: 'wait', ms: 10 }, 0);
    expect(rejected).toEqual({ t: 'failed', reason: 'queue_full', intent: 'wait' });

    const input = ex.step(q, makeCtx(), hooks);
    expect(Math.hypot(input.dirX, input.dirZ)).toBeCloseTo(1, 9);
  });

  it('reset 丢弃当前意图但不上报失败（主动放弃 ≠ 失败）', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [100, 0, 0] }, 0);
    ex.step(q, makeCtx(), hooks);
    ex.reset();
    expect(ex.busy).toBe(false);
    expect(hooks.failures).toEqual([]);
  });

  it('requestJump 透传一次后自动清零（边沿位）', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    ex.requestJump();
    const a = ex.step(q, makeCtx(), hooks);
    const b = ex.step(q, makeCtx({ now: 1 / 60 }), hooks);
    expect(a.jump).toBe(true);
    expect(b.jump).toBe(false);
  });

  it('requestJump 在意图执行期间也能透传（人类边跑边跳）', () => {
    const ex = new IntentExecutor();
    const q = new IntentQueue();
    const hooks = makeHooks();
    q.push({ t: 'move', to: [100, 0, 0] }, 0);
    ex.step(q, makeCtx(), hooks);
    ex.requestJump();
    const input = ex.step(q, makeCtx({ now: 1 / 60 }), hooks);
    expect(input.jump).toBe(true);
    expect(Math.hypot(input.dirX, input.dirZ)).toBeCloseTo(1, 9);
  });
});

// ───────────────────────────── 适配函数 ─────────────────────────────

describe('toLocomotionInput：控制输入 → 角色控制器输入', () => {
  it('方向与按键位原样透传', () => {
    const ci: ControlInput = {
      ...idleInput(),
      dirX: 0.6,
      dirZ: -0.8,
      run: true,
      jump: true,
    };
    const li = toLocomotionInput(ci);
    expect(li.dirX).toBe(0.6);
    expect(li.dirZ).toBe(-0.8);
    expect(li.run).toBe(true);
    expect(li.jump).toBe(true);
  });

  it('faceYaw 转成 faceX/faceZ，且约定与 character.ts 一致（yaw=atan2(fx,fz)）', () => {
    const li = toLocomotionInput({ ...idleInput(), faceYaw: Math.PI / 2 });
    expect(li.faceX).toBeCloseTo(1, 9);
    expect(li.faceZ).toBeCloseTo(0, 9);
    // 反解回去必须一致
    expect(Math.atan2(li.faceX!, li.faceZ!)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('faceYaw 为 null 时不产出 faceX/faceZ（让物理按移动方向决定）', () => {
    const li = toLocomotionInput(idleInput());
    expect(li.faceX).toBeUndefined();
    expect(li.faceZ).toBeUndefined();
  });

  it('yaw=0 → faceZ=1（+z 是 yaw 0 的朝向）', () => {
    const li = toLocomotionInput({ ...idleInput(), faceYaw: 0 });
    expect(li.faceX).toBeCloseTo(0, 9);
    expect(li.faceZ).toBeCloseTo(1, 9);
  });
});

describe('describeResult：失败回报的文本形状', () => {
  it('成功打 ok', () => {
    expect(describeResult({ ok: true })).toBe('ok');
  });
  it('失败带 reason 与 intent 类型', () => {
    expect(describeResult({ t: 'failed', reason: 'blocked', intent: 'move' })).toBe(
      'failed(blocked @move)',
    );
  });
  it('失败没有 intent 时只打 reason', () => {
    expect(describeResult({ t: 'failed', reason: 'timeout' })).toBe('failed(timeout)');
  });
});
