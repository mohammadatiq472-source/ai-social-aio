import { describe, it, expect } from 'vitest';
import type { RoomSeat } from '../core/room';
import {
  SIT_REACH,
  STAND_OFFSET,
  FOCUS_EASE_SECONDS,
  initialInteractState,
  nearestSeat,
  toggleSit,
  sitPose,
  standPose,
  movementAllowed,
  canPush,
  initialFocus,
  focusOn,
  advanceFocus,
  smoothstep,
  lerpFocus,
} from './index';

const SEAT_A: RoomSeat = { id: 'a', pos: [0, 0, 2], rot: 0 };
const SEAT_B: RoomSeat = { id: 'b', pos: [3, 0, 0], rot: Math.PI / 2 };
const CAPSULE_CENTER = 0.85;

describe('M10 坐下：nearestSeat / toggleSit', () => {
  it('SIT_REACH 是 1.2m（spec §6 M10 原文）', () => {
    expect(SIT_REACH).toBe(1.2);
  });

  it('1.2m 内找得到，1.2m 外找不到', () => {
    expect(nearestSeat([SEAT_A], [0, 0, 1.0])).not.toBeNull();
    expect(nearestSeat([SEAT_A], [0, 0, 0.8])).not.toBeNull(); // 1.2m 正好
    expect(nearestSeat([SEAT_A], [0, 0, 0.7])).toBeNull(); // 1.3m
  });

  it('多个座位时取最近的', () => {
    // 点 (1,0,1)：到 a(0,0,2) 的距离 √2≈1.414，到 b(3,0,0) 的距离 √5≈2.236
    // 两个都超 1.2 → 返回 null（不能因为"有座位"就随便选一个）
    expect(nearestSeat([SEAT_A, SEAT_B], [1, 0, 1])).toBeNull();

    // 点 (0,0,1.5)：到 a 是 0.5m，到 b 是 √(9+2.25)≈3.35 → 选 a
    const nearA = nearestSeat([SEAT_A, SEAT_B], [0, 0, 1.5]);
    expect(nearA).not.toBeNull();
    expect(nearA!.seat.id).toBe('a');
    expect(nearA!.dist).toBeCloseTo(0.5, 9);

    // 点 (2.5,0,0)：到 b 是 0.5m，到 a 是 √(6.25+4)≈3.20 → 选 b
    const nearB = nearestSeat([SEAT_A, SEAT_B], [2.5, 0, 0]);
    expect(nearB).not.toBeNull();
    expect(nearB!.seat.id).toBe('b');
    expect(nearB!.dist).toBeCloseTo(0.5, 9);
  });

  it('只比水平距离：座位高度差不影响判定', () => {
    const high: RoomSeat = { id: 'h', pos: [0, 2.0, 0.5], rot: 0 };
    // 三维距离 2.06m，水平 0.5m → 够得着
    expect(nearestSeat([high], [0, 0, 0])).not.toBeNull();
  });

  it('站着按 E → sit；再按 → stand', () => {
    const free = initialInteractState();
    const r1 = toggleSit(free, [SEAT_A], [0, 0, 1.5]);
    expect(r1.action).toBe('sit');
    if (r1.action === 'sit') expect(r1.seat.id).toBe('a');

    const sitting = { ...free, mode: 'sitting' as const, seatId: 'a' };
    const r2 = toggleSit(sitting, [SEAT_A], [0, 0, 1.5]);
    expect(r2.action).toBe('stand');
    if (r2.action === 'stand') expect(r2.from).toBe('a');
  });

  it('附近没座位 → none(no_seat_in_reach)，不抛也不静默坐', () => {
    const r = toggleSit(initialInteractState(), [SEAT_A], [10, 0, 10]);
    expect(r.action).toBe('none');
    if (r.action === 'none') expect(r.reason).toBe('no_seat_in_reach');
  });

  it('坐着时座位被删了也能起身（不被状态卡死）', () => {
    const sitting = { ...initialInteractState(), mode: 'sitting' as const, seatId: 'gone' };
    const r = toggleSit(sitting, [], [0, 0, 0]);
    expect(r.action).toBe('stand');
  });
});

describe('M10 坐姿吸附：sitPose / standPose', () => {
  it('sitPose 的 y 是座位 y + 胶囊中心高（不是座位 y 本身，否则半埋进椅子）', () => {
    const pose = sitPose(SEAT_A, CAPSULE_CENTER);
    expect(pose.p[0]).toBe(0);
    expect(pose.p[1]).toBeCloseTo(0.85, 9);
    expect(pose.p[2]).toBe(2);
    expect(pose.yaw).toBe(0);
  });

  it('sitPose 保留座位朝向', () => {
    expect(sitPose(SEAT_B, CAPSULE_CENTER).yaw).toBeCloseTo(Math.PI / 2, 9);
  });

  it('standPose 在座位前方 STAND_OFFSET 处（不原地起身，避免立刻又坐下）', () => {
    expect(STAND_OFFSET).toBeGreaterThan(0.4);
    const pose = standPose(SEAT_A, CAPSULE_CENTER);
    // 座位 rot=0 → 前方是 +z
    expect(pose.p[0]).toBeCloseTo(0, 9);
    expect(pose.p[2]).toBeCloseTo(2 + STAND_OFFSET, 9);
    // 起身后离座位正好 STAND_OFFSET > 0，不会立刻重新进 reach
    expect(pose.p[2] - SEAT_A.pos[2]).toBeGreaterThan(0.4);
  });

  it('standPose 的朝向与座位一致', () => {
    expect(standPose(SEAT_B, CAPSULE_CENTER).yaw).toBeCloseTo(Math.PI / 2, 9);
    const pose = standPose(SEAT_B, CAPSULE_CENTER);
    // rot=π/2 → 前方是 +x
    expect(pose.p[0]).toBeCloseTo(3 + STAND_OFFSET, 9);
    expect(pose.p[2]).toBeCloseTo(0, 9);
  });

  it('movementAllowed：坐着禁用移动，站着允许', () => {
    expect(movementAllowed(initialInteractState())).toBe(true);
    expect(movementAllowed({ ...initialInteractState(), mode: 'sitting', seatId: 'a' })).toBe(false);
  });
});

describe('M10 推动：canPush 只是判定，不产生推力', () => {
  it('正前方 0.85m 内的箱子 → true', () => {
    // yaw=0 面向 +z
    expect(canPush([0, 0, 0], 0, [[0, 0, 0.7]])).toBe(true);
  });

  it('背后的箱子不算够得着', () => {
    expect(canPush([0, 0, 0], 0, [[0, 0, -0.7]])).toBe(false);
  });

  it('超出 PUSH_REACH 不算', () => {
    expect(canPush([0, 0, 0], 0, [[0, 0, 1.5]])).toBe(false);
  });

  it('侧面的箱子（点积 = 0）不算', () => {
    expect(canPush([0, 0, 0], 0, [[0.5, 0, 0]])).toBe(false);
  });

  it('朝向变化会影响判定（yaw=π 面向 -z）', () => {
    expect(canPush([0, 0, 0], Math.PI, [[0, 0, -0.7]])).toBe(true);
    expect(canPush([0, 0, 0], Math.PI, [[0, 0, 0.7]])).toBe(false);
  });

  it('多个箱子只要有一个在前方就 true', () => {
    expect(canPush([0, 0, 0], 0, [[0, 0, -2], [0, 0, 0.6]])).toBe(true);
  });
});

describe('M10 看向：焦点缓动', () => {
  it('FOCUS_EASE_SECONDS 是 1s（spec §6 M10 原文）', () => {
    expect(FOCUS_EASE_SECONDS).toBe(1);
  });

  it('focusOn 把进度重置为 0', () => {
    const f = focusOn('a:2');
    expect(f.target).toBe('a:2');
    expect(f.t).toBe(0);
  });

  it('1 秒后缓动到位', () => {
    let t = focusOn('a:2').t;
    // 60 步 × 1/60 = 1s
    for (let i = 0; i < 60; i++) t = advanceFocus({ target: 'a:2', t }, 1 / 60);
    expect(t).toBe(1);
  });

  it('缓动是单调递增的，不会跳变', () => {
    let t = 0;
    let prev = -1;
    for (let i = 0; i < 30; i++) {
      t = advanceFocus({ target: 'a:2', t }, 1 / 60);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('已到位时再推进不变（幂等）', () => {
    expect(advanceFocus({ target: 'a:2', t: 1 }, 1 / 60)).toBe(1);
  });

  it('duration=0 时立刻到位（不除零）', () => {
    expect(advanceFocus({ target: 'a:2', t: 0 }, 1 / 60, 0)).toBe(1);
  });

  it('initialFocus 的 t=1（一开始就"已到位"，不缓动）', () => {
    expect(initialFocus().t).toBe(1);
    expect(initialFocus().target).toBeNull();
  });
});

describe('M10 smoothstep / lerpFocus', () => {
  it('smoothstep 两端为 0/1，中点为 0.5', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 9);
  });

  it('smoothstep 在两端速度趋近 0（缓入缓出）', () => {
    const d1 = smoothstep(0.01) - smoothstep(0);
    const dMid = smoothstep(0.51) - smoothstep(0.5);
    expect(d1).toBeLessThan(dMid); // 起点比中点慢
  });

  it('smoothstep 夹取越界输入', () => {
    expect(smoothstep(-5)).toBe(0);
    expect(smoothstep(5)).toBe(1);
  });

  it('lerpFocus：t=0 是起点，t=1 是终点', () => {
    const from: [number, number, number] = [0, 0, 0];
    const to: [number, number, number] = [10, 5, -3];
    expect(lerpFocus(from, to, 0)).toEqual([0, 0, 0]);
    expect(lerpFocus(from, to, 1)).toEqual([10, 5, -3]);
  });

  it('lerpFocus 中点在两端之间且各分量都动了', () => {
    const mid = lerpFocus([0, 0, 0], [10, 5, -3], 0.5);
    expect(mid[0]).toBeCloseTo(5, 9);
    expect(mid[1]).toBeCloseTo(2.5, 9);
    expect(mid[2]).toBeCloseTo(-1.5, 9);
  });
});
