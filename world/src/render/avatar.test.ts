import { describe, it, expect } from 'vitest';
import {
  ANIM_PRIORITY,
  AvatarAnimator,
  CROSSFADE_SECONDS,
  LOOP_ONCE,
  LOOP_REPEAT,
  ONE_SHOT_STATES,
  fallbackState,
  phaseOffsetFor,
  resolveTransition,
  selectAnimState,
} from './avatar';
import type { MixerLike } from './avatar';

/**
 * M5 状态机的**逻辑**验收（spec §6 M5）。
 *
 * 这些测试锁住的是转移规则：优先级、crossfade 时长、一次性动作、相位范围。
 * 视觉上的"无跳变"最终只能人看（D7 录片时确认），但"跳变的原因"大多在这里：
 * 优先级写错 → 空中跑步；crossfade 用错 → 动作顿一下；相位没加 → 机器人同步。
 */

// ───────────────────────────── 假 mixer ─────────────────────────────
//
// 类型策略：`MixerLike` / `AnimationActionLike` 是 `Pick<three 真实类型>`，
// 假对象当然不满足它们（缺 blendMode/loop/weight 等 20 多个属性）。
// 所以这里定义**自己的窄类型**（FakeAction / FakeMixer），只在交给 AvatarAnimator
// 的那一处做一次 `as unknown as` 转换 —— 转型集中、诚实，不是到处撒 any。

/** 假 action 的窄类型：只含本测试真正用到的东西。 */
interface FakeAction {
  calls: string[];
  reset(): FakeAction;
  play(): FakeAction;
  stop(): FakeAction;
  setLoop(mode: number): FakeAction;
  setEffectiveWeight(w: number): FakeAction;
  setEffectiveTimeScale(s: number): FakeAction;
  crossFadeFrom(from: FakeAction, dur: number): FakeAction;
  fadeIn(): FakeAction;
  fadeOut(): FakeAction;
  getClip(): { name: string; duration: number };
  getEffectiveWeight(): number;
  isRunning(): boolean;
  time: number;
  enabled: boolean;
}

/** 假 mixer 的窄类型。 */
interface FakeMixer {
  actions: Map<string, FakeAction>;
  updateCount(): number;
  clipAction(clip: { name: string; duration: number }): FakeAction;
  update(dt: number): void;
  setTime(t: number): void;
  stopAllAction(): void;
  readonly time: number;
}

/** 把假 mixer 交给生产代码时的唯一转型点。 */
const asMixer = (m: FakeMixer): MixerLike => m as unknown as MixerLike;

/** 记录调用序列的假 action，用来断言 crossFadeFrom 的时长与参数。 */
function makeAction(clipName: string, duration = 1): FakeAction {
  const calls: string[] = [];
  let weight = 0;
  let time = 0;
  const action: FakeAction = {
    calls,
    reset() {
      calls.push('reset');
      return action;
    },
    play() {
      calls.push('play');
      weight = 1;
      return action;
    },
    stop() {
      calls.push('stop');
      weight = 0;
      return action;
    },
    setLoop(mode: number) {
      calls.push(`setLoop:${mode}`);
      return action;
    },
    setEffectiveWeight(w: number) {
      calls.push(`weight:${w}`);
      weight = w;
      return action;
    },
    setEffectiveTimeScale(s: number) {
      calls.push(`timeScale:${s}`);
      return action;
    },
    crossFadeFrom(from: FakeAction, dur: number) {
      calls.push(`crossFadeFrom:${from.getClip().name}:${dur}`);
      return action;
    },
    fadeIn() {
      calls.push('fadeIn');
      return action;
    },
    fadeOut() {
      calls.push('fadeOut');
      return action;
    },
    getClip() {
      return { name: clipName, duration };
    },
    getEffectiveWeight() {
      return weight;
    },
    isRunning() {
      return weight > 0;
    },
    get time() {
      return time;
    },
    set time(v: number) {
      time = v;
    },
    enabled: true,
  };
  return action;
}

function makeMixer(clipNames: string[]): FakeMixer {
  const actions = new Map<string, FakeAction>();
  let mixerTime = 0;
  let updateCount = 0;
  const mixer: FakeMixer = {
    actions,
    updateCount: () => updateCount,
    clipAction(clip: { name: string; duration: number }) {
      let a = actions.get(clip.name);
      if (!a) {
        a = makeAction(clip.name, clip.duration);
        actions.set(clip.name, a);
      }
      return a;
    },
    update(dt: number) {
      updateCount += 1;
      mixerTime += dt;
    },
    setTime(t: number) {
      mixerTime = t;
    },
    stopAllAction() {
      actions.clear();
    },
    get time() {
      return mixerTime;
    },
  };
  void clipNames;
  return mixer;
}

function makeClips(names: string[], duration = 1) {
  return names.map((name) => ({ name, duration }) as never);
}

// ───────────────────────────── 优先级 ─────────────────────────────

describe('动画优先级（spec §6 M5 第 1 条：jump > fall > run > walk > idle）', () => {
  it('优先级数值严格满足 jump > fall > run > walk > idle', () => {
    expect(ANIM_PRIORITY.jump).toBeGreaterThan(ANIM_PRIORITY.fall);
    expect(ANIM_PRIORITY.fall).toBeGreaterThan(ANIM_PRIORITY.run);
    expect(ANIM_PRIORITY.run).toBeGreaterThan(ANIM_PRIORITY.walk);
    expect(ANIM_PRIORITY.walk).toBeGreaterThan(ANIM_PRIORITY.idle);
  });

  it('crossfade 时长是 spec 写的 0.2 秒', () => {
    expect(CROSSFADE_SECONDS).toBe(0.2);
  });

  it('一次性动作集合包含 jump / sit / emote', () => {
    expect(ONE_SHOT_STATES.has('jump')).toBe(true);
    expect(ONE_SHOT_STATES.has('sit')).toBe(true);
    expect(ONE_SHOT_STATES.has('emote')).toBe(true);
    // idle/walk/run 是循环的，不能进这个集合
    expect(ONE_SHOT_STATES.has('idle')).toBe(false);
    expect(ONE_SHOT_STATES.has('walk')).toBe(false);
    expect(ONE_SHOT_STATES.has('run')).toBe(false);
  });
});

// ───────────────────────────── 状态选择 ─────────────────────────────

describe('selectAnimState：由物理状态推导动画', () => {
  it('静止在地面 → idle', () => {
    expect(selectAnimState({ speed: 0, grounded: true, verticalSpeed: 0 })).toBe('idle');
  });

  it('慢走 → walk', () => {
    expect(selectAnimState({ speed: 2.4, grounded: true, verticalSpeed: 0 })).toBe('walk');
  });

  it('快跑 → run', () => {
    expect(selectAnimState({ speed: 5.0, grounded: true, verticalSpeed: 0 })).toBe('run');
  });

  it('向上且离地 → jump', () => {
    expect(selectAnimState({ speed: 0, grounded: false, verticalSpeed: 5.2 })).toBe('jump');
  });

  it('向下且离地 → fall', () => {
    expect(selectAnimState({ speed: 0, grounded: false, verticalSpeed: -3 })).toBe('fall');
  });

  it('离地时**永远**不播 walk/run（防"空中跑步"）', () => {
    // 这是 M5 验收里"起跳不出现跑步动画"的直接断言
    for (const speed of [0, 1, 2.4, 5, 10]) {
      for (const vSpeed of [-10, -1, 0, 1, 5.2]) {
        const s = selectAnimState({ speed, grounded: false, verticalSpeed: vSpeed });
        expect(s === 'jump' || s === 'fall', `speed=${speed} v=${vSpeed} 得到 ${s}`).toBe(true);
      }
    }
  });

  it('微抖不切状态：速度低于阈值仍算 idle', () => {
    expect(selectAnimState({ speed: 0.1, grounded: true, verticalSpeed: 0 })).toBe('idle');
    expect(selectAnimState({ speed: 0.14, grounded: true, verticalSpeed: 0 })).toBe('idle');
  });

  it('runThreshold 可配置（不同角色不同步幅）', () => {
    expect(selectAnimState({ speed: 2.5, grounded: true, verticalSpeed: 0, runThreshold: 2.0 })).toBe('run');
    expect(selectAnimState({ speed: 2.5, grounded: true, verticalSpeed: 0, runThreshold: 4.0 })).toBe('walk');
  });

  it('坐着时优先 sit', () => {
    expect(selectAnimState({ speed: 0, grounded: true, verticalSpeed: 0, sitting: true })).toBe('sit');
  });

  it('坐着但离地 → 仍是空中状态（坐下不该压过跳跃）', () => {
    const s = selectAnimState({ speed: 0, grounded: false, verticalSpeed: 3, sitting: true });
    expect(s).toBe('jump');
  });
});

// ───────────────────────────── 转移规则 ─────────────────────────────

describe('resolveTransition：转移不靠"最后写入者赢"', () => {
  it('高优先级立刻抢断（走 → 跳）', () => {
    expect(resolveTransition('walk', 'jump')).toBe('jump');
  });

  it('低优先级不能抢断正在播的一次性动作（跳 → 走）', () => {
    // 跳跃途中不该被 walk 打断
    expect(resolveTransition('jump', 'walk')).toBe('jump');
  });

  it('空中状态落地后允许切回地面动作', () => {
    expect(resolveTransition('fall', 'idle')).toBe('idle');
    expect(resolveTransition('jump', 'walk')).toBe('jump'); // jump 优先级高，靠 finished 回落
    expect(resolveTransition('fall', 'run')).toBe('run');
  });

  it('同状态不重复切换（避免每帧 reset 导致动画卡在第 0 帧）', () => {
    expect(resolveTransition('walk', 'walk')).toBe('walk');
    expect(resolveTransition('idle', 'idle')).toBe('idle');
  });

  it('run → walk 可以降级（跑累了走路）', () => {
    expect(resolveTransition('run', 'walk')).toBe('walk');
  });
});

describe('fallbackState：一次性动作播完回到哪', () => {
  it('在地面静止 → idle', () => {
    expect(fallbackState(true, 0)).toBe('idle');
  });

  it('在地面走 → walk', () => {
    expect(fallbackState(true, 2.4)).toBe('walk');
  });

  it('在地面跑 → run', () => {
    expect(fallbackState(true, 5)).toBe('run');
  });

  it('离地 → fall（不是 idle，否则会瞬间站住）', () => {
    expect(fallbackState(false, 0)).toBe('fall');
  });
});

// ───────────────────────────── 相位 offset ─────────────────────────────

describe('phaseOffsetFor：确定性相位，避免整齐划一', () => {
  it('返回值在 0..1 区间', () => {
    for (const id of ['a:1', 'a:2', 'p:1', 'prop:3', '', '很长很长的中文名字']) {
      const v = phaseOffsetFor(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('同一 id 每次得到相同相位（确定性，回放/截图可复现）', () => {
    expect(phaseOffsetFor('a:42')).toBe(phaseOffsetFor('a:42'));
    expect(phaseOffsetFor('a:42')).toBe(phaseOffsetFor('a:42'));
  });

  it('不同 id 相位不同（实测 6 个角色互不相同）', () => {
    const ids = ['a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6'];
    const phases = ids.map(phaseOffsetFor);
    expect(new Set(phases).size).toBe(ids.length);
  });

  it('相邻 id 的相位差足够大（不是 0.001 那种看不出差别的）', () => {
    // 实测 a:1..a:6 的相位：0.588 / 0.053 / 0.761 / 0.269 / 0.676 / 0.250
    // 最小两两间隔 0.0186（a:4 与 a:6）。这个量级在 1 秒循环的动作上约 19ms 错位，
    // 肉眼已能看出不同步；要求"两两 > 0.02"会随 id 命名变化而脆断，所以取 0.01 作为下限。
    const phases = ['a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6'].map(phaseOffsetFor);
    for (let i = 0; i < phases.length; i++) {
      for (let j = i + 1; j < phases.length; j++) {
        expect(Math.abs(phases[i]! - phases[j]!)).toBeGreaterThan(0.01);
      }
    }
  });

  it('相位分布覆盖整个 0..1 区间（不是全挤在一角）', () => {
    // 40 个 id 应同时落在下段、中段、上段
    const phases = Array.from({ length: 40 }, (_, i) => phaseOffsetFor(`a:${i}`));
    expect(Math.min(...phases)).toBeLessThan(0.15);
    expect(Math.max(...phases)).toBeGreaterThan(0.85);
    const buckets = [0, 0, 0, 0];
    for (const p of phases) buckets[Math.min(3, Math.floor(p * 4))]! += 1;
    // 四个四分位都应有样本（分布不是偏斜的）
    for (const b of buckets) expect(b).toBeGreaterThan(2);
  });
});

// ───────────────────────────── Animator ─────────────────────────────

describe('AvatarAnimator：绑定与切换', () => {
  const ALL = ['idle', 'walk', 'run', 'jump', 'fall', 'sit', 'emote'];

  it('bind 后初始状态是 idle，且 idle 在播放', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));
    expect(a.state).toBe('idle');
    expect(a.hasClips).toBe(true);
    expect(mixer.actions.get('idle')!.getEffectiveWeight()).toBe(1);
  });

  it('一次性动作用 LoopOnce，循环动作用 LoopRepeat', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));
    expect(mixer.actions.get('jump')!.calls).toContain(`setLoop:${LOOP_ONCE}`);
    expect(mixer.actions.get('idle')!.calls).toContain(`setLoop:${LOOP_REPEAT}`);
    expect(mixer.actions.get('walk')!.calls).toContain(`setLoop:${LOOP_REPEAT}`);
  });

  it('切换时用 crossFadeFrom 且时长 0.2s（不是 fadeOut+fadeIn）', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));
    a.update({ speed: 2.4, grounded: true, verticalSpeed: 0 }, 1 / 60);
    expect(a.state).toBe('walk');
    const walkCalls = mixer.actions.get('walk')!.calls;
    const fade = walkCalls.find((c) => c.startsWith('crossFadeFrom:'));
    expect(fade).toBe(`crossFadeFrom:idle:${CROSSFADE_SECONDS}`);
    // 不该用 fadeOut/fadeIn 组合
    expect(walkCalls.some((c) => c === 'fadeIn')).toBe(false);
  });

  it('idle → walk → run → walk → idle 全链路都成功切换', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));

    const seq: Array<[number, string]> = [
      [2.4, 'walk'],
      [5.0, 'run'],
      [2.4, 'walk'],
      [0, 'idle'],
    ];
    for (const [speed, expected] of seq) {
      a.update({ speed, grounded: true, verticalSpeed: 0 }, 1 / 60);
      expect(a.state).toBe(expected);
    }
  });

  it('跳跃：地面 → 空中变 jump，不会停在 walk', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));
    a.update({ speed: 2.4, grounded: true, verticalSpeed: 0 }, 1 / 60);
    expect(a.state).toBe('walk');
    a.update({ speed: 2.4, grounded: false, verticalSpeed: 5.2 }, 1 / 60);
    expect(a.state).toBe('jump');
  });

  it('一次性动作在播时不被普通移动打断', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));
    // 起跳：离地 + 向上
    a.update({ speed: 0, grounded: false, verticalSpeed: 5.2 }, 1 / 60);
    expect(a.state).toBe('jump');
    // 落地后物理说 grounded，但 jump 还在播，不该立刻切 walk
    a.update({ speed: 2.4, grounded: true, verticalSpeed: 0 }, 1 / 60);
    expect(a.state).toBe('jump');
  });

  it('onOneShotFinished 回落到物理状态对应的动作', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));
    a.update({ speed: 0, grounded: false, verticalSpeed: 5.2 }, 1 / 60);
    expect(a.state).toBe('jump');
    a.onOneShotFinished({ speed: 2.4, grounded: true, verticalSpeed: 0 });
    expect(a.state).toBe('walk');
  });

  it('资产缺某个 clip 时不崩、也不切到空动作（保持当前）', () => {
    // 只有 idle 与 walk 的精简资产
    const mixer = makeMixer(['idle', 'walk']);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(['idle', 'walk']));
    // availableStates 返回**状态**（按优先级序），不是 clip 名
    expect(a.availableStates()).toEqual(['walk', 'idle']);
    expect(a.availableClips()).toEqual(['idle', 'walk']);
    // 想跑但没有 run clip：应保持 walk 而不是变成 T-pose
    a.update({ speed: 5.0, grounded: true, verticalSpeed: 0 }, 1 / 60);
    expect(['idle', 'walk']).toContain(a.state);
  });

  it('不认识的 clip 名不映射到任何状态，但仍在 availableClips 里可见', () => {
    const mixer = makeMixer(['idle', 'dance', 'walk']);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(['idle', 'dance', 'walk']));
    // dance 不是 spec §4.1 的状态，不该出现在状态表里
    expect(a.availableStates()).not.toContain('dance' as never);
    expect(a.availableStates()).toEqual(['walk', 'idle']);
    // 但它确实是资产的一部分，诊断时应该看得见
    expect(a.availableClips()).toContain('dance');
  });

  it('资产缺 run 时通过 alias 借用 walk（不能 T-pose）', () => {
    // 真实资产没有 run：只有 idle/walk/jump/jump_down/sit/agree/bow/afraid
    const assetClips = ['idle', 'walk', 'jump', 'jump_down', 'sit', 'agree', 'bow', 'afraid'];
    const mixer = makeMixer(assetClips);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(assetClips), { run: 'walk', fall: 'jump_down', emote: 'agree' });

    // run 应该可用了（借 walk）
    expect(a.availableStates()).toContain('run');
    // 请求 run 时能切过去
    a.update({ speed: 5.0, grounded: true, verticalSpeed: 0 }, 1 / 60);
    expect(a.state).toBe('run');
  });

  it('资产缺 fall 时通过 alias 借用 jump_down', () => {
    const assetClips = ['idle', 'walk', 'jump', 'jump_down'];
    const mixer = makeMixer(assetClips);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(assetClips), { run: 'walk', fall: 'jump_down' });
    a.update({ speed: 0, grounded: false, verticalSpeed: -5 }, 1 / 60);
    expect(a.state).toBe('fall');
  });

  it('没有 alias 且资产缺 clip 时保持当前（不崩、不 T-pose）', () => {
    const mixer = makeMixer(['idle', 'walk']);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(['idle', 'walk'])); // 不传 alias
    expect(a.availableStates()).toEqual(['walk', 'idle']);
    a.update({ speed: 5.0, grounded: true, verticalSpeed: 0 }, 1 / 60);
    expect(['idle', 'walk']).toContain(a.state);
  });

  it('phaseOffset 落在 mixer 时间轴上（相位真的生效）', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1', 0.5);
    a.bind(asMixer(mixer), makeClips(ALL, 2)); // duration 2
    // offset 0.5 × duration 2 = 1 秒
    expect(mixer.time).toBeCloseTo(1, 6);
  });

  it('两个角色的相位不同（同一动作不同步）', () => {
    const m1 = makeMixer(ALL);
    const m2 = makeMixer(ALL);
    const a1 = new AvatarAnimator('a:1');
    const a2 = new AvatarAnimator('a:2');
    a1.bind(asMixer(m1), makeClips(ALL, 2));
    a2.bind(asMixer(m2), makeClips(ALL, 2));
    expect(m1.time).not.toBeCloseTo(m2.time, 3);
  });

  it('update 每帧都推进 mixer（动画在跑）', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    a.bind(asMixer(mixer), makeClips(ALL));
    const before = mixer.updateCount();
    a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, 1 / 60);
    a.update({ speed: 0, grounded: true, verticalSpeed: 0 }, 1 / 60);
    expect(mixer.updateCount()).toBe(before + 2);
  });

  it('未 bind 时 update 不崩（资产还没加载完）', () => {
    const a = new AvatarAnimator('a:1');
    expect(() => a.update({ speed: 1, grounded: true, verticalSpeed: 0 }, 1 / 60)).not.toThrow();
    expect(a.hasClips).toBe(false);
  });

  it('bind 后立刻推一帧（否则角色停在 T-pose 绑定姿态）', () => {
    // 这是 lead 在截图里抓到的真 bug：`action.play()` 只是"标记在播"，
    // 真正把 clip 轨道值写进骨骼的是 `mixer.update(dt)`。
    // bind() 返回时如果不推一帧，骨骼还停在 bind pose（双臂平举的 T 字），
    // 要等主循环下一次 update 才会摆成 idle —— 那个窗口期被截图就是 T-pose。
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1');
    const before = mixer.updateCount();
    a.bind(asMixer(mixer), makeClips(ALL));
    // bind 内部必须至少推了一帧
    expect(mixer.updateCount()).toBeGreaterThan(before);
  });

  it('bind 推的那一帧用 dt=0（不推进时间轴，不破坏相位）', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1', 0.5);
    a.bind(asMixer(mixer), makeClips(ALL, 2));
    // 相位是 0.5 × duration 2 = 1 秒；如果 bind 用正 dt 推帧，这里会大于 1
    expect(mixer.time).toBeCloseTo(1, 6);
  });

  it('debug 输出含状态、期望、相位、进度、clip 列表', () => {
    const mixer = makeMixer(ALL);
    const a = new AvatarAnimator('a:1', 0.25);
    a.bind(asMixer(mixer), makeClips(ALL));
    const d = a.debug();
    expect(d.state).toBe('idle');
    expect(d.phaseOffset).toBeCloseTo(0.25, 3);
    expect(d.clips).toEqual(expect.arrayContaining(['idle', 'walk', 'run']));
    expect(d.progress).toBeGreaterThanOrEqual(0);
    expect(d.progress).toBeLessThanOrEqual(1);
  });
});
