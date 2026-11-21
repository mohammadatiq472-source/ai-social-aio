import { describe, it, expect } from 'vitest';
import { World } from '../core/world';
import { createTransform, type AnimName } from '../core/types';
import { perceive, quatToYaw, wrapAngle, type PerceptionSource } from './perceive';

/** 建一个有内容的世界：3 个 actor、1 个带气泡、1 个有 tint。 */
function makeWorld(): World {
  const w = new World();
  w.spawn({
    id: 'a:1',
    kind: 'agent',
    name: '自己',
    transform: createTransform([0, 0, 0]),
    anim: 'idle',
    animPhase: 0,
  });
  w.spawn({
    id: 'a:2',
    kind: 'agent',
    name: '近的',
    transform: createTransform([1, 0, 0]),
    anim: 'walk',
    animPhase: 0.5,
    tint: 'tint-1',
  });
  w.spawn({
    id: 'a:3',
    kind: 'agent',
    name: '远的',
    transform: createTransform([0, 0, 5]),
    anim: 'run',
    animPhase: 0.25,
  });
  w.spawn({
    id: 'p:4',
    kind: 'human',
    name: '人',
    transform: createTransform([0, 0, -2]),
    anim: 'idle',
    animPhase: 0,
  });
  return w;
}

/**
 * 世界指纹：把"能被感知/被写坏的一切"摊平成可比较的字符串。
 *
 * 这是「perceive 无副作用」的证据基础。它必须覆盖：
 * - 实体表（谁在、顺序、数量）
 * - 每个 transform 的 7 个分量（逐位，不是近似）
 * - 每个 anim / animPhase / tint
 * - 每个 bubble（text + until）
 * - tick / now（perceive 不能推进时间）
 * - **事件总线的监听者数量**（perceive 不能注册/注销订阅）
 *
 * 为什么不只用 `JSON.stringify(w.listActors())`：
 * 那样漏掉 tick/now 与事件计数，而"perceive 顺手调了 expireBubbles 或 tick"
 * 恰恰是这类 bug 最可能的形态。
 */
function fingerprint(w: World): string {
  const actors = w
    .listActors()
    .map((a) => {
      const t = a.transform;
      return [
        a.id,
        a.kind,
        a.name,
        t.p.map((v) => v.toExponential(17)).join(','),
        t.r.map((v) => v.toExponential(17)).join(','),
        a.anim,
        a.animPhase.toExponential(17),
        a.tint ?? '-',
        a.bubble ? `${a.bubble.text}@${a.bubble.until.toExponential(17)}` : '-',
      ].join('|');
    })
    .join('\n');
  return [
    `count=${w.actorCount}`,
    `tick=${w.tickCount}`,
    `now=${w.now.toExponential(17)}`,
    // 事件订阅者数量：perceive 不许改变它
    `listeners:spawn=${w.events.listenerCount('actor:spawn')}`,
    `listeners:say=${w.events.listenerCount('actor:say')}`,
    `listeners:update=${w.events.listenerCount('actor:update')}`,
    `listeners:failed=${w.events.listenerCount('actor:intent-failed')}`,
    `listeners:despawn=${w.events.listenerCount('actor:despawn')}`,
    '---actors---',
    actors,
  ].join('\n');
}

describe('perceive：无副作用（spec §6 M9 第 4 条「只读、不改世界」）', () => {
  it('调用前后世界指纹逐字节相同', () => {
    const w = makeWorld();
    // 先跑几个 tick，让 now/tick 处于非零状态（全零时"没变"没有说服力）
    for (let i = 0; i < 30; i++) w.tick(1 / 60);
    w.say('a:2', '我说了一句话', 3000);

    const before = fingerprint(w);
    const p = perceive(w, 'a:1');
    const after = fingerprint(w);

    expect(p).not.toBeNull();
    expect(after).toBe(before);
  });

  it('连续读 100 次也不会改变世界（高频读不能有累积效应）', () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i++) w.tick(1 / 60);
    w.say('a:3', '嗯', 5000);

    const before = fingerprint(w);
    for (let i = 0; i < 100; i++) perceive(w, 'a:1');
    expect(fingerprint(w)).toBe(before);
  });

  it('不清理过期气泡：过期气泡仍在实体表里，只是不出现在感知结果里', () => {
    const w = makeWorld();
    w.say('a:2', '会过期的', 100); // 100ms
    // 推进 200ms：气泡过期
    for (let i = 0; i < 12; i++) w.tick(1 / 60);

    const actorBefore = w.getActor('a:2')!;
    // world.tick 自己会 expireBubbles，所以这里先确认它已被清（这是 world 的职责）
    // 关键点：**perceive 不参与**这个清理。
    // 为了证明这一点，我们手工塞一个过期气泡回去，再调 perceive。
    (actorBefore as { bubble?: { text: string; until: number } }).bubble = {
      text: '手工过期',
      until: w.now - 1,
    };
    const before = fingerprint(w);

    const p = perceive(w, 'a:1')!;
    // 感知里不该有它（逻辑上已过期）
    expect(p.bubbles.find((b) => b.text === '手工过期')).toBeUndefined();
    // 但世界里的 bubble 字段**没有被删**（perceive 不写）
    expect(w.getActor('a:2')!.bubble).toBeDefined();
    expect(fingerprint(w)).toBe(before);
  });

  it('不推进时间、不跑 tick', () => {
    const w = makeWorld();
    const t0 = w.now;
    const k0 = w.tickCount;
    perceive(w, 'a:1');
    perceive(w, 'a:1');
    expect(w.now).toBe(t0);
    expect(w.tickCount).toBe(k0);
  });

  it('返回的是深拷贝：改结果不会污染世界', () => {
    const w = makeWorld();
    const before = fingerprint(w);
    const p = perceive(w, 'a:1')!;

    // 疯狂改返回值
    p.self.p[0] = 999;
    p.self.r[3] = -1;
    p.self.anim = 'jump' as AnimName;
    p.nearby[0]!.p[1] = 888;
    p.nearby[0]!.name = '被改了';
    if (p.bubbles[0]) p.bubbles[0].text = '被改了';

    expect(fingerprint(w)).toBe(before);
    expect(w.getActor('a:1')!.transform.p[0]).toBe(0);
  });

  it('不注册事件订阅（读接口不该留下监听器）', () => {
    const w = makeWorld();
    const n0 = w.events.listenerCount('actor:update');
    perceive(w, 'a:1');
    expect(w.events.listenerCount('actor:update')).toBe(n0);
  });

  it('对不存在的 id 返回 null（不伪造空快照）', () => {
    const w = makeWorld();
    const before = fingerprint(w);
    expect(perceive(w, 'a:999')).toBeNull();
    expect(fingerprint(w)).toBe(before);
  });

  it('只依赖只读接口：传入一个"写方法都没有"的数据源也能工作', () => {
    // 结构性证明：PerceptionSource 只声明读方法，所以 perceive 不可能写到世界。
    // 这里用一个冻结的、只含 4 个成员的对象当数据源。
    const source: PerceptionSource = Object.freeze({
      getActor: (id: string) =>
        id === 'a:1'
          ? {
              id: 'a:1',
              kind: 'agent' as const,
              name: '我',
              transform: createTransform([0, 0, 0]),
              anim: 'idle' as const,
              animPhase: 0,
            }
          : undefined,
      listActors: () => [
        {
          id: 'a:1',
          kind: 'agent' as const,
          name: '我',
          transform: createTransform([0, 0, 0]),
          anim: 'idle' as const,
          animPhase: 0,
        },
        {
          id: 'a:2',
          kind: 'agent' as const,
          name: '他',
          transform: createTransform([3, 0, 4]),
          anim: 'walk' as const,
          animPhase: 0,
        },
      ],
      now: 1.5,
      tickCount: 90,
    });
    const p = perceive(source, 'a:1');
    expect(p).not.toBeNull();
    expect(p!.worldTime).toBe(1.5);
    expect(p!.tick).toBe(90);
    expect(p!.nearby[0]!.dist).toBeCloseTo(5, 9);
  });
});

describe('perceive：形状符合规格书', () => {
  it('返回 { self:{p,r,anim}, nearby:[{id,name,p,dist}], bubbles:[...] }', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1')!;

    // self
    expect(p.self.id).toBe('a:1');
    expect(p.self.p).toHaveLength(3);
    expect(p.self.r).toHaveLength(4);
    expect(typeof p.self.anim).toBe('string');

    // nearby：每个都有规格书要求的 4 个字段（另加 distXZ/bearing/kind）
    for (const n of p.nearby) {
      expect(typeof n.id).toBe('string');
      expect(typeof n.name).toBe('string');
      expect(n.p).toHaveLength(3);
      expect(typeof n.dist).toBe('number');
      expect(typeof n.distXZ).toBe('number');
      expect(typeof n.bearing).toBe('number');
    }
  });

  it('nearby 按距离升序（最近的在前）', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1')!;
    const dists = p.nearby.map((n) => n.dist);
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]!).toBeGreaterThanOrEqual(dists[i - 1]!);
    }
    expect(p.nearby[0]!.id).toBe('a:2'); // 1m 最近
    expect(p.nearby[0]!.dist).toBeCloseTo(1, 9);
  });

  it('不含自己', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1')!;
    expect(p.nearby.some((n) => n.id === 'a:1')).toBe(false);
  });

  it('气泡带剩余时间，按 until 升序', () => {
    const w = makeWorld();
    w.say('a:2', '先消失', 1000);
    w.say('a:3', '后消失', 3000);
    const p = perceive(w, 'a:1')!;
    expect(p.bubbles.map((b) => b.text)).toEqual(['先消失', '后消失']);
    expect(p.bubbles[0]!.remaining).toBeCloseTo(1, 6);
    expect(p.bubbles[1]!.remaining).toBeCloseTo(3, 6);
    // until 是绝对世界时间，不是剩余时间
    expect(p.bubbles[0]!.until).toBeCloseTo(w.now + 1, 6);
  });

  it('radiusXZ 过滤：只返回水平距离内的', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1', { radiusXZ: 2 })!;
    const ids = p.nearby.map((n) => n.id);
    expect(ids).toContain('a:2'); // 1m
    expect(ids).toContain('p:4'); // 2m（边界上，<= 保留）
    expect(ids).not.toContain('a:3'); // 5m
  });

  it('limit 截断到最近的 N 个', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1', { limit: 2 })!;
    expect(p.nearby).toHaveLength(2);
    expect(p.nearby.map((n) => n.id)).toEqual(['a:2', 'p:4']);
  });

  it('非法 radiusXZ 降级成"只有自己"，不抛（感知不该让调用方崩）', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1', { radiusXZ: Number.NaN });
    expect(p).not.toBeNull();
    expect(p!.nearby).toEqual([]);
    expect(p!.bubbles).toEqual([]);
    expect(p!.self.id).toBe('a:1');
  });

  it('同样的世界状态读两次，结果逐字段相同（可复现）', () => {
    const w = makeWorld();
    w.say('a:2', 'hi', 2000);
    const a = perceive(w, 'a:1')!;
    const b = perceive(w, 'a:1')!;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('tint 透传（染色变体 key 要给外部 Agent 看见）', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1')!;
    const near = p.nearby.find((n) => n.id === 'a:2')!;
    expect(near.tint).toBe('tint-1');
    // 没有 tint 的不该出现 undefined 字段（JSON 里会变成 null 或被丢掉）
    const far = p.nearby.find((n) => n.id === 'a:3')!;
    expect('tint' in far).toBe(false);
  });

  it('kind 区分 human / agent', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1')!;
    expect(p.nearby.find((n) => n.id === 'a:2')!.kind).toBe('agent');
    expect(p.nearby.find((n) => n.id === 'p:4')!.kind).toBe('human');
  });

  it('bearing 是相对世界的方位角（+z=0，+x=π/2）', () => {
    const w = makeWorld();
    const p = perceive(w, 'a:1')!;
    // a:2 在 +x → bearing = atan2(1,0) = π/2
    expect(p.nearby.find((n) => n.id === 'a:2')!.bearing).toBeCloseTo(Math.PI / 2, 9);
    // a:3 在 +z → bearing = 0
    expect(p.nearby.find((n) => n.id === 'a:3')!.bearing).toBeCloseTo(0, 9);
    // p:4 在 -z → bearing = atan2(0,-2) = π
    expect(Math.abs(p.nearby.find((n) => n.id === 'p:4')!.bearing)).toBeCloseTo(Math.PI, 9);
  });

  it('dist 是三维距离，distXZ 忽略高度（判断"能不能走过去"用后者）', () => {
    const w = new World();
    w.spawn({
      id: 'a:1',
      kind: 'agent',
      name: 'a',
      transform: createTransform([0, 0, 0]),
      anim: 'idle',
      animPhase: 0,
    });
    w.spawn({
      id: 'a:2',
      kind: 'agent',
      name: 'b',
      transform: createTransform([0, 10, 0]), // 正上方 10m
      anim: 'idle',
      animPhase: 0,
    });
    const p = perceive(w, 'a:1')!;
    expect(p.nearby[0]!.dist).toBeCloseTo(10, 9);
    expect(p.nearby[0]!.distXZ).toBeCloseTo(0, 9);
  });
});

describe('perceive：与 World 的集成（真实 tick 之后读）', () => {
  it('tick 推进后 worldTime / tick 跟着变，perceive 读到的就是当前值', () => {
    const w = makeWorld();
    for (let i = 0; i < 60; i++) w.tick(1 / 60);
    const p = perceive(w, 'a:1')!;
    expect(p.tick).toBe(60);
    expect(p.worldTime).toBeCloseTo(1, 6);
  });

  it('气泡到期后自动从感知里消失（由 world.tick 清理，不是 perceive 清）', () => {
    const w = makeWorld();
    w.say('a:2', '短', 100);
    expect(perceive(w, 'a:1')!.bubbles).toHaveLength(1);
    for (let i = 0; i < 12; i++) w.tick(1 / 60);
    expect(perceive(w, 'a:1')!.bubbles).toHaveLength(0);
  });

  it('实体被 despawn 后感知里立刻消失', () => {
    const w = makeWorld();
    expect(perceive(w, 'a:1')!.nearby).toHaveLength(3);
    w.despawn('a:3');
    expect(perceive(w, 'a:1')!.nearby).toHaveLength(2);
  });
});

describe('quatToYaw / wrapAngle', () => {
  it('单位四元数 → yaw 0', () => {
    expect(quatToYaw([0, 0, 0, 1])).toBeCloseTo(0, 12);
  });

  it('绕 y 转 90° → yaw = π/2', () => {
    const h = Math.PI / 4;
    expect(quatToYaw([0, Math.sin(h), 0, Math.cos(h)])).toBeCloseTo(Math.PI / 2, 9);
  });

  it('绕 y 转 180° → |yaw| = π', () => {
    const h = Math.PI / 2;
    expect(Math.abs(quatToYaw([0, Math.sin(h), 0, Math.cos(h)]))).toBeCloseTo(Math.PI, 9);
  });

  it('脏四元数（NaN）退化为 0，不返回 NaN', () => {
    expect(quatToYaw([0, Number.NaN, 0, 1])).toBe(0);
    expect(quatToYaw([0, 0, 0, 0])).toBe(0);
  });

  it('wrapAngle 归一到 (-π, π]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0, 12);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0, 9);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(Math.PI * 0.5)).toBeCloseTo(Math.PI * 0.5, 9);
    expect(wrapAngle(Number.NaN)).toBe(0);
  });
});

describe('perceive：类型层面的副作用防线', () => {
  it('数据源上所有写方法一旦被调用就抛错（perceive 跑完没抛 = 没写过世界）', () => {
    const w = makeWorld();
    // 给 World 的每个"写"方法套一个地雷：perceive 只要碰到任何一个就炸。
    // 这比"检查 Object.keys"稳：World 加字段不会误报，而真的多了一次写调用一定会被抓到。
    const booby = w as unknown as Record<string, unknown>;
    const WRITE_METHODS = [
      'spawn',
      'spawnActor',
      'despawn',
      'updateActor',
      'say',
      'expireBubbles',
      'tick',
      'reset',
      'nextId',
      'addSystem',
      'setSystemEnabled',
      'reportIntentFailure',
      'submitIntent',
      'setIntentSink',
    ];
    const originals = new Map<string, unknown>();
    for (const name of WRITE_METHODS) {
      const fn = booby[name];
      if (typeof fn !== 'function') continue;
      originals.set(name, fn);
      booby[name] = (): never => {
        throw new Error(`perceive 调用了写方法 ${name}——这违反了「只读、不改世界」`);
      };
    }
    try {
      expect(() => perceive(w, 'a:1')).not.toThrow();
    } finally {
      for (const [name, fn] of originals) booby[name] = fn;
    }
  });

  it('PerceptionSource 只声明读操作（契约形状）', () => {
    const w = makeWorld();
    const source: PerceptionSource = w;
    expect(typeof source.getActor).toBe('function');
    expect(typeof source.listActors).toBe('function');
    expect(typeof source.now).toBe('number');
    expect(typeof source.tickCount).toBe('number');
    // 反过来：这个接口上**不该**有写方法的类型声明（下面这行若去掉注释会编译失败）
    // source.say('a:1', 'x', 1000);
  });
});
