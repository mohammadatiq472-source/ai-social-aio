import { describe, it, expect } from 'vitest';
import {
  clampPitch,
  createTransform,
  decodeActorState,
  decodeIntent,
  decodeTransform,
  distance,
  encodeActorState,
  encodeIntent,
  encodeTransform,
  interpolateTransform,
  isActorId,
  isAnimName,
  makeEntityId,
  normalizeQuat,
  parseEntityId,
  slerp,
  transformEquals,
} from './types';
import type { ActorState } from './types';

describe('EntityId', () => {
  it('makeEntityId 按前缀拼装，与 spec §4.1 的例子一致', () => {
    expect(makeEntityId('p', 9001)).toBe('p:9001');
    expect(makeEntityId('a', 12)).toBe('a:12');
    expect(makeEntityId('prop', 3)).toBe('prop:3');
  });

  it('parseEntityId 能还原前缀与序号', () => {
    expect(parseEntityId('p:9001')).toEqual({ prefix: 'p', seq: 9001 });
    expect(parseEntityId('a:12')).toEqual({ prefix: 'a', seq: 12 });
    expect(parseEntityId('prop:3')).toEqual({ prefix: 'prop', seq: 3 });
  });

  it('parseEntityId 对脏数据返回 null 而不是抛错', () => {
    for (const bad of ['', 'a', 'a:', ':1', 'x:1', 'a:-1', 'a:1.5', 'a:abc', ' a:1', 'a:1 ']) {
      expect(parseEntityId(bad)).toBeNull();
    }
  });

  it('makeEntityId 拒绝非法 seq', () => {
    expect(() => makeEntityId('a', -1)).toThrow(RangeError);
    expect(() => makeEntityId('a', 1.5)).toThrow(RangeError);
  });

  it('isActorId 只认 p / a 前缀', () => {
    expect(isActorId('p:1')).toBe(true);
    expect(isActorId('a:1')).toBe(true);
    expect(isActorId('prop:1')).toBe(false);
    expect(isActorId('garbage')).toBe(false);
  });
});

describe('Transform 编解码', () => {
  it('encodeTransform 会归一化四元数', () => {
    const t = createTransform([1, 2, 3], [0, 0, 0, 2]); // 非单位四元数
    const enc = encodeTransform(t);
    const len = Math.hypot(...enc.r);
    expect(len).toBeCloseTo(1, 10);
    expect(enc.p).toEqual([1, 2, 3]);
  });

  it('decodeTransform 能解回，且四元数已归一化', () => {
    const t = decodeTransform({ p: [1, 2, 3], r: [0, 0, 0, 5] });
    expect(t).not.toBeNull();
    expect(t!.p).toEqual([1, 2, 3]);
    expect(Math.hypot(...t!.r)).toBeCloseTo(1, 10);
  });

  it('decodeTransform 对缺分量/非数值返回 null', () => {
    expect(decodeTransform(null)).toBeNull();
    expect(decodeTransform({ p: [1, 2], r: [0, 0, 0, 1] })).toBeNull();
    expect(decodeTransform({ p: [1, 2, 3], r: [0, 0, 1] })).toBeNull();
    expect(decodeTransform({ p: [1, 2, 'x'], r: [0, 0, 0, 1] })).toBeNull();
    expect(decodeTransform({ p: [1, 2, NaN], r: [0, 0, 0, 1] })).toBeNull();
  });

  it('零四元数退化为单位旋转，绝不产出 NaN', () => {
    expect(normalizeQuat([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(normalizeQuat([NaN, 0, 0, 0])).toEqual([0, 0, 0, 1]);
  });

  it('往返一致', () => {
    const t = createTransform([-1.5, 0.25, 8], [0, 0.7071067811865476, 0, 0.7071067811865476]);
    const round = decodeTransform(encodeTransform(t));
    expect(round).not.toBeNull();
    expect(transformEquals(t, round!)).toBe(true);
  });

  it('transformEquals 带容差', () => {
    const a = createTransform([0, 0, 0]);
    const b = createTransform([1e-9, 0, 0]);
    const c = createTransform([0.001, 0, 0]);
    expect(transformEquals(a, b)).toBe(true);
    expect(transformEquals(a, c)).toBe(false);
  });

  it('distance 用欧氏距离', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 10);
    expect(distance([1, 1, 1], [1, 1, 1])).toBe(0);
  });
});

describe('ActorState 编解码', () => {
  const base: ActorState = {
    id: 'a:7',
    kind: 'agent',
    name: '小蓝',
    transform: createTransform([1, 0, 2], [0, 0, 0, 1]),
    anim: 'walk',
    animPhase: 0.42,
    tint: 'blue',
    bubble: { text: '我来了', until: 12.5 },
  };

  it('往返一致（含 bubble 与 tint）', () => {
    const round = decodeActorState(encodeActorState(base));
    expect(round).not.toBeNull();
    expect(round!.id).toBe('a:7');
    expect(round!.kind).toBe('agent');
    expect(round!.name).toBe('小蓝');
    expect(round!.anim).toBe('walk');
    expect(round!.animPhase).toBeCloseTo(0.42, 6);
    expect(round!.tint).toBe('blue');
    expect(round!.bubble).toEqual({ text: '我来了', until: 12.5 });
  });

  it('可选字段缺省时不写入', () => {
    const minimal: ActorState = {
      id: 'p:1',
      kind: 'human',
      name: '你',
      transform: createTransform(),
      anim: 'idle',
      animPhase: 0,
    };
    const enc = encodeActorState(minimal);
    expect(enc['bubble']).toBeUndefined();
    expect(enc['tint']).toBeUndefined();
    const round = decodeActorState(enc);
    expect(round!.bubble).toBeUndefined();
    expect(round!.tint).toBeUndefined();
  });

  it('animPhase 被夹到 0..1', () => {
    const enc = { ...encodeActorState(base), animPhase: 5 };
    expect(decodeActorState(enc)!.animPhase).toBe(1);
    const enc2 = { ...encodeActorState(base), animPhase: -3 };
    expect(decodeActorState(enc2)!.animPhase).toBe(0);
    const enc3 = { ...encodeActorState(base), animPhase: NaN };
    expect(decodeActorState(enc3)!.animPhase).toBe(0);
  });

  it('拒绝非法 anim 名', () => {
    const enc = { ...encodeActorState(base), anim: 'dance' };
    expect(decodeActorState(enc)).toBeNull();
  });

  it('拒绝非法 id / kind', () => {
    expect(decodeActorState({ ...encodeActorState(base), id: 'zzz' })).toBeNull();
    expect(decodeActorState({ ...encodeActorState(base), kind: 'robot' })).toBeNull();
  });

  it('isAnimName 覆盖 spec 的 7 个状态', () => {
    for (const n of ['idle', 'walk', 'run', 'jump', 'fall', 'sit', 'emote']) {
      expect(isAnimName(n)).toBe(true);
    }
    expect(isAnimName('fly')).toBe(false);
    expect(isAnimName(1)).toBe(false);
  });
});

describe('Intent 编解码', () => {
  it('move 往返（含 speed）', () => {
    const i = { t: 'move' as const, to: [1, 0, 2] as [number, number, number], speed: 'run' as const };
    expect(decodeIntent(encodeIntent(i))).toEqual(i);
  });

  it('move 不带 speed 时不产出该字段', () => {
    const enc = encodeIntent({ t: 'move', to: [0, 0, 0] });
    expect(enc['speed']).toBeUndefined();
    expect(decodeIntent(enc)).toEqual({ t: 'move', to: [0, 0, 0] });
  });

  it('say 往返（含 ms）', () => {
    const i = { t: 'say' as const, text: '你好', ms: 3000 };
    expect(decodeIntent(encodeIntent(i))).toEqual(i);
  });

  it('全部 7 种意图都能往返', () => {
    const all = [
      { t: 'move', to: [1, 2, 3], speed: 'walk' },
      { t: 'look', at: [4, 5, 6] },
      { t: 'say', text: 'hi' },
      { t: 'emote', name: 'wave' },
      { t: 'sit', seat: 'sofa-1' },
      { t: 'wait', ms: 500 },
      { t: 'leave' },
    ];
    for (const i of all) {
      expect(decodeIntent(encodeIntent(i as never))).toEqual(i);
    }
  });

  it('未知 t 返回 null（宁可拒绝也不半执行）', () => {
    expect(decodeIntent({ t: 'dance', x: 1 })).toBeNull();
    expect(decodeIntent({})).toBeNull();
    expect(decodeIntent(null)).toBeNull();
  });

  it('字段缺失或类型错误返回 null', () => {
    expect(decodeIntent({ t: 'move', to: [1, 2] })).toBeNull();
    expect(decodeIntent({ t: 'say', text: '' })).toBeNull();
    expect(decodeIntent({ t: 'say', text: 123 })).toBeNull();
    expect(decodeIntent({ t: 'wait', ms: -1 })).toBeNull();
    expect(decodeIntent({ t: 'wait' })).toBeNull();
    expect(decodeIntent({ t: 'move', to: [0, 0, 0], speed: 'teleport' })).toBeNull();
  });
});

describe('插值（渲染层用）', () => {
  it('interpolateTransform 端点精确', () => {
    const a = createTransform([0, 0, 0]);
    const b = createTransform([10, 0, 0]);
    expect(interpolateTransform(a, b, 0).p).toEqual([0, 0, 0]);
    expect(interpolateTransform(a, b, 1).p).toEqual([10, 0, 0]);
    expect(interpolateTransform(a, b, 0.5).p[0]).toBeCloseTo(5, 10);
  });

  it('interpolateTransform 的 alpha 被夹到 0..1', () => {
    const a = createTransform([0, 0, 0]);
    const b = createTransform([10, 0, 0]);
    expect(interpolateTransform(a, b, 5).p[0]).toBe(10);
    expect(interpolateTransform(a, b, -5).p[0]).toBe(0);
  });

  it('slerp 走短弧：dot<0 时不绕远路', () => {
    // q 与 -q 表示同一旋转；slerp 必须走短弧而不是转 360°
    const q: [number, number, number, number] = [0, 0.7071067811865476, 0, 0.7071067811865476];
    const negQ: [number, number, number, number] = [-q[0], -q[1], -q[2], -q[3]];
    const mid = slerp(q, negQ, 0.5);
    // 短弧中点应接近 q 本身（因为 -q == q），而不是零四元数
    expect(Math.hypot(...mid)).toBeCloseTo(1, 10);
    const dot = Math.abs(mid[0] * q[0] + mid[1] * q[1] + mid[2] * q[2] + mid[3] * q[3]);
    expect(dot).toBeGreaterThan(0.99);
  });

  it('slerp 结果始终是单位四元数', () => {
    const a: [number, number, number, number] = [0, 0, 0, 1];
    const b = normalizeQuat([0.3, 0.4, 0.5, 0.6]);
    for (let i = 0; i <= 10; i++) {
      const r = slerp(a, b, i / 10);
      expect(Math.hypot(...r)).toBeCloseTo(1, 8);
    }
  });
});

describe('clampPitch', () => {
  it('夹在区间内', () => {
    expect(clampPitch(0.5, -0.2, 1.2)).toBe(0.5);
    expect(clampPitch(-5, -0.2, 1.2)).toBe(-0.2);
    expect(clampPitch(5, -0.2, 1.2)).toBe(1.2);
  });
});
