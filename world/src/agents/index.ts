/**
 * `src/agents/` 的**唯一对外入口**（M9 public API）。
 *
 * v0.2 的 HTTP 控制面只允许 import 这个文件，不许直接摸 `queue.ts` / `executor.ts`
 * 的内部结构。这样 v0.2 换传输（HTTP / WS / MCP）时，改动被限制在一层里。
 *
 * ═══════════════ M9 对外 API 签名（v0.1 本地 / v0.2 HTTP）═══════════════
 *
 * ```ts
 * // ── 1. 进场 ──  POST /agent/join {id?, name, tint?}
 * class AgentSystem {
 *   join(opts: {
 *     id?: EntityId; name: string; tint?: string;
 *     spawnIndex?: number; spawnPos?: readonly [number, number, number];
 *   }): AgentRuntime;
 *   leave(id: EntityId): boolean;
 * }
 *
 * // ── 2. 提交意图 ──  POST /agent/:id/intent
 *   submit(id: EntityId, intent: Intent): IntentResult;
 *   submitMany(id: EntityId, intents: readonly Intent[]): IntentResult[];
 *   // IntentResult = { ok: true } | { t: 'failed'; reason: string; intent?: Intent['t'] }
 *
 * // ── 3. 感知 ──  GET /agent/:id/perceive
 *   perceive(id: EntityId, opts?: PerceiveOptions): Perception | null;
 *   // Perception = { self, nearby, bubbles, worldTime, tick }
 *
 * // ── 4. 每 tick 驱动 ──
 *   tick(): void;   // 由 World system / Clock 驱动
 *
 * // ── 5. 失败订阅 ──
 *   onFailure(fn: (e: AgentFailureEvent) => void): () => void;
 * }
 * ```
 *
 * 三条不变量（v0.2 也不许破）：
 * 1. `submit` 满队列返回 `failed(queue_full)`，**绝不**静默丢弃。
 * 2. `perceive` 只读，调用前后世界状态逐字节不变。
 * 3. `tick` 是**唯一**把意图变成位移的路径，且位移只能来自
 *    `CharacterController.snapshot()`——执行器永远不写 transform。
 */

export {
  IntentQueue,
  MAX_PENDING_INTENTS,
  FAIL_REASON,
  fail,
  isOk,
  isFailure,
  type FailReason,
  type QueuedIntent,
  type IntentQueueStats,
} from './queue';

export {
  IntentExecutor,
  idleInput,
  toLocomotionInput,
  describeResult,
  IDLE_INPUT,
  type ControlInput,
  type ExecutorContext,
  type ExecutorHooks,
  type ExecutorOptions,
  type SeatRef,
} from './executor';

export {
  perceive,
  quatToYaw,
  wrapAngle,
  type Perception,
  type PerceivedSelf,
  type PerceivedNearby,
  type PerceivedBubble,
  type PerceiveOptions,
  type PerceptionSource,
} from './perceive';

export {
  AgentSystem,
  type AgentRuntime,
  type AgentSystemDeps,
  type AgentFailureEvent,
} from './system';
