/**
 * 动画状态机（spec §6 M5）。
 *
 * 设计要点，每条都对应一个具体的"踩过"：
 *
 * 1. **优先级 jump > fall > run > walk > idle**。
 *    不是"最后写入者赢"：空中跑步（物理在 fall，动画还在 walk）是最典型的观感 bug。
 *    所以状态由**优先级 + 可用性**决定，而不是由调用顺序决定。
 *
 * 2. **crossfade 0.2s**（spec 明写）。切换时用 `crossFadeFrom`，
 *    而不是 `fadeOut`+`fadeIn` 各写一遍（那样中间会有 0 权重的空档，表现为动作"顿一下"）。
 *
 * 3. **相位 offset**：每个角色一个 0..1 的随机偏移，避免 6 个角色像机器人一样整齐划一。
 *    实现用 `mixer.setTime()` 而不是 `action.time`——后者会被下一次 update 覆盖。
 *
 * 4. **一次性动作（jump/sit/emote）用 LoopOnce**，在 `finished` 事件里回基础态。
 *    不用 setTimeout：那是墙钟，和 mixer 的时间轴不一致，暂停/变速就错位。
 *
 * 这个文件不 import three 的渲染器，只依赖 AnimationMixer/Action 的类型，
 * 所以状态转移逻辑可以在 node 里单测（用假的 mixer）。
 */

import type * as THREE from 'three';

/** spec §4.1 的动画状态名。 */
export type AnimState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'sit' | 'emote';

/**
 * 优先级表。数字越大越优先。
 * 依据 spec §6 M5 第 1 条：jump > fall > run > walk > idle。
 * sit / emote 是"姿态类"，优先级高于移动但低于空中状态
 * （理由：人在跳的时候不该被"坐下"打断，落地后再坐）。
 */
export const ANIM_PRIORITY: Record<AnimState, number> = {
  jump: 100,
  fall: 90,
  run: 70,
  walk: 60,
  idle: 10,
  sit: 40,
  emote: 30,
};

/** spec §6 M5 第 2 条：切换时长 0.2 秒。 */
export const CROSSFADE_SECONDS = 0.2;

/** 一次性动作（播完回基础态）。idle/walk/run 是循环的。 */
export const ONE_SHOT_STATES: ReadonlySet<AnimState> = new Set<AnimState>(['jump', 'sit', 'emote']);

/** 由物理状态 + 输入推导动画状态。纯函数，可单测。 */
export interface MotionInput {
  /** 水平速度大小（m/s）。 */
  speed: number;
  /** 是否在地面。 */
  grounded: boolean;
  /** 垂直速度（m/s），正为上。 */
  verticalSpeed: number;
  /** 是否正在坐下。 */
  sitting?: boolean;
  /** 是否有一次性表情在播。 */
  emoting?: boolean;
  /** 走/跑的分界速度（m/s）。默认 3.0（walk 2.4、run 5.0 之间）。 */
  runThreshold?: number;
  /** 视为移动的最小速度（m/s）。默认 0.15，避免物理微抖导致 idle/walk 闪烁。 */
  moveThreshold?: number;
}

/**
 * 选状态。规则按优先级从高到低判，第一个命中的赢。
 *
 * 为什么"离地就 fall"而不是看 verticalSpeed 正负：
 * 从台阶走下来时 verticalSpeed 可能是负的但确实在空中，
 * 用 grounded 判断才不会出现"在空中播走路"。
 */
export function selectAnimState(input: MotionInput): AnimState {
  const runThreshold = input.runThreshold ?? 3.0;
  const moveThreshold = input.moveThreshold ?? 0.15;

  // 空中优先：起跳（向上）与下落（向下）都压过一切地面动作
  if (!input.grounded) {
    return input.verticalSpeed > 0.5 ? 'jump' : 'fall';
  }

  if (input.sitting) return 'sit';
  if (input.speed >= runThreshold) return 'run';
  if (input.speed >= moveThreshold) return 'walk';
  if (input.emoting) return 'emote';
  return 'idle';
}

/**
 * 在两状态间做选择：高优先级赢，同优先级保持当前（避免同优先级来回抖）。
 * 返回真正应该切到的状态。
 *
 * 判断顺序有讲究（写错过一次）：
 * 1. 一次性动作（jump/sit/emote）**先**判——它必须播完才回落，
 *    否则"落地允许切换"那条会把 jump 直接打断成 walk，表现为起跳动画只播一帧。
 * 2. 再判空中 → 地面（允许落地切换，否则会一直播 fall）。
 * 3. 最后按优先级。
 */
export function resolveTransition(
  current: AnimState,
  desired: AnimState,
  /**
   * 强制释放一次性动作的锁定。
   *
   * 为什么需要：`jump`/`sit` 的优先级高于 `idle`/`walk`，而"一次性动作没播完就保持"
   * 这条规则会把 `jump → idle` 永远挡住。当超时兜底判定"它该结束了"时，
   * 必须让这条规则失效，否则标志清了也切不回去（实测踩过）。
   */
  forceRelease = false,
): AnimState {
  if (current === desired) return current;

  const curP = ANIM_PRIORITY[current];
  const desP = ANIM_PRIORITY[desired];

  const airborne: ReadonlySet<AnimState> = new Set<AnimState>(['jump', 'fall']);

  // 期望更高优先级 → 立刻切（空中状态抢断地面动作走这条）
  if (desP > curP) return desired;

  /**
   * 当前是一次性动作且期望优先级不高于它 → 等它播完（由 onOneShotFinished 驱动）。
   *
   * ⚠ 这条是"跳一次后动画永久卡死"bug 的第二道锁（2026-11-21 修）。
   *
   * 第一道锁是 `oneShotPlaying` 标志（已加超时兜底）。但即使标志清了，
   * 这条规则仍会把 `jump → idle` 挡住：jump 的优先级高于 idle，
   * `curP >= desP` 恒成立，于是永远 return current。
   *
   * 所以调用方必须在"一次性动作已超时"时传 `forceRelease=true`，
   * 让这条规则失效，否则超时兜底白做。
   */
  if (!forceRelease && ONE_SHOT_STATES.has(current) && curP >= desP) return current;

  // 当前在空中、期望在地面 → 允许（fall 落地要能立刻回 idle/walk）
  if (airborne.has(current) && !airborne.has(desired)) return desired;

  return desired;
}

/**
 * 每个角色的相位偏移：0..1。
 *
 * 用确定性哈希而不是 Math.random()：
 * 同一个 id 每次进房拿到同样的相位，回放/截图可复现；
 * 不同 id 之间又足够分散。这比随机更符合"确定性纪律"（spec §2.2 第 5 条）。
 *
 * 为什么用「整数位反转」而不是直接取哈希低位：
 * FNV-1a 对 `a:1`/`a:2` 这种只差末字符的串，低位差异很小（实测相邻差仅 0.018），
 * 6 个角色并排时看起来仍然很齐。把哈希值做一次**位反转**（bit-reverse），
 * 输入的微小变化会被放大到高位，相邻 id 的相位差就能拉开到 0.1 以上。
 */
export function phaseOffsetFor(id: string): number {
  let h = 2166136261; // FNV-1a 32bit
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  // 位反转 32 位：把低位差异扩散到高位
  let x = h >>> 0;
  x = ((x & 0x55555555) << 1) | ((x >>> 1) & 0x55555555);
  x = ((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333);
  x = ((x & 0x0f0f0f0f) << 4) | ((x >>> 4) & 0x0f0f0f0f);
  x = ((x & 0x00ff00ff) << 8) | ((x >>> 8) & 0x00ff00ff);
  x = ((x << 16) | (x >>> 16)) >>> 0;

  return x / 0x100000000;
}

/** 一次性动作播完后的回落状态。 */
export function fallbackState(grounded: boolean, speed: number, runThreshold = 3.0): AnimState {
  if (!grounded) return 'fall';
  if (speed >= runThreshold) return 'run';
  if (speed >= 0.15) return 'walk';
  return 'idle';
}

/** 状态机诊断信息，进 __worldDebug。 */
export interface AnimDebug {
  state: AnimState;
  desired: AnimState;
  phaseOffset: number;
  /** 当前状态的归一化播放进度 0..1（跨状态可比）。 */
  progress: number;
  /** 已注册的 clip 名。 */
  clips: readonly string[];
}

/**
 * 状态机实例。持有 THREE.AnimationMixer，但逻辑部分不依赖渲染。
 *
 * 注意：本类不 import three 的运行时（只有 type import），
 * 单测里传一个假的 mixer 即可验证状态转移。
 */
/**
 * mixer 的最小接口。
 *
 * 返回值写成 `unknown` 而不是 `void`：three 的 `AnimationMixer` 这些方法返回 `this`
 * （链式调用），而单测里的假 mixer 返回 void。用 `unknown` 两种都能接住，
 * 又不会退化成 `any` 把类型检查全关掉。
 */
/**
 * mixer 的最小接口。
 *
 * **为什么直接 Pick three 的真实类型，而不是自己写一遍方法签名**：
 * 自己写会陷入结构递归不兼容 —— three 的 `crossFadeFrom(from: AnimationAction, ...)`
 * 要求完整 `AnimationAction`，而自写的窄接口两边都满足不了对方。
 * 用 Pick 继承真实签名后：
 * - 生产代码传真的 `AnimationMixer` 直接通过，零成本；
 * - 单测里的假 mixer 只需在 helper 里写一次 `as unknown as MixerLike`（诚实标注"这是假货"）。
 */
export type MixerLike = Pick<
  THREE.AnimationMixer,
  'clipAction' | 'update' | 'setTime' | 'stopAllAction'
> & { readonly time: number };

/** action 的最小形状。同理 Pick 真实类型，避免递归不兼容。 */
export type AnimationActionLike = Pick<
  THREE.AnimationAction,
  | 'reset'
  | 'play'
  | 'stop'
  | 'setLoop'
  | 'setEffectiveWeight'
  | 'setEffectiveTimeScale'
  | 'crossFadeFrom'
  | 'getClip'
  | 'getEffectiveWeight'
  | 'isRunning'
> & { time: number; enabled: boolean };

/** three 的 LoopOnce 常量值（避免运行时 import three）。 */
export const LOOP_ONCE = 2200;
export const LOOP_REPEAT = 2201;

export class AvatarAnimator {
  readonly id: string;
  readonly phaseOffset: number;

  private mixer: MixerLike | null = null;
  private actions = new Map<AnimState, AnimationActionLike>();
  /**
   * 所有 clip 的 action，按 **clip 名**索引（不只 7 个状态）。
   *
   * 为什么需要两份：`actions` 是"状态 → action"（含 alias 回落，例如 run→walk），
   * 而表情要按**原始 clip 名**播放（angry_01 / cry / bow 都不是状态名）。
   * 合成一份会让"按 3 号键哭"和"物理说该跑"互相污染。
   */
  private clipActions = new Map<string, AnimationActionLike>();
  /** 当前正在播的一次性表情（播完或被打断时清空）。 */
  private activeOneShot: AnimationActionLike | null = null;

  /** 是否有一次性表情正在播（调试/测试用）。 */
  get oneShotActive(): boolean {
    return this.activeOneShot !== null;
  }
  /** 状态 → 资产 clip 名的回落表（资产缺某个动作时用，例如没有 run 就借 walk）。 */
  private alias: Readonly<Record<string, string>> = {};
  /** 资产提供的原始 clip 名（按传入顺序），用于调试与断言。 */
  private clipOrder: readonly string[] = [];
  private current: AnimState = 'idle';
  private desired: AnimState = 'idle';
  private oneShotPlaying = false;
  /**
   * 一次性动作已播放的时长（秒）。用于超时兜底。
   *
   * 为什么需要：`onOneShotFinished` 依赖 three 的 mixer 'finished' 事件，
   * 那个事件在某些情况下不会触发（被 crossFade 打断、clip 时长异常等）。
   * 只靠回调会让 `oneShotPlaying` 永远为 true，动画永久冻住 —— 这是实测踩过的坑。
   */
  private oneShotElapsed = 0;
  /**
   * 一次性动作的最长播放时长（秒）。超过就强制回落。
   *
   * 取值依据：
   * - 资产里最长的一次性动作（bow / cast_a_spell）约 1~1.5 秒，`jump` 约 1 秒。
   * - 1.2 秒足够覆盖正常播放，又不会让卡死状态持续太久。
   *
   * ⚠ 第一版设成 4 秒，实测用户要等 8.5 秒才看到恢复（SwiftShader 低帧率下
   * frameDt 被限幅到 0.05，累计比真实时间慢一倍）。4 秒 → 1.2 秒后
   * 真实 GPU 上约 1.2 秒恢复，软渲染约 2.5 秒，都可接受。
   *
   * 为什么不更短（比如 0.5 秒）：那会打断正常的长动作（bow 播到一半被切）。
   */
  private oneShotMaxDuration = 1.2;

  constructor(id: string, phaseOffset?: number) {
    this.id = id;
    this.phaseOffset = phaseOffset ?? phaseOffsetFor(id);
  }

  /** 绑定 mixer 与 clip 列表。找不到的 clip 会被跳过（不是所有资产都有全部动作）。 */
  bind(mixer: MixerLike, clips: readonly THREE.AnimationClip[], alias?: Readonly<Record<string, string>>): void {
    this.mixer = mixer;
    this.actions.clear();
    this.clipActions.clear();
    this.alias = alias ?? {};
    this.clipOrder = clips.map((c) => c.name);

    // 先把**所有** clip 建好 action，不按状态名过滤。
    // 为什么：alias 的目标可能是非状态名的 clip（例如 fall → jump_down），
    // 早先按 `name in ANIM_PRIORITY` 过滤会把 jump_down 直接丢掉，导致别名失效。
    const byName = new Map<string, AnimationActionLike>();
    for (const clip of clips) {
      const name = clip.name;
      const action = mixer.clipAction(clip);
      // 一次性动作（jump/sit/emote）用 LoopOnce；其余（含 walk/jump_down）循环
      if (ONE_SHOT_STATES.has(name as AnimState)) {
        action.setLoop(LOOP_ONCE, 1);
      } else {
        action.setLoop(LOOP_REPEAT, Infinity);
      }

      /**
       * ⚠ 关键：`clipAction()` 返回的 action **默认是启用且权重为 1 的**。
       *
       * 这曾经导致一个非常隐蔽的 bug（用户反馈"角色站着什么都不动"）：
       * 7 个动画的权重全部是 1.00，同时作用于同一副骨骼，
       * 姿势互相叠加/抵消，结果是"看起来完全静止"。
       *
       * 实测证据（`__worldDebug.heroPlayingClips()`）：
       *   ["jump:1.00","fall:1.00","run:1.00","walk:1.00","idle:1.00","sit:1.00","emote:1.00"]
       *
       * 为什么走路时看起来正常：走路的骨骼摆动幅度大，即使被其他 6 个动作
       * 稀释也还能看出腿在动。而 idle 的呼吸幅度只有几度，被稀释后就完全看不出来了。
       *
       * 修法：建好之后**立刻把权重归零并停掉**，只让真正要播的那个由 transition() 打开。
       */
      action.setEffectiveWeight(0);
      action.stop();

      byName.set(name, action);
      this.clipActions.set(name, action);
    }

    // 状态 → action。缺的状态用 alias 回落（例如资产没有 run，就借 walk）
    for (const state of Object.keys(ANIM_PRIORITY) as AnimState[]) {
      const direct = byName.get(state);
      if (direct) {
        this.actions.set(state, direct);
        continue;
      }
      const aliasName = this.alias[state];
      const borrowed = aliasName ? byName.get(aliasName) : undefined;
      if (borrowed) this.actions.set(state, borrowed);
    }

    // 相位：把 mixer 整体推到 offset 位置，这样所有 clip 都错开
    // 用 mixer.setTime 而不是 action.time——后者会被下一次 update 覆盖
    const base = this.actions.get('idle');
    if (base) {
      base.reset().play().setEffectiveWeight(1);
      this.current = 'idle';
    }
    this.applyPhase();

    /**
     * ⚠ 立刻推一帧（dt=0），让 idle 的首帧姿态真正作用到骨骼上。
     *
     * 为什么必须有这一步：`action.play()` 只是**标记**"这个动作在播"，
     * 真正把 AnimationClip 的轨道值写进 Bone 的是 `mixer.update(dt)`。
     * 所以 `bind()` 返回时，骨骼还停在**绑定姿态（bind pose = T-pose，双臂平举）**，
     * 要等主循环下一次 `update()` 才会摆成 idle。
     *
     * 那个窗口期如果被截图/录片抓到，就是"角色双臂平举成 T 字"——
     * lead 在 `loco-check.png` 里正好截到了。这不是逻辑错，是时序问题。
     *
     * 用 dt=0 而不是一个小正数：dt=0 只应用当前时刻的姿态、不推进时间，
     * 所以不会破坏相位（相位已经由上面的 applyPhase 设好）。
     */
    this.mixer.update(0);
  }

  /** 把相位偏移落到 mixer 时间轴上。 */
  private applyPhase(): void {
    if (!this.mixer) return;
    const action = this.actions.get(this.current);
    if (!action) return;
    const clip = action.getClip();
    const duration = clip.duration || 1;
    // setTime 会同时推进所有 action 的时间轴，正是我们要的整体相位
    this.mixer.setTime(this.phaseOffset * duration);
  }

  get state(): AnimState {
    return this.current;
  }

  /** 内部状态快照（诊断"一次性动作卡死"用）。 */
  debugOneShot(): {
    playing: boolean;
    elapsed: number;
    max: number;
    current: AnimState;
    desired: AnimState;
  } {
    return {
      playing: this.oneShotPlaying,
      elapsed: this.oneShotElapsed,
      max: this.oneShotMaxDuration,
      current: this.current,
      desired: this.desired,
    };
  }

  /**
   * 当前**实际在播**的动画 clip 名（权重 > 0 的）。
   *
   * 为什么需要它：`state` 是状态机**想要**的状态，`playingClips()` 才是骨骼真正在跑的。
   * 两者不一致就是 bug（比如状态机说 walk，但 walk 的 action 权重是 0）。
   * 排查"角色站着不动"这类问题时，先看这个比看 state 有用。
   *
   * ⚠ 必须同时遍历 `actions`（状态机）**和** `clipActions`（一次性动作）：
   * 第一版只遍历了 `actions`，导致待机轮播明明在播 `fold_arms`，
   * 这个函数却只返回 `idle` —— 诊断工具本身有盲区，差点误判成"轮播没生效"。
   */
  playingClips(): string[] {
    const out: string[] = [];
    const seen = new Set<AnimationActionLike>();
    const collect = (name: string, action: AnimationActionLike): void => {
      if (seen.has(action)) return; // 别名会指向同一个 action，只记一次
      seen.add(action);
      const w = (action as unknown as { getEffectiveWeight?: () => number }).getEffectiveWeight?.() ?? 0;
      if (w > 0.01) out.push(`${name}:${w.toFixed(2)}`);
    };
    for (const [state, action] of this.actions) collect(state, action);
    for (const [name, action] of this.clipActions) collect(name, action);
    return out;
  }

  get hasClips(): boolean {
    return this.actions.size > 0;
  }

  /**
   * 可用的**状态**列表（含别名借来的）。
   * 顺序按 ANIM_PRIORITY 声明序（jump/fall/run/walk/idle/sit/emote），保证可断言。
   */
  availableStates(): AnimState[] {
    const order = Object.keys(ANIM_PRIORITY) as AnimState[];
    return order.filter((s) => this.actions.has(s));
  }

  /** 资产**原始** clip 名（未映射），用于诊断"这个 glb 到底带了什么动作"。 */
  availableClips(): readonly string[] {
    return this.clipOrder;
  }

  /** 资产是否有某个 clip（表情键触发前先判断，避免切到不存在的动作）。 */
  hasClip(name: string): boolean {
    return this.clipOrder.includes(name);
  }

  /**
   * 播放一个指定 clip（表情用，如 angry_01 / cry / bow）。
   *
   * 与 `update()` 的状态机是**两套机制**：
   * - 状态机管 idle/walk/run/jump/fall（由物理状态驱动，连续、可打断）
   * - 这个管一次性表情（由按键触发，播完自动回落）
   *
   * 为什么要分开：表情不在 spec §4.1 的 7 个状态里，
   * 硬塞进状态机会让优先级表变成 15 个状态、且"按 3 号键哭一下"这种
   * 用户意图和"物理状态"混在一起，后面很难维护。
   */
  playOneShot(clipName: string): boolean {
    if (!this.mixer) return false;
    const action = this.clipActions.get(clipName);
    if (!action) return false;

    // 打断当前动作：表情是"立刻看到反应"，不该等当前动作播完
    const from = this.actions.get(this.current);
    action.reset().play().setEffectiveWeight(1);
    if (from && from !== action) {
      action.crossFadeFrom(from as unknown as THREE.AnimationAction, CROSSFADE_SECONDS, false);
    }
    this.oneShotPlaying = true;
    this.oneShotElapsed = 0;
    this.activeOneShot = action;
    return true;
  }

  /**
   * 每帧驱动。返回是否发生了状态切换（便于调试与单测）。
   *
   * dt 用**渲染 dt**（画面帧率），不是物理固定步长：
   * 动画是观感，要跟画面走；物理状态由 selectAnimState 的输入提供。
   */
  update(input: MotionInput, dt: number): boolean {
    if (!this.mixer) return false;

    this.desired = selectAnimState(input);

    /** 本帧是否要强制释放一次性动作（超时兜底时置 true）。 */
    let forceRelease = false;

    /**
     * 一次性动作卡死的修复（2026-11-21，用户实测「跳一下之后动画永久卡住」）。
     *
     * 根因**不是** `oneShotPlaying` 标志（实测它一直是 false），而是
     * `resolveTransition` 里这条规则：
     *   `if (ONE_SHOT_STATES.has(current) && curP >= desP) return current;`
     *
     * `jump` 的优先级是 100（最高），`idle` 是 10。所以 `jump → idle` 永远被这条挡住，
     * 除非有别的路径清掉 current。而唯一清它的路径是 `onOneShotFinished`（依赖 mixer 事件），
     * 那个事件在 `jump` 被 crossFade 到 `fall` 时不会触发。
     *
     * 结果：`current` 永久停在 `jump`，动画冻在最后一帧。
     *
     * 修法：不依赖任何标志，**只要"当前是 ONE_SHOT 且期望不是它"就计时**，
     * 超过 oneShotMaxDuration 强制释放。这样无论标志处于什么状态都能兜底。
     */
    if (ONE_SHOT_STATES.has(this.current) && this.desired !== this.current) {
      this.oneShotElapsed += Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (this.oneShotElapsed >= this.oneShotMaxDuration) {
        forceRelease = true;
        this.oneShotElapsed = 0;
        this.oneShotPlaying = false;
      }
    } else if (!ONE_SHOT_STATES.has(this.current)) {
      // 已经不在一次性动作里，计时器归零
      this.oneShotElapsed = 0;
    } else {
      // 当前是一次性动作且期望就是它 → 还在正常播放，不累加
      this.oneShotElapsed = 0;
    }

    /**
     * 空中动作的即时抢占（与上面的超时兜底是两条独立路径）。
     *
     * 起跳/下落要**立刻**接管，不能等 4 秒超时 —— 那会让跳跃看起来像卡了一下。
     */
    if (this.oneShotPlaying) {
      const airborne = this.desired === 'jump' || this.desired === 'fall';
      if (airborne) {
        this.oneShotPlaying = false;
        this.oneShotElapsed = 0;
      }
    }

    const next = resolveTransition(this.current, this.desired, forceRelease);
    let changed = false;

    if (next !== this.current) {
      this.transition(next);
      changed = true;
    }

    this.mixer.update(dt);
    return changed;
  }

  /** 执行 crossfade。没有目标 clip 时保持当前（不崩，只是不动）。 */
  private transition(next: AnimState): void {
    const to = this.actions.get(next);
    if (!to) {
      // 资产没有这个动作：保持当前状态，避免"切到空动作"导致 T-pose
      this.desired = this.current;
      return;
    }

    const from = this.actions.get(this.current);

    to.reset().play().setEffectiveWeight(1);
    if (from && from !== to) {
      // crossFadeFrom 而不是 fadeOut+fadeIn：后者中间会有 0 权重空档。
      // 转型理由：`AnimationActionLike` 是 `Pick` 出来的窄视图，而 three 的
      // crossFadeFrom 声明要求完整 AnimationAction。运行时拿到的**就是**真的
      // AnimationAction（或单测的假对象），所以这里的收窄是类型系统看不到、但事实成立的。
      to.crossFadeFrom(from as unknown as THREE.AnimationAction, CROSSFADE_SECONDS, false);
    }

    if (ONE_SHOT_STATES.has(next)) {
      this.oneShotPlaying = true;
      this.oneShotElapsed = 0;
    }

    this.current = next;
  }

  /**
   * 一次性动作播完时由外部调用（three 的 mixer 'finished' 事件）。
   * 回落到基础态，而不是停在最后一帧。
   */
  onOneShotFinished(input: MotionInput): void {
    this.oneShotPlaying = false;
    this.oneShotElapsed = 0;
    const fallback = fallbackState(input.grounded, input.speed, input.runThreshold ?? 3.0);
    if (fallback !== this.current) this.transition(fallback);
  }

  debug(): AnimDebug {
    const action = this.actions.get(this.current);
    let progress = 0;
    if (action) {
      const dur = action.getClip().duration || 1;
      progress = ((action.time % dur) + dur) % dur / dur;
    }
    return {
      state: this.current,
      desired: this.desired,
      phaseOffset: Math.round(this.phaseOffset * 1000) / 1000,
      progress: Math.round(progress * 100) / 100,
      // 资产原始 clip 名（不是状态名）：调试时要能看出"这个 glb 到底有什么动作"
      clips: this.clipOrder,
    };
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.actions.clear();
    this.mixer = null;
  }
}
