import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AvatarAnimator } from './avatar';

/**
 * 这条用例锁住一个真实踩过的 bug（2026-11-20，用户反馈"角色站着什么都不动"）。
 *
 * 根因：`mixer.clipAction(clip)` 返回的 action **默认是 enabled 且 weight=1**。
 * 7 个动画全部权重 1 同时作用于同一副骨骼，姿势互相叠加/抵消，
 * 结果看起来完全静止。走路时能看出腿在动，是因为走路幅度大、稀释后仍可见；
 * idle 的呼吸幅度只有几度，被稀释后完全看不出来。
 *
 * 实测证据：`__worldDebug.heroPlayingClips()` 曾返回
 *   ["jump:1.00","fall:1.00","run:1.00","walk:1.00","idle:1.00","sit:1.00","emote:1.00"]
 *
 * 修复：建好 action 后立刻 `setEffectiveWeight(0)` + `stop()`。
 */
describe('AvatarAnimator：同一时刻只能有一个动画在播', () => {
  /** 造一个只有 idle/walk/run 的最小资产。 */
  function makeClips(names: string[]) {
    return names.map((name) => {
      const clip = new THREE.AnimationClip(name, 1, [
        new THREE.QuaternionKeyframeTrack(
          '.bones[Bone].quaternion',
          [0, 0.5, 1],
          [0, 0, 0, 1, 0, 0.1, 0, 0.99, 0, 0, 0, 1],
        ),
      ]);
      return clip;
    });
  }

  it('bind 之后只有 idle 有权重，其余全为 0', () => {
    const root = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(root);
    const a = new AvatarAnimator('a:1');
    a.bind(mixer, makeClips(['idle', 'walk', 'run']));

    const playing = a.playingClips();
    expect(playing.length).toBe(1);
    expect(playing[0]).toMatch(/^idle:/);
  });

  it('切到 walk 后，只有 walk 有权重', () => {
    const root = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(root);
    const a = new AvatarAnimator('a:1');
    a.bind(mixer, makeClips(['idle', 'walk', 'run']));

    // 走起来
    a.update({ speed: 1.5, grounded: true, verticalSpeed: 0 }, 1 / 60);
    // 推进几帧让 crossfade 完成
    for (let i = 0; i < 30; i++) {
      a.update({ speed: 1.5, grounded: true, verticalSpeed: 0 }, 1 / 60);
    }

    expect(a.state).toBe('walk');
    const playing = a.playingClips();
    // crossfade 期间可能两个都有权重，但 walk 必须占主导
    const walkWeight = playing.find((p) => p.startsWith('walk:'))?.split(':')[1];
    expect(walkWeight).toBeDefined();
    expect(Number(walkWeight)).toBeGreaterThan(0.5);
  });

  it('资产缺某个 clip 时不会崩，且不会把别的动画权重搞乱', () => {
    const root = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(root);
    const a = new AvatarAnimator('a:1');
    // 只有 idle 和 walk，没有 run
    a.bind(mixer, makeClips(['idle', 'walk']), { run: 'walk' });

    const playing = a.playingClips();
    expect(playing.length).toBe(1);
    // 注意：hasClip 查的是**原始 clip 名**（不含别名），run 本来就不在资产里，
    // 所以这里应该用 availableStates() 验证"run 这个状态可通过别名使用"。
    expect(a.hasClip('run')).toBe(false); // 原始 clip 确实没有
    expect(a.availableStates()).toContain('run'); // 但状态可用（借 walk）
  });
});
