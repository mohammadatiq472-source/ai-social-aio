/**
 * 相机焦点接口单测（M10 第 3 条：点击某个角色，1s 缓动切过去）。
 *
 * 为什么单独一个文件而不是加进 `camera.test.ts`：
 * `camera.test.ts` 锁的是 M1 的相机数学（弹簧、球坐标、夹取），归 render-agent；
 * 焦点是 M10 加的能力，出问题时应该一眼看出"是 M10 引入的"。
 *
 * 这里锁三件容易做错的事：
 * 1. 缓动**1 秒**到位（不是立刻、也不是永远在漂）；
 * 2. `focusOn()` 会重置进度，`updateFocusTarget()` **不会**——
 *    这两者混用会导致"镜头一动不动"（实测踩过）；
 * 3. `clearFocus()` 后回到跟随自己。
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FOCUS_EASE_SECONDS, ThirdPersonCamera } from './camera';

/** 造一个相机并让它完成首帧吸附（否则第一次 update 会直接 snap，测不出缓动）。 */
function readyCam(): ThirdPersonCamera {
  const cam = new ThirdPersonCamera({ distance: 4 });
  cam.snapTo(new THREE.Vector3(0, 0, 0));
  return cam;
}

/** 跑 N 帧，每帧 dt 秒。 */
function tick(cam: ThirdPersonCamera, frames: number, dt: number, selfPos = new THREE.Vector3(0, 0, 0)): void {
  for (let i = 0; i < frames; i++) cam.update(selfPos, dt);
}

describe('M10 相机焦点：常量', () => {
  it('FOCUS_EASE_SECONDS = 1（spec §6 M10 原文）', () => {
    expect(FOCUS_EASE_SECONDS).toBe(1);
  });
});

describe('M10 相机焦点：缓动到位', () => {
  it('focusOn 后 1 秒内进度到 1', () => {
    const cam = readyCam();
    const target = new THREE.Vector3(6, 0, 0);
    cam.focusOn(target);
    expect(cam.focusProgress).toBe(0);

    // 60 帧 × 1/60 = 1 秒
    tick(cam, 60, 1 / 60);
    expect(cam.focusProgress).toBe(1);
  });

  it('缓动过程中注视点单调靠近目标（不会先跑远）', () => {
    const cam = readyCam();
    const target = new THREE.Vector3(6, 0, 0);
    cam.focusOn(target);

    let prevDist = Infinity;
    for (let i = 0; i < 40; i++) {
      cam.update(new THREE.Vector3(0, 0, 0), 1 / 60);
      // 用相机位置到"目标注视点"的距离间接观察（相机始终 lookAt 注视点）
      const d = cam.camera.position.distanceTo(
        new THREE.Vector3(target.x, target.y + 1.25, target.z),
      );
      // 单调性允许 1cm 的数值抖动（球坐标 + 弹簧）
      expect(d).toBeLessThanOrEqual(prevDist + 0.01);
      prevDist = d;
    }
  });

  it('到位后不再漂（锁定在目标上，位移单调衰减）', () => {
    const cam = readyCam();
    const target = new THREE.Vector3(6, 0, 0);
    cam.focusOn(target);
    // 焦点缓动 1s 到位，但**相机位置**由弹簧跟随注视点，弹簧是渐近收敛的
    // （临界阻尼：残差按 e^(-ωt) 衰减，永不精确到 0）。
    // 所以这里不断言"绝对静止"，而断言"每 0.5 秒的位移在衰减"——
    // 那才是"锁定"的可观测含义：不会持续漂移。
    tick(cam, 180, 1 / 60);

    const p1 = cam.camera.position.clone();
    tick(cam, 30, 1 / 60);
    const p2 = cam.camera.position.clone();
    tick(cam, 30, 1 / 60);
    const p3 = cam.camera.position.clone();

    const drift1 = p1.distanceTo(p2);
    const drift2 = p2.distanceTo(p3);
    // 第一段已经很小（3 秒后残差 < 5cm）
    expect(drift1).toBeLessThan(0.05);
    // 且在衰减：后一段比前一段更小
    expect(drift2).toBeLessThanOrEqual(drift1 + 1e-6);
  });
});

describe('M10 相机焦点：focusOn 与 updateFocusTarget 的区别', () => {
  it('focusOn 每次调用都重置进度为 0', () => {
    const cam = readyCam();
    cam.focusOn(new THREE.Vector3(6, 0, 0));
    tick(cam, 30, 1 / 60);
    expect(cam.focusProgress).toBeGreaterThan(0.4);

    cam.focusOn(new THREE.Vector3(6, 0, 0));
    expect(cam.focusProgress).toBe(0);
  });

  it('updateFocusTarget 不重置进度（目标在走时用这个）', () => {
    const cam = readyCam();
    cam.focusOn(new THREE.Vector3(6, 0, 0));
    tick(cam, 30, 1 / 60);
    const mid = cam.focusProgress;
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(1);

    // 目标移动了：只更新位置，进度不变
    cam.updateFocusTarget(new THREE.Vector3(7, 0, 1));
    expect(cam.focusProgress).toBe(mid);
  });

  it('每帧调 focusOn（错误用法）会让进度永远停在 0 → 镜头不动', () => {
    // 这条是**反向验证**：锁住"为什么必须用 updateFocusTarget"。
    // 如果哪天有人把 updateFocusTarget 删了、改成每帧 focusOn，
    // 这个用例会证明"进度永远起不来"。
    const cam = readyCam();
    const start = cam.camera.position.clone();
    const target = new THREE.Vector3(6, 0, 0);

    for (let i = 0; i < 120; i++) {
      cam.focusOn(target); // 每帧重置 ← 错误用法
      cam.update(new THREE.Vector3(0, 0, 0), 1 / 60);
    }
    // 进度几乎没动（每帧被重置到 0，只前进了 1/60）
    expect(cam.focusProgress).toBeLessThan(0.05);
    // 相机也几乎没往目标移动（与正确用法的对照组见下一个用例）
    expect(cam.camera.position.distanceTo(start)).toBeLessThan(2);
  });

  it('正确用法（只调一次 focusOn）镜头真的跟过去了', () => {
    const cam = readyCam();
    const start = cam.camera.position.clone();
    const target = new THREE.Vector3(6, 0, 0);

    cam.focusOn(target);
    for (let i = 0; i < 120; i++) {
      cam.update(new THREE.Vector3(0, 0, 0), 1 / 60);
    }
    // 注视点移到 (6,1.25,0)，相机也应该跟着挪过去（位移应该 > 3m）
    expect(cam.camera.position.distanceTo(start)).toBeGreaterThan(3);
  });
});

describe('M10 相机焦点：clearFocus / hasFocus', () => {
  it('hasFocus 反映是否有目标', () => {
    const cam = readyCam();
    expect(cam.hasFocus).toBe(false);
    cam.focusOn(new THREE.Vector3(6, 0, 0));
    expect(cam.hasFocus).toBe(true);
    cam.clearFocus();
    expect(cam.hasFocus).toBe(false);
  });

  it('clearFocus 后回到跟随自己（不再锁在目标上）', () => {
    const cam = readyCam();
    cam.focusOn(new THREE.Vector3(6, 0, 0));
    tick(cam, 90, 1 / 60);

    cam.clearFocus();
    // 给足时间缓动回自己
    tick(cam, 120, 1 / 60);

    // 自己站在原点 → 相机应该在原点附近（距离 < 5m，而不是停在 6m 外的目标旁）
    expect(cam.camera.position.distanceTo(new THREE.Vector3(0, 0, 0))).toBeLessThan(5);
    expect(cam.hasFocus).toBe(false);
  });

  it('没有焦点时 clearFocus 是幂等的（不抛、不改变状态）', () => {
    const cam = readyCam();
    expect(() => cam.clearFocus()).not.toThrow();
    expect(cam.hasFocus).toBe(false);
  });

  it('snapFocus 立刻到位（不做缓动）', () => {
    const cam = readyCam();
    cam.snapFocus(new THREE.Vector3(6, 0, 0));
    expect(cam.focusProgress).toBe(1);
    expect(cam.hasFocus).toBe(true);

    // snapFocus 只把**焦点状态**设成"已到位"；相机位置的跟随仍是弹簧，
    // 所以这里断言的是"注视点已经切过去了"（focusProgress=1 + hasFocus），
    // 而不是"相机位置瞬间到了"。后者需要连调 snapTo，语义不同。
    // 反向确认：连续 update 后相机确实朝目标移动（而不是留在原点）
    const start = cam.camera.position.clone();
    tick(cam, 120, 1 / 60);
    expect(cam.camera.position.distanceTo(start)).toBeGreaterThan(3);
  });
});

describe('M10 相机焦点：不影响玩家的环绕意图', () => {
  it('焦点切换不改 yaw / pitch / distance（右键拖拽的机位不被点角色打乱）', () => {
    const cam = readyCam();
    cam.orbitBy(120, 40); // 玩家自己转了个机位
    const yaw = cam.currentYaw;
    const pitch = cam.currentPitch;
    const dist = cam.currentDistance;

    cam.focusOn(new THREE.Vector3(6, 0, 0));
    tick(cam, 60, 1 / 60);

    expect(cam.currentYaw).toBe(yaw);
    expect(cam.currentPitch).toBe(pitch);
    expect(cam.currentDistance).toBe(dist);
  });
});
