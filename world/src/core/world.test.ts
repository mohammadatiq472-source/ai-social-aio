import { describe, it, expect } from 'vitest';
import { EventBus, World } from './world';
import { createTransform } from './types';
import type { Intent } from './types';

describe('World 实体表', () => {
  it('spawn 后能查到，且事件带上实体', () => {
    const w = new World();
    const seen: string[] = [];
    w.events.on('actor:spawn', ({ actor }) => seen.push(actor.id));

    const id = w.nextId('p');
    w.spawnActor(id, 'human', '你');

    expect(w.has(id)).toBe(true);
    expect(w.actorCount).toBe(1);
    expect(seen).toEqual([id]);
  });

  it('id 单调递增且不复用', () => {
    const w = new World();
    const a = w.nextId('a');
    const b = w.nextId('a');
    const c = w.nextId('prop');
    expect(a).toBe('a:1');
    expect(b).toBe('a:2');
    expect(c).toBe('prop:3');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('重复 id 立刻抛错（复用会让旧引用指到新实体）', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    expect(() => w.spawnActor('a:1', 'agent', 'B')).toThrow(/已存在/);
  });

  it('despawn 删除并发事件，二次删除返回 false', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    const gone: string[] = [];
    w.events.on('actor:despawn', ({ id }) => gone.push(id));

    expect(w.despawn('a:1')).toBe(true);
    expect(w.despawn('a:1')).toBe(false);
    expect(gone).toEqual(['a:1']);
    expect(w.actorCount).toBe(0);
  });

  it('updateActor 写回 transform 并发 actor:update', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    let updates = 0;
    w.events.on('actor:update', ({ id, anim }) => {
      updates += 1;
      expect(id).toBe('a:1');
      expect(anim).toBe('walk');
    });

    const ok = w.updateActor('a:1', {
      transform: createTransform([1, 2, 3]),
      anim: 'walk',
      animPhase: 0.5,
    });

    expect(ok).toBe(true);
    expect(updates).toBe(1);
    const a = w.getActor('a:1');
    expect(a?.transform.p).toEqual([1, 2, 3]);
    expect(a?.anim).toBe('walk');
  });

  it('updateActor 对不存在的实体返回 false，不抛错（物理层可能晚一帧）', () => {
    const w = new World();
    expect(w.updateActor('a:404', { anim: 'idle' })).toBe(false);
  });

  it('spawn 会深拷贝 transform，调用方改自己的对象不影响世界状态', () => {
    const w = new World();
    const t = createTransform([5, 0, 5]);
    w.spawn({ id: 'a:1', kind: 'agent', name: 'A', transform: t, anim: 'idle', animPhase: 0 });
    t.p[0] = 999;
    expect(w.getActor('a:1')?.transform.p[0]).toBe(5);
  });

  it('listActors 返回快照：遍历中 despawn 不会打断', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    w.spawnActor('a:2', 'agent', 'B');
    const visited: string[] = [];
    for (const a of w.listActors()) {
      visited.push(a.id);
      w.despawn(a.id);
    }
    expect(visited).toEqual(['a:1', 'a:2']);
    expect(w.actorCount).toBe(0);
  });

  it('actorsOfKind 只返回指定类型', () => {
    const w = new World();
    w.spawnActor('p:1', 'human', '人');
    w.spawnActor('a:2', 'agent', 'AI1');
    w.spawnActor('a:3', 'agent', 'AI2');
    expect(w.actorsOfKind('agent').map((a) => a.id)).toEqual(['a:2', 'a:3']);
    expect(w.actorsOfKind('human').map((a) => a.id)).toEqual(['p:1']);
  });

  it('say 写 bubble，过期后 expireBubbles 清掉', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    const said: string[] = [];
    w.events.on('actor:say', ({ text }) => said.push(text));

    w.say('a:1', '你好', 1000); // 1 秒
    expect(said).toEqual(['你好']);
    expect(w.getActor('a:1')?.bubble?.text).toBe('你好');

    // 推进 1 秒（60 步）
    for (let i = 0; i < 60; i++) w.tick(1 / 60);
    expect(w.getActor('a:1')?.bubble).toBeUndefined();
  });
});

describe('World tick 调度', () => {
  it('系统按 order 排序执行', () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem('late', () => order.push('late'), { order: 10 });
    w.addSystem('early', () => order.push('early'), { order: -10 });
    w.addSystem('mid', () => order.push('mid'), { order: 0 });

    w.tick(1 / 60);
    expect(order).toEqual(['early', 'mid', 'late']);
  });

  it('系统名重复立刻抛错（静默覆盖会让人查半天）', () => {
    const w = new World();
    w.addSystem('physics', () => {});
    expect(() => w.addSystem('physics', () => {})).toThrow(/重复/);
  });

  it('tick 累加 tick 计数与世界时间', () => {
    const w = new World();
    w.addSystem('noop', () => {});
    for (let i = 0; i < 10; i++) w.tick(1 / 60);
    expect(w.tickCount).toBe(10);
    expect(w.now).toBeCloseTo(10 / 60, 9);
  });

  it('禁用的系统不跑', () => {
    const w = new World();
    let ran = 0;
    w.addSystem('sys', () => ran++);
    w.tick(1 / 60);
    w.setSystemEnabled('sys', false);
    w.tick(1 / 60);
    expect(ran).toBe(1);
  });

  it('系统能读到当前 dt，且是固定值', () => {
    const w = new World();
    const dts: number[] = [];
    w.addSystem('rec', (_world, dt) => dts.push(dt));
    w.tick(1 / 60);
    w.tick(1 / 60);
    expect(dts).toEqual([1 / 60, 1 / 60]);
  });

  it('非法 dt 抛错（可变 dt 喂物理是明确的 bug，不该被容忍）', () => {
    const w = new World();
    expect(() => w.tick(0)).toThrow(RangeError);
    expect(() => w.tick(-1)).toThrow(RangeError);
    expect(() => w.tick(NaN)).toThrow(RangeError);
  });
});

describe('World 意图入口', () => {
  it('没有注册 sink 时 submitIntent 返回 false，不静默吞掉', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    const intent: Intent = { t: 'wait', ms: 100 };
    expect(w.submitIntent('a:1', intent)).toBe(false);
  });

  it('注册 sink 后意图能到达，且对不存在的实体返回 false', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    const got: Intent[] = [];
    w.setIntentSink((_id, intent) => {
      got.push(intent);
      return true;
    });

    expect(w.submitIntent('a:1', { t: 'say', text: 'hi' })).toBe(true);
    expect(got).toHaveLength(1);
    expect(w.submitIntent('a:404', { t: 'leave' })).toBe(false);
  });

  it('reportIntentFailure 发事件（失败不许静默丢弃）', () => {
    const w = new World();
    w.spawnActor('a:1', 'agent', 'A');
    let reason = '';
    w.events.on('actor:intent-failed', ({ reason: r }) => (reason = r));
    w.reportIntentFailure('a:1', '目标不可达');
    expect(reason).toBe('目标不可达');
  });
});

describe('EventBus', () => {
  it('on 返回的取消函数能退订', () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on('world:reset', () => n++);
    bus.emit('world:reset', {});
    off();
    bus.emit('world:reset', {});
    expect(n).toBe(1);
  });

  it('once 只触发一次', () => {
    const bus = new EventBus();
    let n = 0;
    bus.once('world:reset', () => n++);
    bus.emit('world:reset', {});
    bus.emit('world:reset', {});
    expect(n).toBe(1);
  });

  it('emit 期间退订不会跳过其它 handler', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    const offA = bus.on('world:reset', () => {
      calls.push('a');
      offA();
    });
    bus.on('world:reset', () => calls.push('b'));
    bus.emit('world:reset', {});
    expect(calls).toEqual(['a', 'b']);
  });

  it('emit 期间新增的订阅本轮不触发（避免"收到已发过的事件"的幻觉）', () => {
    const bus = new EventBus();
    let late = 0;
    bus.on('world:reset', () => {
      bus.on('world:reset', () => late++);
    });
    bus.emit('world:reset', {});
    expect(late).toBe(0);
    bus.emit('world:reset', {});
    expect(late).toBe(1);
  });

  it('clear 清空所有订阅', () => {
    const bus = new EventBus();
    bus.on('world:reset', () => {});
    expect(bus.listenerCount('world:reset')).toBe(1);
    bus.clear();
    expect(bus.listenerCount('world:reset')).toBe(0);
  });

  it('world.reset 保留订阅者（换房间不用重连渲染层）', () => {
    const w = new World();
    let n = 0;
    w.events.on('world:reset', () => n++);
    w.spawnActor('a:1', 'agent', 'A');
    w.reset();
    expect(n).toBe(1);
    expect(w.actorCount).toBe(0);
    // 订阅还在：再来一次仍能收到
    w.reset();
    expect(n).toBe(2);
  });
});
