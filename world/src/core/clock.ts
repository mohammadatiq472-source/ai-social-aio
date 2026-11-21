/**
 * 固定步长累加器（spec §2.2 第 1 条 / M3 第 2 条）。
 *
 * 为什么必须是累加器而不是可变 dt：
 * 物理用可变 dt 喂，帧率一抖结果就变（同样的操作走出不同轨迹），
 * 而且 30fps 时一步要积 1/30 秒的位移，容易穿透。所以物理永远只走 1/60。
 *
 * 三条纪律：
 * 1. 物理只吃 `step()` 吐出的固定 dt，绝不直接吃 `advance()` 的 dt。
 * 2. 单帧最多追 `maxSteps` 步，防止掉帧后的死亡螺旋（一步变慢→追更多步→更慢）。
 * 3. 超出上限的时间**丢弃并记 overrun**，不要攒着——攒着等于把卡顿变成快进。
 */

import { MAX_CATCHUP_STEPS, PHYSICS_DT } from './types';

export interface ClockOptions {
  /** 物理步长，默认 1/60。 */
  fixedDt?: number;
  /** 单帧最多追几步，默认 3。 */
  maxSteps?: number;
  /**
   * 单个 dt 的硬上限（秒），默认 0.25。
   * 切后台回来时 requestAnimationFrame 会给出几秒的 dt，不夹会让累加器爆掉。
   */
  maxFrameDt?: number;
}

export interface ClockStepInfo {
  /** 本次 `advance()` 实际跑了几步。 */
  steps: number;
  /** 剩余未消耗的时间（用于渲染插值 alpha）。 */
  accumulator: number;
  /** 本次是否因为超过 maxSteps 而丢弃了时间。 */
  overrun: boolean;
  /** 累计 overrun 次数，暴露到 __worldDebug。 */
  overruns: number;
  /** 本次被丢弃的时间（秒）。 */
  droppedSeconds: number;
}

export class Clock {
  readonly fixedDt: number;
  readonly maxSteps: number;
  readonly maxFrameDt: number;

  private acc = 0;
  private overrunCount = 0;
  private droppedTotal = 0;
  private elapsed = 0;
  private steps = 0;

  constructor(opts: ClockOptions = {}) {
    const fixedDt = opts.fixedDt ?? PHYSICS_DT;
    if (!(fixedDt > 0)) throw new RangeError(`Clock: fixedDt 必须 > 0，收到 ${fixedDt}`);
    const maxSteps = opts.maxSteps ?? MAX_CATCHUP_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError(`Clock: maxSteps 必须是 ≥1 的整数，收到 ${maxSteps}`);
    }
    this.fixedDt = fixedDt;
    this.maxSteps = maxSteps;
    this.maxFrameDt = opts.maxFrameDt ?? 0.25;
  }

  /** 自时钟创建以来被物理消耗的世界时间（秒）。确定性逻辑只许读这个，不读 Date.now()。 */
  get worldTime(): number {
    return this.elapsed;
  }

  /** 累计推进的物理步数。 */
  get stepCount(): number {
    return this.steps;
  }

  /** 累计 overrun 次数（掉帧丢弃）。 */
  get overruns(): number {
    return this.overrunCount;
  }

  /** 累计被丢弃的时间（秒）。 */
  get droppedSeconds(): number {
    return this.droppedTotal;
  }

  /** 当前累加器余量。 */
  get pending(): number {
    return this.acc;
  }

  /**
   * 渲染插值系数 0..1：物理 60Hz → 画面 60/120Hz 的补间比例。
   * 掉帧丢弃时间时也要在 0..1 内，否则角色会"提前"到未来位置。
   */
  get alpha(): number {
    const a = this.acc / this.fixedDt;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /**
   * 喂一帧的 dt，返回本次应该跑几步。
   * 调用方拿到 `steps` 后自己 for 循环调 `consumeStep()`，或直接用 `runSteps()`。
   */
  advance(frameDt: number): ClockStepInfo {
    let dt = frameDt;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > this.maxFrameDt) dt = this.maxFrameDt;

    this.acc += dt;

    let steps = 0;
    let overrun = false;
    let dropped = 0;

    while (this.acc >= this.fixedDt) {
      if (steps >= this.maxSteps) {
        // 剩余时间丢掉：宁可世界慢一拍，也不要卡顿后突然快进
        overrun = true;
        dropped = this.acc;
        this.acc = 0;
        this.overrunCount += 1;
        this.droppedTotal += dropped;
        break;
      }
      this.acc -= this.fixedDt;
      steps += 1;
    }

    return {
      steps,
      accumulator: this.acc,
      overrun,
      overruns: this.overrunCount,
      droppedSeconds: dropped,
    };
  }

  /** 一个物理步已经执行完，记账（必须和 advance 的步数对上）。 */
  consumeStep(): void {
    this.elapsed += this.fixedDt;
    this.steps += 1;
  }

  /**
   * 一步到位：喂 dt，按固定步长跑 `fn`，自动记账。
   * 返回本次实际跑了几步（0 表示这帧还没到物理步）。
   */
  runSteps(frameDt: number, fn: (fixedDt: number) => void): ClockStepInfo {
    const info = this.advance(frameDt);
    for (let i = 0; i < info.steps; i++) {
      fn(this.fixedDt);
      this.consumeStep();
    }
    return info;
  }

  /** 硬重置（换房间/重开时用）。不重置 overrun 统计会误导调试面板，所以一起清。 */
  reset(): void {
    this.acc = 0;
    this.elapsed = 0;
    this.steps = 0;
    this.overrunCount = 0;
    this.droppedTotal = 0;
  }
}
