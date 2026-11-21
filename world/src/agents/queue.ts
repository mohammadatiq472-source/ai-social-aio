/**
 * 意图队列（spec §4.2 / §6 M9 第 1 条）。
 *
 * 这个文件是**纯逻辑**：不 import three / rapier / DOM / World。
 * 它只回答两个问题——「这条意图能不能进队」和「下一条该执行什么」。
 * 真正把意图变成动作的是 `executor.ts`，把动作变成位移的是物理层。
 *
 * ───────────────────── 三条刻意的决定 ─────────────────────
 *
 * 1. **上限 8 条，超了拒绝新的（不是丢最旧的）。**
 *    理由：丢最旧的会让一条**已经发出、Agent 以为会执行**的意图凭空消失。
 *    对 Agent 侧来说这是最难调试的一类故障——它既没成功也没失败，
 *    只能靠"世界没动"去猜。而拒绝新的意图是**可观测**的：调用方立刻拿到
 *    `{t:'failed', reason:'queue_full'}`，可以退避或合并意图后重试。
 *    代价是"突发流量下最新意图被拒"，但 M9 的驱动方是本地脚本/HTTP，
 *    它能对失败立刻反应；而一个已经排队的意图是没有机会反应的。
 *
 * 2. **8 条指的是「待执行」的条数，不含正在执行的那一条。**
 *    正在执行的那条已经离开了队列（`shift()` 出去了），它不是"待执行"。
 *    所以同一时刻最多 8 条排队 + 1 条在飞。
 *
 * 3. **队列自己不做失败上报。**
 *    它没有 World 引用（要保持纯逻辑），失败以 `IntentResult` 返回。
 *    由 `system.ts` 统一转成 `world.reportIntentFailure()`，
 *    这样"失败必须回报"只有**一个**出口，不会出现某条路径悄悄吞掉。
 */

import type { Intent, IntentFailure, IntentResult } from '../core/types';
import { MAX_PENDING_INTENTS } from '../core/types';

export { MAX_PENDING_INTENTS };

/** 失败原因常量。集中在这里，测试与外部 Agent 都能按字符串对账。 */
export const FAIL_REASON = {
  /** 队列满（≥ MAX_PENDING_INTENTS 条待执行）。 */
  QUEUE_FULL: 'queue_full',
  /** 队列已关闭（Agent 已离场）。 */
  QUEUE_CLOSED: 'queue_closed',
  /** 该 id 不在场（还没 join 或已 leave）。 */
  NO_SUCH_AGENT: 'no_such_agent',
  /** 意图字段非法（比如 move 的目标不是有限数）。 */
  INVALID_INTENT: 'invalid_intent',
  /** 目标点不可达：move 的目标落在地面以下/场景外，或 NaN。 */
  UNREACHABLE: 'unreachable',
  /** 被挡住：持续请求移动但位置不再变化。 */
  BLOCKED: 'blocked',
  /** 执行超时：远超"距离 / 速度"的合理耗时。 */
  TIMEOUT: 'timeout',
  /** 座位不存在（sit 的 seat id 找不到）。 */
  NO_SUCH_SEAT: 'no_such_seat',
  /** 需要座位但房间没定义任何座位。 */
  NO_SEATS: 'no_seats',
} as const;

export type FailReason = (typeof FAIL_REASON)[keyof typeof FAIL_REASON];

/** 队列里的一条待执行意图。`seq` 单调递增，便于 Agent 侧对账与去重。 */
export interface QueuedIntent {
  intent: Intent;
  /** 入队时的世界时间（秒）。 */
  enqueuedAt: number;
  /** 全局单调序号（同一队列内唯一）。 */
  seq: number;
}

/** 队列统计（暴露到调试面板 / 验收脚本）。 */
export interface IntentQueueStats {
  /** 累计入队成功数。 */
  pushed: number;
  /** 累计因队列满被拒数。 */
  rejected: number;
  /** 累计出队执行数。 */
  shifted: number;
  /** 当前待执行条数。 */
  pending: number;
  /** 上限。 */
  capacity: number;
}

/**
 * 意图队列。FIFO，固定上限。
 *
 * 实现用普通数组 + `shift()`：容量只有 8，`shift()` 的 O(n) 是 8 次指针移动，
 * 比环形缓冲区的取模分支更便宜也更好读。**不要**因为"数组 shift 慢"就改成
 * 环形缓冲区——这里的 n 是 8，不是 8000。
 */
export class IntentQueue {
  readonly capacity: number;

  private items: QueuedIntent[] = [];
  private seqCounter = 0;
  private closed = false;

  private pushedCount = 0;
  private rejectedCount = 0;
  private shiftedCount = 0;

  constructor(capacity: number = MAX_PENDING_INTENTS) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`IntentQueue: capacity 必须是 ≥1 的整数，收到 ${capacity}`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length;
  }

  get isFull(): boolean {
    return this.items.length >= this.capacity;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 还能再放几条。 */
  get remaining(): number {
    return Math.max(0, this.capacity - this.items.length);
  }

  /**
   * 入队。满则**拒绝新意图**并返回失败（理由见文件头第 1 条）。
   *
   * 注意返回值是 `IntentResult` 而不是 boolean：
   * 布尔值会丢掉"为什么失败"，而调用方（HTTP 层 / 脚本）需要这个理由去退避。
   */
  push(intent: Intent, now: number): IntentResult {
    if (this.closed) return fail(FAIL_REASON.QUEUE_CLOSED, intent);
    if (this.isFull) {
      this.rejectedCount += 1;
      return fail(FAIL_REASON.QUEUE_FULL, intent);
    }
    this.seqCounter += 1;
    this.items.push({ intent, enqueuedAt: now, seq: this.seqCounter });
    this.pushedCount += 1;
    return { ok: true };
  }

  /** 看队首但不取走。 */
  peek(): QueuedIntent | undefined {
    return this.items[0];
  }

  /** 取走队首。空队列返回 undefined（不是失败——没东西可执行是正常状态）。 */
  shift(): QueuedIntent | undefined {
    const head = this.items.shift();
    if (head) this.shiftedCount += 1;
    return head;
  }

  /**
   * 取出所有满足条件的意图（保持它们原来的先后顺序），其余留在队列里。
   *
   * 存在的唯一理由：`say` 走旁路车道（见 executor.ts 文件头 A）——
   * 它要在**不看位置**的情况下把队列里所有 say 立刻执行掉，
   * 而这条路径不能破坏 move 的 FIFO 顺序。所以需要"只摘走 say"。
   *
   * 被摘走的条目计入 `shifted`，因为对队列来说它们确实出队了。
   */
  takeMatching(pred: (intent: Intent) => boolean): QueuedIntent[] {
    const taken: QueuedIntent[] = [];
    const kept: QueuedIntent[] = [];
    for (const q of this.items) {
      if (pred(q.intent)) taken.push(q);
      else kept.push(q);
    }
    if (taken.length === 0) return taken;
    this.items = kept;
    this.shiftedCount += taken.length;
    return taken;
  }

  /** 清空（换房间 / 离场）。计数保留，便于事后看统计。 */
  clear(): void {
    this.items.length = 0;
  }

  /** 关闭：之后所有 push 都返回 queue_closed。离场后不该再接收意图。 */
  close(): void {
    this.closed = true;
    this.items.length = 0;
  }

  /** 待执行意图的快照（只读副本，外部改它不会影响队列）。 */
  snapshot(): QueuedIntent[] {
    return this.items.map((q) => ({ intent: q.intent, enqueuedAt: q.enqueuedAt, seq: q.seq }));
  }

  stats(): IntentQueueStats {
    return {
      pushed: this.pushedCount,
      rejected: this.rejectedCount,
      shifted: this.shiftedCount,
      pending: this.items.length,
      capacity: this.capacity,
    };
  }
}

/** 构造一条失败结果。`intent` 只带类型名，便于对账又不复制整条数据。 */
export function fail(reason: string, intent?: Intent): IntentFailure {
  const out: IntentFailure = { t: 'failed', reason };
  if (intent) out.intent = intent.t;
  return out;
}

/** 类型守卫：把 `IntentResult` 收窄成失败。测试与 HTTP 层都用它。 */
export function isFailure(r: IntentResult): r is IntentFailure {
  return !('ok' in r);
}

/** 类型守卫：成功分支。`{ok:true}` 与 `{t:'failed'}` 没有公共字段，只能靠 `in` 判别。 */
export function isOk(r: IntentResult): r is { ok: true } {
  return 'ok' in r;
}
