import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_SPRING,
  PITCH_MAX,
  PITCH_MIN,
  ThirdPersonCamera,
  ZOOM_MAX,
  ZOOM_MIN,
  clampToGround,
  orbitPosition,
  springStep,
  springVec3,
} from './camera';

describe('弹簧插值', () => {
  it('单调收敛到目标，不过冲（临界阻尼）', () => {
    let value = 0;
    let velocity = 0;
    const target = 10;
    const dt = 1 / 60;
    let prev = -Infinity;
    let overshot = false;

    for (let i = 0; i < 240; i++) {
      const next = springStep(value, velocity, target, dt, { stiffness: 9, damping: 1 });
      value = next.value;
      velocity = next.velocity;
      if (value > target + 1e-6) overshot = true;
      expect(Number.isFinite(value)).toBe(true);
      prev = value;
    }
    expect(prev).toBeCloseTo(target, 1);
    expect(overshot).toBe(false);
  });

  it('大 dt 也不发散（半隐式欧拉）', () => {
    let value = 0;
    let velocity = 0;
    for (let i = 0; i < 100; i++) {
      const next = springStep(value, velocity, 10, 0.1, DEFAULT_SPRING);
      value = next.value;
      velocity = next.velocity;
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThan(1000);
    }
  });

  it('已经在目标上时不动', () => {
    const r = springStep(5, 0, 5, 1 / 60);
    expect(r.value).toBe(5);
    expect(r.velocity).toBeCloseTo(0, 10);
  });

  it('springVec3 三轴独立收敛', () => {
    const cur = new THREE.Vector3(0, 0, 0);
    const vel = new THREE.Vector3(0, 0, 0);
    const target = new THREE.Vector3(3, 4, 5);
    for (let i = 0; i < 300; i++) {
      springVec3(cur, vel, target, 1 / 60, { stiffness: 9, damping: 1 });
    }
    expect(cur.x).toBeCloseTo(3, 1);
    expect(cur.y).toBeCloseTo(4, 1);
    expect(cur.z).toBeCloseTo(5, 1);
  });
});

describe('orbitPosition 球坐标', () => {
  const origin = new THREE.Vector3(0, 0, 0);

  it('pitch=0 时镜头与目标同高', () => {
    const p = orbitPosition(origin, 0, 0, 5);
    expect(p.y).toBeCloseTo(0, 10);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(5, 10);
  });

  it('pitch>0 时镜头在上方（俯视）', () => {
    const p = orbitPosition(origin, 0, Math.PI / 4, 5);
    expect(p.y).toBeGreaterThan(0);
  });

  it('pitch<0 时镜头在下方', () => {
    const p = orbitPosition(origin, 0, -Math.PI / 4, 5);
    expect(p.y).toBeLessThan(0);
  });

  it('距离恒等于 distance（球面上）', () => {
    for (const yaw of [0, 0.5, 1.2, Math.PI, -2]) {
      for (const pitch of [-0.2, 0, 0.4, 1.1]) {
        const p = orbitPosition(origin, yaw, pitch, 4.2);
        expect(p.distanceTo(origin)).toBeCloseTo(4.2, 10);
      }
    }
  });

  it('yaw 旋转 180° 会到目标背面', () => {
    const a = orbitPosition(origin, 0, 0, 5);
    const b = orbitPosition(origin, Math.PI, 0, 5);
    expect(a.x).toBeCloseTo(-b.x, 10);
    expect(a.z).toBeCloseTo(-b.z, 10);
  });
});

describe('clampToGround 地面夹取', () => {
  it('低于地面时抬到地面 + 余量', () => {
    const p = new THREE.Vector3(0, -3, 0);
    clampToGround(p, 0, 0.35);
    expect(p.y).toBeCloseTo(0.35, 10);
  });

  it('高于地面时不动', () => {
    const p = new THREE.Vector3(0, 5, 0);
    clampToGround(p, 0, 0.35);
    expect(p.y).toBe(5);
  });

  it('支持非零地面高度（M3 换成射线后依然成立）', () => {
    const p = new THREE.Vector3(0, 1, 0);
    clampToGround(p, 2, 0.35);
    expect(p.y).toBeCloseTo(2.35, 10);
  });
});

describe('ThirdPersonCamera 俯仰与缩放限制', () => {
  it('pitch 被夹在 PITCH_MIN..PITCH_MAX，不会翻过头顶', () => {
    const cam = new ThirdPersonCamera({ pitch: 0 });
    // 疯狂往下拖
    for (let i = 0; i < 100; i++) cam.orbitBy(0, 100);
    expect(cam.currentPitch).toBeLessThanOrEqual(PITCH_MAX + 1e-9);
    // 疯狂往上拖
    for (let i = 0; i < 200; i++) cam.orbitBy(0, -100);
    expect(cam.currentPitch).toBeGreaterThanOrEqual(PITCH_MIN - 1e-9);
  });

  it('distance 被夹在 ZOOM_MIN..ZOOM_MAX', () => {
    const cam = new ThirdPersonCamera({ distance: 4 });
    for (let i = 0; i < 100; i++) cam.zoomBy(-1);
    expect(cam.currentDistance).toBeGreaterThanOrEqual(ZOOM_MIN);
    for (let i = 0; i < 200; i++) cam.zoomBy(1);
    expect(cam.currentDistance).toBeLessThanOrEqual(ZOOM_MAX);
  });

  it('yaw 可以无限转（没有夹取，绕圈是合法的）', () => {
    const cam = new ThirdPersonCamera({ yaw: 0 });
    cam.orbitBy(1000, 0);
    expect(cam.currentYaw).not.toBe(0);
    expect(Number.isFinite(cam.currentYaw)).toBe(true);
  });

  it('getForward 与 getRight 正交且水平', () => {
    const cam = new ThirdPersonCamera({ yaw: 0.7 });
    const f = cam.getForward();
    const r = cam.getRight();
    expect(f.y).toBeCloseTo(0, 10);
    expect(r.y).toBeCloseTo(0, 10);
    expect(f.dot(r)).toBeCloseTo(0, 10);
    expect(f.length()).toBeCloseTo(1, 10);
  });

  it('setAspect 拒绝非法值（0 / NaN 会让投影矩阵变 NaN，整屏黑）', () => {
    const cam = new ThirdPersonCamera();
    cam.setAspect(16 / 9);
    expect(cam.camera.aspect).toBeCloseTo(16 / 9, 10);
    cam.setAspect(0);
    expect(cam.camera.aspect).toBeCloseTo(16 / 9, 10);
    cam.setAspect(NaN);
    expect(cam.camera.aspect).toBeCloseTo(16 / 9, 10);
  });

  it('update 后镜头在角色上方且保持距离', () => {
    const cam = new ThirdPersonCamera({ distance: 4, pitch: 0.3 });
    const actor = new THREE.Vector3(0, 0, 0);
    cam.snapTo(actor);
    expect(cam.camera.position.y).toBeGreaterThan(0);
    const dist = cam.camera.position.distanceTo(new THREE.Vector3(0, 1.25, 0));
    expect(dist).toBeCloseTo(4, 5);
  });

  it('update 不会让镜头钻到地面以下（clamp 生效）', () => {
    const cam = new ThirdPersonCamera({ distance: 9, pitch: PITCH_MIN });
    cam.snapTo(new THREE.Vector3(0, 0, 0));
    expect(cam.camera.position.y).toBeGreaterThanOrEqual(cam.groundClearance - 1e-9);
  });

  it('groundHeight 可替换（M3 接物理射线时不用改调用方）', () => {
    const cam = new ThirdPersonCamera({ distance: 5, pitch: -0.2 });
    cam.groundHeight = (x, z) => (x === 0 && z === 0 ? 10 : 0);
    cam.snapTo(new THREE.Vector3(0, 10, 0));
    expect(cam.camera.position.y).toBeGreaterThan(10);
  });

  it('首帧直接吸附，不从原点飞过去', () => {
    const cam = new ThirdPersonCamera({ distance: 4 });
    cam.snapTo(new THREE.Vector3(50, 0, 50));
    const expected = orbitPosition(new THREE.Vector3(50, 1.25, 50), Math.PI, 0.32, 4);
    expect(cam.camera.position.distanceTo(expected)).toBeLessThan(0.01);
  });
});
