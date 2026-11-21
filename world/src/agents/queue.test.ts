import { describe, it, expect } from 'vitest';
import { IntentQueue, MAX_PENDING_INTENTS, FAIL_REASON, fail, isFailure, isOk } from './queue';
import type { Intent } from '../core/types';

const MOVE = (x: number, z: number): Intent => ({ t: 'move', to: [x, 0, z] });

describe('IntentQueue 意图队列（spec §4.2：最多 8 条）', () => {
  it('容量默认就是 MAX_PENDING_INTENTS（8），不是另写的数字', () => {
    const q = new IntentQueue();
    expect(q.capacity).toBe(MAX_PENDING_INTENTS);
    expect(MAX_PENDING_INTENTS).toBe(8);
  });

  it('FIFO：入队顺序 == 出队顺序', () => {
    const q = new IntentQueue();
    for (let i = 0; i < 5; i++) q.push(MOVE(i, 0), 0);
    const got: number[] = [];
    for (let i = 0; i < 5; i++) {
      const head = q.shift();
      expect(head).toBeDefined();
      const intent = head!.intent as Extract<Intent, { t: 'move' }>;
      got.push(intent.to[0]);
    }
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });

  it('seq 单调递增且不因出队而重排', () => {
    const q = new IntentQueue();
    q.push(MOVE(1, 0), 0);
    q.push(MOVE(2, 0), 0);
    expect(q.shift()!.seq).toBe(1);
    q.push(MOVE(3, 0), 0);
    expect(q.shift()!.seq).toBe(2);
    expect(q.shift()!.seq).toBe(3);
  });

  it('入队时记的是世界时间（秒），不是墙钟', () => {
    const q = new IntentQueue();
    q.push(MOVE(0, 0), 12.5);
    expect(q.peek()!.enqueuedAt).toBe(12.5);
  });

  it('空队列 shift 返回 undefined（不是失败：没东西可执行是正常状态）', () => {
    const q = new IntentQueue();
    expect(q.shift()).toBeUndefined();
    expect(q.isEmpty).toBe(true);
  });

  // ───────────────── 上限行为：这是本轮必须"明确"的决定 ─────────────────

  it('第 8 条能进，第 9 条被拒并返回 failed(queue_full)', () => {
    const q = new IntentQueue();
    for (let i = 0; i < MAX_PENDING_INTENTS; i++) {
      const r = q.push(MOVE(i, 0), 0);
      expect(isOk(r)).toBe(true);
    }
    expect(q.size).toBe(8);
    expect(q.isFull).toBe(true);

    const r9 = q.push(MOVE(99, 0), 0);
    expect(isFailure(r9)).toBe(true);
    if (isFailure(r9)) {
      // 关键：失败必须带理由，且必须指出是哪类意图
      expect(r9.reason).toBe(FAIL_REASON.QUEUE_FULL);
      expect(r9.intent).toBe('move');
      expect(r9.t).toBe('failed');
    }
    // 拒绝之后队列内容一字未动：最旧的那条仍在队首（不是"丢最旧"策略）
    expect(q.size).toBe(8);
    expect((q.peek()!.intent as Extract<Intent, { t: 'move' }>).to[0]).toBe(0);
  });

  it('拒绝计数可观测（rejected），不是静默丢弃', () => {
    const q = new IntentQueue(2);
    q.push(MOVE(0, 0), 0);
    q.push(MOVE(1, 0), 0);
    q.push(MOVE(2, 0), 0);
    q.push(MOVE(3, 0), 0);
    const s = q.stats();
    expect(s.pushed).toBe(2);
    expect(s.rejected).toBe(2);
    expect(s.pending).toBe(2);
    expect(s.capacity).toBe(2);
  });

  it('出队腾出名额后又能进（上限是"待执行条数"而不是累计条数）', () => {
    const q = new IntentQueue(2);
    q.push(MOVE(0, 0), 0);
    q.push(MOVE(1, 0), 0);
    expect(isFailure(q.push(MOVE(2, 0), 0))).toBe(true);
    q.shift();
    expect(isOk(q.push(MOVE(2, 0), 0))).toBe(true);
    expect(q.size).toBe(2);
  });

  it('remaining 随出入队变化', () => {
    const q = new IntentQueue(3);
    expect(q.remaining).toBe(3);
    q.push(MOVE(0, 0), 0);
    expect(q.remaining).toBe(2);
    q.shift();
    expect(q.remaining).toBe(3);
  });

  // ───────────────── 关闭与清空 ─────────────────

  it('close 之后 push 一律 failed(queue_closed)，并清空待执行', () => {
    const q = new IntentQueue();
    q.push(MOVE(0, 0), 0);
    q.push(MOVE(1, 0), 0);
    q.close();
    expect(q.size).toBe(0);
    const r = q.push(MOVE(2, 0), 0);
    expect(isFailure(r)).toBe(true);
    if (isFailure(r)) expect(r.reason).toBe(FAIL_REASON.QUEUE_CLOSED);
  });

  it('clear 清空但保留统计（事后仍能看历史）', () => {
    const q = new IntentQueue();
    q.push(MOVE(0, 0), 0);
    q.push(MOVE(1, 0), 0);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.stats().pushed).toBe(2);
  });

  // ───────────────── takeMatching（say 旁路车道的底层能力） ─────────────────

  it('takeMatching 只摘走匹配项，剩余保持原顺序', () => {
    const q = new IntentQueue();
    q.push(MOVE(1, 0), 0);
    q.push({ t: 'say', text: 'a' }, 0);
    q.push(MOVE(2, 0), 0);
    q.push({ t: 'say', text: 'b' }, 0);
    q.push({ t: 'wait', ms: 100 }, 0);

    const taken = q.takeMatching((i) => i.t === 'say');
    expect(taken.map((t) => (t.intent as Extract<Intent, { t: 'say' }>).text)).toEqual(['a', 'b']);
    expect(q.snapshot().map((s) => s.intent.t)).toEqual(['move', 'move', 'wait']);
    expect(q.size).toBe(3);
    // 摘走也计入出队（对队列来说确实出去了）
    expect(q.stats().shifted).toBe(2);
  });

  it('takeMatching 无匹配时不动队列、不计数', () => {
    const q = new IntentQueue();
    q.push(MOVE(1, 0), 0);
    const taken = q.takeMatching((i) => i.t === 'say');
    expect(taken).toEqual([]);
    expect(q.size).toBe(1);
    expect(q.stats().shifted).toBe(0);
  });

  // ───────────────── 快照隔离 ─────────────────

  it('snapshot 返回副本：外部改它不影响队列', () => {
    const q = new IntentQueue();
    q.push(MOVE(1, 0), 0);
    const snap = q.snapshot();
    snap.length = 0;
    expect(q.size).toBe(1);
    expect(q.snapshot()).toHaveLength(1);
  });

  it('capacity 非法立刻抛（0 / 负数 / 小数都不行）', () => {
    expect(() => new IntentQueue(0)).toThrow(RangeError);
    expect(() => new IntentQueue(-1)).toThrow(RangeError);
    expect(() => new IntentQueue(1.5)).toThrow(RangeError);
  });

  it('fail() 构造的形状符合协议：{t:"failed", reason, intent?}', () => {
    const f = fail('blocked', { t: 'move', to: [0, 0, 0] });
    expect(f).toEqual({ t: 'failed', reason: 'blocked', intent: 'move' });
    expect(fail('timeout')).toEqual({ t: 'failed', reason: 'timeout' });
  });

  it('isOk / isFailure 互补，且不会把 {ok:true} 判成失败', () => {
    const ok = { ok: true } as const;
    const bad = fail('x');
    expect(isOk(ok)).toBe(true);
    expect(isFailure(ok)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isFailure(bad)).toBe(true);
  });
});
