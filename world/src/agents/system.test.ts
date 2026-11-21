import { describe, it, expect } from 'vitest';
import { World } from '../core/world';
import { parseRoom, type Room } from '../core/room';
import { AgentSystem } from './system';
import { FAIL_REASON } from './queue';
import { isFailure, isOk } from './queue';

/** 一块地板 + 两个座位的小房间（无物理：createController 不提供）。 */
function makeRoom(): Room {
  return parseRoom({
    name: 'agents-test',
    spawn: [
      [0, 0, 0],
      [2, 0, 0],
      [4, 0, 0],
    ],
    lights: [],
    static: [{ type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] }],
    props: [],
    seats: [
      { id: 's1', pos: [1, 0, 1], rot: Math.PI / 2 },
      { id: 's2', pos: [3, 0, 1], rot: 0 },
    ],
  });
}

function makeSystem(over: { room?: Room } = {}): { sys: AgentSystem; world: World; room: Room } {
  const world = new World();
  const room = over.room ?? makeRoom();
  const sys = new AgentSystem({ world, room });
  return { sys, world, room };
}

describe('AgentSystem：join / leave', () => {
  it('join 后 Agent 出现在世界里，kind=agent', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: '阿岩', tint: 'tint-0' });
    expect(world.has(rt.id)).toBe(true);
    const a = world.getActor(rt.id)!;
    expect(a.kind).toBe('agent');
    expect(a.name).toBe('阿岩');
    expect(a.tint).toBe('tint-0');
    expect(sys.agentCount).toBe(1);
  });

  it('join 分配的 id 单调递增且不重复', () => {
    const { sys } = makeSystem();
    const a = sys.join({ name: 'A' });
    const b = sys.join({ name: 'B' });
    expect(a.id).not.toBe(b.id);
    expect(new Set([a.id, b.id]).size).toBe(2);
  });

  it('出生点按进场顺序分配，超出 spawn 数时环绕并错位（不重叠）', () => {
    const { sys, world } = makeSystem();
    const rts = [];
    for (let i = 0; i < 4; i++) rts.push(sys.join({ name: `A${i}` }));
    // 第 0/3 个用同一个 spawn（环绕），但第 3 个在 x 上错位 0.6
    const p0 = world.getActor(rts[0]!.id)!.transform.p;
    const p3 = world.getActor(rts[3]!.id)!.transform.p;
    expect(p0[2]).toBeCloseTo(0, 9);
    expect(p3[0]).toBeCloseTo(p0[0] + 0.6, 9);
    // 4 个位置两两不同
    const xs = rts.map((r) => world.getActor(r.id)!.transform.p[0]);
    expect(new Set(xs.map((x) => x.toFixed(3))).size).toBe(4);
  });

  it('重复 id join 抛错（id 不许复用）', () => {
    const { sys } = makeSystem();
    const rt = sys.join({ name: 'A' });
    expect(() => sys.join({ id: rt.id, name: 'B' })).toThrow(/已在场/);
  });

  it('leave 后实体消失、控制器释放、队列关闭', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: 'A' });
    expect(sys.leave(rt.id)).toBe(true);
    expect(world.has(rt.id)).toBe(false);
    expect(sys.agentCount).toBe(0);
    expect(rt.queue.isClosed).toBe(true);
    // 二次 leave 返回 false
    expect(sys.leave(rt.id)).toBe(false);
  });

  it('dispose 清空所有 Agent', () => {
    const { sys, world } = makeSystem();
    sys.join({ name: 'A' });
    sys.join({ name: 'B' });
    expect(world.actorCount).toBe(2);
    sys.dispose();
    expect(sys.agentCount).toBe(0);
    expect(world.actorCount).toBe(0);
  });
});

describe('AgentSystem：submit（意图入口）', () => {
  it('正常提交返回 ok', () => {
    const { sys } = makeSystem();
    const rt = sys.join({ name: 'A' });
    expect(isOk(sys.submit(rt.id, { t: 'wait', ms: 100 }))).toBe(true);
    expect(rt.queue.size).toBe(1);
  });

  it('给不存在的 Agent 提交 → failed(no_such_agent)（不是静默丢）', () => {
    const { sys } = makeSystem();
    const r = sys.submit('a:999', { t: 'wait', ms: 10 });
    expect(isFailure(r)).toBe(true);
    if (isFailure(r)) {
      expect(r.reason).toBe(FAIL_REASON.NO_SUCH_AGENT);
      expect(r.intent).toBe('wait');
    }
  });

  it('队列满 → failed(queue_full)，并广播到失败订阅者', () => {
    const { sys } = makeSystem();
    const rt = sys.join({ name: 'A' });
    for (let i = 0; i < 8; i++) sys.submit(rt.id, { t: 'wait', ms: 100 });

    const seen: string[] = [];
    sys.onFailure((e) => seen.push(e.reason));
    const r = sys.submit(rt.id, { t: 'wait', ms: 100 });
    expect(isFailure(r)).toBe(true);
    if (isFailure(r)) expect(r.reason).toBe(FAIL_REASON.QUEUE_FULL);
    expect(seen).toContain(FAIL_REASON.QUEUE_FULL);
  });

  it('失败同时发到 World 的事件总线（渲染层/调试面板能订阅）', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: 'A' });
    const seen: Array<{ id: string; reason: string }> = [];
    world.events.on('actor:intent-failed', (e) => seen.push({ id: e.id, reason: e.reason }));

    for (let i = 0; i < 8; i++) sys.submit(rt.id, { t: 'wait', ms: 100 });
    sys.submit(rt.id, { t: 'wait', ms: 100 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(rt.id);
    expect(seen[0]!.reason).toBe(FAIL_REASON.QUEUE_FULL);
  });

  it('submitMany 返回逐条结果，顺序与输入一致', () => {
    const { sys } = makeSystem();
    const rt = sys.join({ name: 'A' });
    const results = sys.submitMany(rt.id, [
      { t: 'wait', ms: 10 },
      { t: 'say', text: 'hi' },
    ]);
    expect(results).toHaveLength(2);
    expect(isOk(results[0]!)).toBe(true);
    expect(isOk(results[1]!)).toBe(true);
  });

  it('queueStats 反映真实队列状态', () => {
    const { sys } = makeSystem();
    const rt = sys.join({ name: 'A' });
    sys.submit(rt.id, { t: 'wait', ms: 100 });
    sys.submit(rt.id, { t: 'wait', ms: 100 });
    const s = sys.queueStats(rt.id)!;
    expect(s.pending).toBe(2);
    expect(s.capacity).toBe(8);
    expect(sys.queueStats('a:999')).toBeNull();
  });
});

describe('AgentSystem：perceive（只读）', () => {
  it('返回自己 + 附近其他人', () => {
    const { sys } = makeSystem();
    const a = sys.join({ name: 'A' });
    const b = sys.join({ name: 'B' });
    const p = sys.perceive(a.id)!;
    expect(p.self.id).toBe(a.id);
    expect(p.nearby.map((n) => n.id)).toContain(b.id);
  });

  it('对不存在的 Agent 返回 null', () => {
    const { sys } = makeSystem();
    expect(sys.perceive('a:999')).toBeNull();
  });

  it('perceive 不改世界：连续读 50 次后实体表与时间都不变', () => {
    const { sys, world } = makeSystem();
    const a = sys.join({ name: 'A' });
    sys.join({ name: 'B' });
    world.say(a.id, '我说', 3000);

    const snap = () =>
      JSON.stringify({
        actors: world.listActors(),
        tick: world.tickCount,
        now: world.now,
      });
    const before = snap();
    for (let i = 0; i < 50; i++) sys.perceive(a.id);
    expect(snap()).toBe(before);
  });
});

describe('AgentSystem：tick（无物理模式）', () => {
  it('没有控制器时也能跑：意图被消费、say 生效、失败被上报', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: 'A' });
    sys.submit(rt.id, { t: 'say', text: '你好' });
    sys.tick();
    expect(world.getActor(rt.id)!.bubble?.text).toBe('你好');
    expect(rt.steps).toBe(1);
  });

  it('say 设置的 bubble 时长默认 3s（世界时间）', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: 'A' });
    sys.submit(rt.id, { t: 'say', text: '你好' });
    sys.tick();
    const b = world.getActor(rt.id)!.bubble!;
    expect(b.until - world.now).toBeCloseTo(3, 6);
  });

  it('move 在无物理模式下会因走不动而 failed(blocked) —— 不会假装成功', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: 'A' });
    const failures: string[] = [];
    world.events.on('actor:intent-failed', (e) => failures.push(e.reason));

    sys.submit(rt.id, { t: 'move', to: [10, 0, 0] });
    // 无物理 → 位置永远不变 → 0.5s 后判定 blocked
    for (let i = 0; i < 40; i++) {
      sys.tick();
      // 手动推进世界时间（真实环境由 world.tick 做，这里 system.tick 不推进）
      (world as unknown as { time: number }).time += 1 / 60;
      (world as unknown as { tickIndex: number }).tickIndex += 1;
    }
    expect(failures).toContain(FAIL_REASON.BLOCKED);
  });

  it('leave 意图在 tick 内安全地 despawn（不在遍历中改 map）', () => {
    const { sys, world } = makeSystem();
    const a = sys.join({ name: 'A' });
    const b = sys.join({ name: 'B' });
    sys.submit(a.id, { t: 'leave' });
    sys.tick();
    expect(world.has(a.id)).toBe(false);
    // 后面的 Agent 没有被漏掉
    expect(world.has(b.id)).toBe(true);
    expect(sys.agentCount).toBe(1);
  });

  it('外部 despawn 后 tick 跳过该 Agent，不抛错', () => {
    const { sys, world } = makeSystem();
    const a = sys.join({ name: 'A' });
    world.despawn(a.id);
    expect(() => sys.tick()).not.toThrow();
  });
});

describe('AgentSystem：座位来自房间', () => {
  it('sit 到存在的座位：走到位并发出 sit 位', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: 'A', spawnPos: [1, 0, 1] }); // 直接站在 s1 上
    sys.submit(rt.id, { t: 'sit', seat: 's1' });
    let sawSit = false;
    for (let i = 0; i < 40; i++) {
      sys.tick();
      if (rt.lastInput.sit) sawSit = true;
      if (!rt.executor.busy) break;
    }
    expect(sawSit).toBe(true);
    expect(world.has(rt.id)).toBe(true);
  });

  it('sit 到不存在的座位 → failed(no_such_seat)', () => {
    const { sys, world } = makeSystem();
    const rt = sys.join({ name: 'A' });
    const failures: string[] = [];
    world.events.on('actor:intent-failed', (e) => failures.push(e.reason));
    sys.submit(rt.id, { t: 'sit', seat: '不存在' });
    sys.tick();
    expect(failures).toContain(FAIL_REASON.NO_SUCH_SEAT);
  });
});
