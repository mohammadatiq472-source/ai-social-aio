import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AvatarAnimator } from './avatar';

/**
 * 锁住一个真实 bug（2026-11-21，用户实测反馈）：
 * 「只要是跳了一下之后，他就又回到了原始初始的那种状态，没有动作」
 *
 * 根因：`oneShotPlaying` 只靠 three 的 mixer 'finished' 事件清除。
 * 那个事件在被 crossFade 打断、或 clip 时长异常时不会触发，
 * 于是标志永远 true，`update()` 每次都短路 return，动画永久冻在最后一帧。
 *
 * 修法：加时长兜底（oneShotMaxDuration=4s），回调与超时两条路都能解除。
 */
describe('一次性动作不会永久卡死', () => {
  function makeClips(names: string[], duration = 1) {
    return names.map(
      (name) =>
        new THREE.AnimationClip(name, duration, [
          new THREE.QuaternionKeyframeTrack(
            '.bones[Bone].quaternion',
            [0, duration / 2, duration],
            [0, 0, 0, 1, 0, 0.1, 0, 0.99, 0, 0, 0, 1],
          ),
        ]),
    );
  }

  function setup(clipDuration = 1) {
    const root = new THREE.Object3D();
    // 造一根骨骼，让 AnimationMixer 真的有东西可驱动
    const bone = new THREE.Object3D();
    bone.name = 'Bone';
    root.add(bone);
    const mixer = new THREE.AnimationMixer(root);
    const a = new AvatarAnimator('t:1');
    a.bind(mixer, makeClips(['idle', 'walk', 'jump', 'fall'], clipDuration));
    return { a, mixer, root };
  }

  it('跳一次后能回到 idle（不卡在 jump）', () => {
    const { a } = setup();
    const dt = 1 / 60;

    // 起跳
    a.update({ speed: 0, grounded: false, verticalSpeed: 1 }, dt);
    expect(a.state).toBe('jump');

    // 落地
    a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);

    // 推进足够多帧（超过兜底时长 4s）
    for (let i = 0; i < 300; i++) {
      a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);
    }

    expect(a.state).toBe('idle');
  });

  it('跳一次后能正常切到 walk（移动不被卡住）', () => {
    const { a } = setup();
    const dt = 1 / 60;

    a.update({ speed: 0, grounded: false, verticalSpeed: 1 }, dt);
    a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);

    // 走起来，推进 5 秒
    for (let i = 0; i < 300; i++) {
      a.update({ speed: 1.5, grounded: true, verticalSpeed: 0 }, dt);
    }

    expect(a.state).toBe('walk');
  });

  it('兜底时长内确实保持一次性动作（不会立刻被打断）', () => {
    const { a } = setup(3); // 3 秒的 jump clip
    const dt = 1 / 60;

    a.update({ speed: 0, grounded: false, verticalSpeed: 1 }, dt);
    expect(a.state).toBe('jump');

    // 只推进 0.5 秒，应该还在 jump（不该被 idle 打断）
    for (let i = 0; i < 30; i++) {
      a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);
    }
    // 注意：落地后 desired 是 idle，但 oneShotPlaying 会保持到兜底超时
    expect(a.state).toBe('jump');
  });

  it('超时后一定会回落（即使 finished 事件从未触发）', () => {
    const { a } = setup(100); // 故意给一个 100 秒的 clip，模拟 finished 永不触发
    const dt = 1 / 60;

    a.update({ speed: 0, grounded: false, verticalSpeed: 1 }, dt);
    expect(a.state).toBe('jump');

    // 推进 5 秒（超过兜底 4 秒）
    for (let i = 0; i < 300; i++) {
      a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);
    }

    // 兜底生效，应该已经回到 idle
    expect(a.state).toBe('idle');
  });

  it('空中可以立刻打断一次性动作（不需要等兜底）', () => {
    // 注意：必须把 sit 也放进 clip 列表，否则 transition() 会因为"资产没这个动作"
    // 保持当前状态，测试就测不到想测的东西（这是我第一版写错的地方）。
    const root = new THREE.Object3D();
    const bone = new THREE.Object3D();
    bone.name = 'Bone';
    root.add(bone);
    const mixer = new THREE.AnimationMixer(root);
    const a = new AvatarAnimator('t:2');
    a.bind(mixer, makeClips(['idle', 'walk', 'jump', 'fall', 'sit']));
    const dt = 1 / 60;

    // 先坐下（sit 是 one-shot）
    a.update({ speed: 0, grounded: true, verticalSpeed: 0, sitting: true }, dt);
    expect(a.state).toBe('sit');

    // 立刻起跳，应该马上切到 jump（不等 4 秒兜底）
    a.update({ speed: 0, grounded: false, verticalSpeed: 1 }, dt);
    expect(a.state).toBe('jump');
  });

  it('多次跳跃不会累积状态（每次都能正常回落）', () => {
    const { a } = setup();
    const dt = 1 / 60;

    for (let round = 0; round < 3; round++) {
      a.update({ speed: 0, grounded: false, verticalSpeed: 1 }, dt);
      a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);
      for (let i = 0; i < 300; i++) {
        a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);
      }
      expect(a.state, `第 ${round + 1} 次跳跃后没回落`).toBe('idle');
    }
  });

  it('1 秒 jump clip 播完后立刻回落，不出现 T-pose 空档', () => {
    const { a } = setup(1);
    const dt = 1 / 60;

    a.update({ speed: 0, grounded: false, verticalSpeed: 1 }, dt);
    expect(a.state).toBe('jump');

    // 落地后推进 1.1 秒：旧实现要等 1.2 秒 timeout，这 0.1 秒就是用户看到的十字架
    for (let i = 0; i < 66; i++) {
      a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, dt);
    }
    expect(a.state).toBe('idle');
    expect(a.playingClips().length).toBeGreaterThan(0);
  });

  it('连续跳跃的每一帧都至少有一个 action 在驱动骨骼（不会 bind pose）', () => {
    const { a } = setup(1);
    const dt = 1 / 60;

    for (let frame = 0; frame < 180; frame++) {
      // 25 帧空中、15 帧地面，循环 3 次；空中时每帧都按跳
      const phase = frame % 40;
      const grounded = phase >= 25;
      a.update({ speed: 0, grounded, verticalSpeed: grounded ? 0 : 1 }, dt);
      expect(a.playingClips().length, `frame ${frame} 没有 action 在播`).toBeGreaterThan(0);
    }
  });
});
