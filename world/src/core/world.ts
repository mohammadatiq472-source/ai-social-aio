/**
 * 世界层：实体表 + tick 调度 + 事件总线（spec §3 世界层）。
 *
 * 硬约束：这个文件**不许 import three / rapier / DOM**。
 * 它要能在 node 里裸跑单测，也将来要被房间服务复用（v0.2 服务端权威）。
 *
 * 职责边界：
 * - 这里只存「逻辑真相」：谁存在、什么状态、本 tick 该执行什么系统。
 * - 物理与渲染是**订阅者**：物理读 Intent 产出 Transform，渲染读 Transform 画图。
 * - 不允许渲染层直接写实体表（否则插值/回放会打架）。
 */

import type { ActorState, EntityId, Intent, Transform } from './types';
import { cloneTransform, createTransform } from './types';

/** 系统函数：每 tick 调用一次，按注册顺序执行。 */
export type SystemFn = (world: World, dt: number) => void;

export interface SystemOptions {
  /** 排序权重，小的先跑。物理要早于动画，动画早于渲染同步。 */
  order?: number;
}

interface SystemEntry {
  name: string;
  fn: SystemFn;
  order: number;
  /** 关掉但不移除，便于调试面板临时停用某个系统。 */
  enabled: boolean;
}

// ───────────────────────────── 事件总线 ─────────────────────────────

/**
 * 事件用「结构化联合」而不是 string + any：
 * 渲染层订阅 `actor:spawn` 时能拿到精确类型，不用 as any。
 */
export interface WorldEvents {
  'actor:spawn': { actor: ActorState };
  'actor:despawn': { id: EntityId };
  'actor:update': { id: EntityId; transform: Transform; anim: ActorState['anim']; animPhase: number };
  'actor:say': { id: EntityId; text: string; until: number };
  'actor:intent-failed': { id: EntityId; reason: string };
  'world:reset': Record<string, never>;
}

export type WorldEventName = keyof WorldEvents;
type Handler<K extends WorldEventName> = (payload: WorldEvents[K]) => void;

interface Subscription {
  handler: Handler<WorldEventName>;
  once: boolean;
}

export class EventBus {
  private map = new Map<WorldEventName, Set<Subscription>>();
  private emitting = false;
  /** emit 期间新订阅的延后生效，避免「订阅到本轮已经发过的事件」这种幻觉。 */
  private deferred: Array<() => void> = [];

  on<K extends WorldEventName>(name: K, handler: Handler<K>): () => void {
    const sub: Subscription = { handler: handler as Handler<WorldEventName>, once: false };
    this.add(name, sub);
    return () => this.off(name, sub);
  }

  once<K extends WorldEventName>(name: K, handler: Handler<K>): () => void {
    const sub: Subscription = { handler: handler as Handler<WorldEventName>, once: true };
    this.add(name, sub);
    return () => this.off(name, sub);
  }

  private add(name: WorldEventName, sub: Subscription): void {
    const apply = () => {
      let set = this.map.get(name);
      if (!set) {
        set = new Set();
        this.map.set(name, set);
      }
      set.add(sub);
    };
    if (this.emitting) this.deferred.push(apply);
    else apply();
  }

  private off(name: WorldEventName, sub: Subscription): void {
    this.map.get(name)?.delete(sub);
  }

  emit<K extends WorldEventName>(name: K, payload: WorldEvents[K]): void {
    const set = this.map.get(name);
    if (!set || set.size === 0) return;

    const wasEmitting = this.emitting;
    this.emitting = true;
    try {
      // 复制一份：handler 里退订不能影响本轮遍历
      for (const sub of [...set]) {
        if (!set.has(sub)) continue;
        if (sub.once) set.delete(sub);
        sub.handler(payload);
      }
    } finally {
      this.emitting = wasEmitting;
      if (!wasEmitting) this.flushDeferred();
    }
  }

  private flushDeferred(): void {
    const list = this.deferred;
    this.deferred = [];
    for (const fn of list) fn();
  }

  listenerCount(name: WorldEventName): number {
    return this.map.get(name)?.size ?? 0;
  }

  clear(): void {
    this.map.clear();
    this.deferred = [];
  }
}

// ───────────────────────────── World ─────────────────────────────

export class World {
  readonly events = new EventBus();

  private actors = new Map<EntityId, ActorState>();
  private systems: SystemEntry[] = [];
  private idSeq = 0;
  private tickIndex = 0;
  private time = 0;

  /** 世界已推进的 tick 数（逻辑时间，不是墙钟）。 */
  get tickCount(): number {
    return this.tickIndex;
  }

  /** 世界时间（秒）= tick × 固定步长，由 tick() 累加。 */
  get now(): number {
    return this.time;
  }

  get actorCount(): number {
    return this.actors.size;
  }

  // ── 实体表 ──

  /** 分配一个新 id。序号单调递增，永不复用（复用会让旧引用指到新实体）。 */
  nextId(prefix: 'p' | 'a' | 'prop' = 'a'): EntityId {
    this.idSeq += 1;
    return `${prefix}:${this.idSeq}`;
  }

  has(id: EntityId): boolean {
    return this.actors.has(id);
  }

  /** 只读访问。要改必须走 spawn / updateActor / despawn，这样事件才会发。 */
  getActor(id: EntityId): Readonly<ActorState> | undefined {
    return this.actors.get(id);
  }

  /** 遍历用快照数组：系统里 despawn 不会打断遍历。 */
  listActors(): ActorState[] {
    return [...this.actors.values()];
  }

  actorsOfKind(kind: ActorState['kind']): ActorState[] {
    const out: ActorState[] = [];
    for (const a of this.actors.values()) if (a.kind === kind) out.push(a);
    return out;
  }

  spawn(actor: ActorState): ActorState {
    if (this.actors.has(actor.id)) {
      throw new Error(`World.spawn: 实体 ${actor.id} 已存在（id 不许复用）`);
    }
    // 深拷贝一份，避免调用方后续改自己的对象把世界状态带歪
    const stored: ActorState = {
      ...actor,
      transform: cloneTransform(actor.transform),
      bubble: actor.bubble ? { ...actor.bubble } : undefined,
    };
    this.actors.set(stored.id, stored);
    this.events.emit('actor:spawn', { actor: stored });
    return stored;
  }

  /** 便捷构造：默认 idle、单位旋转、原点。 */
  spawnActor(
    id: EntityId,
    kind: ActorState['kind'],
    name: string,
    transform: Transform = createTransform(),
  ): ActorState {
    return this.spawn({ id, kind, name, transform, anim: 'idle', animPhase: 0 });
  }

  despawn(id: EntityId): boolean {
    const existed = this.actors.delete(id);
    if (existed) this.events.emit('actor:despawn', { id });
    return existed;
  }

  /**
   * 写回物理算出来的 transform / 动画状态。
   * 这是**物理层唯一的出口**：物理不许直接持有 ActorState 引用去改。
   */
  updateActor(
    id: EntityId,
    patch: Partial<Pick<ActorState, 'transform' | 'anim' | 'animPhase' | 'bubble' | 'tint'>>,
  ): boolean {
    const a = this.actors.get(id);
    if (!a) return false;

    if (patch.transform) a.transform = cloneTransform(patch.transform);
    if (patch.anim !== undefined) a.anim = patch.anim;
    if (patch.animPhase !== undefined) a.animPhase = patch.animPhase;
    if (patch.tint !== undefined) a.tint = patch.tint;
    if (patch.bubble !== undefined) a.bubble = { ...patch.bubble };

    if (patch.transform || patch.anim !== undefined || patch.animPhase !== undefined) {
      this.events.emit('actor:update', {
        id,
        transform: a.transform,
        anim: a.anim,
        animPhase: a.animPhase,
      });
    }
    return true;
  }

  /** 说话：写 bubble 并发事件（渲染层据此弹气泡，不用轮询）。 */
  say(id: EntityId, text: string, durationMs = 4000): boolean {
    const a = this.actors.get(id);
    if (!a) return false;
    const until = this.time + durationMs / 1000;
    a.bubble = { text, until };
    this.events.emit('actor:say', { id, text, until });
    return true;
  }

  /** 清掉过期气泡。由系统或渲染层每帧调一次，成本 O(n)。 */
  expireBubbles(): number {
    let n = 0;
    for (const a of this.actors.values()) {
      if (a.bubble && a.bubble.until <= this.time) {
        a.bubble = undefined;
        n += 1;
      }
    }
    return n;
  }

  // ── 意图入口（实际执行在 agents/executor.ts） ──

  /**
   * v0.1 的意图执行器由 agents 模块注册成系统。
   * 这里只保留「失败回报」的出口，让失败有统一通道。
   */
  reportIntentFailure(id: EntityId, reason: string): void {
    this.events.emit('actor:intent-failed', { id, reason });
  }

  /** 提交意图：交给注册的 intent 队列（M9 落地前是个空实现，不静默丢）。 */
  submitIntent(id: EntityId, intent: Intent): boolean {
    if (!this.actors.has(id)) return false;
    const handler = this.intentSink;
    if (!handler) return false;
    return handler(id, intent);
  }

  private intentSink: ((id: EntityId, intent: Intent) => boolean) | null = null;

  /** 由 agents 模块在启动时注入，避免 core 反向依赖 agents。 */
  setIntentSink(sink: (id: EntityId, intent: Intent) => boolean): void {
    this.intentSink = sink;
  }

  // ── tick 调度 ──

  addSystem(name: string, fn: SystemFn, opts: SystemOptions = {}): void {
    if (this.systems.some((s) => s.name === name)) {
      throw new Error(`World.addSystem: 系统名重复 "${name}"`);
    }
    this.systems.push({ name, fn, order: opts.order ?? 0, enabled: true });
    this.systems.sort((a, b) => a.order - b.order);
  }

  setSystemEnabled(name: string, enabled: boolean): void {
    const s = this.systems.find((e) => e.name === name);
    if (s) s.enabled = enabled;
  }

  listSystems(): Array<{ name: string; order: number; enabled: boolean }> {
    return this.systems.map((s) => ({ name: s.name, order: s.order, enabled: s.enabled }));
  }

  /**
   * 推进一个固定步长。dt 必须来自 Clock，**不许**传帧间可变 dt。
   * 抛错时把 tick 停在原地：宁可这帧不推进，也不要带着半更新的状态继续跑。
   *
   * 顺序：系统 → 推进时间 → 清理过期气泡。
   * 为什么 expireBubbles 放在时间推进**之后**：
   * 它比较的是 `bubble.until <= now`。若放在推进前，直到 tick N 开始时 now 还是 (N-1)/60，
   * 一个 until 恰好等于 N/60 的气泡要等到第 N+1 tick 才清——"说 1 秒"实际显示 1.0167 秒，
   * 且这类差一帧的语义会一路传染到渲染层的气泡淡出。
   * 放在之后：tick N 结束时 now = N/60，到期即清。
   * expireBubbles 是幂等的（置 undefined），系统或渲染层重复调也不会清两次出问题。
   */
  tick(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) {
      throw new RangeError(`World.tick: dt 必须是正有限数，收到 ${dt}`);
    }
    for (const s of this.systems) {
      if (s.enabled) s.fn(this, dt);
    }
    this.tickIndex += 1;
    this.time += dt;
    this.expireBubbles();
  }

  /** 换房间：清实体与系统，但保留事件总线的订阅者（渲染层不用重连）。 */
  reset(): void {
    this.actors.clear();
    this.systems = [];
    this.idSeq = 0;
    this.tickIndex = 0;
    this.time = 0;
    this.intentSink = null;
    this.events.emit('world:reset', {});
  }
}
