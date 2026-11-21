import { describe, it, expect } from 'vitest';
import {
  ANIM_CODES,
  INPUT_BYTES,
  IdTable,
  MAX_SNAPSHOT_ENTITIES,
  MSG,
  PING_BYTES,
  PROTOCOL_VERSION,
  SNAPSHOT_ENTITY_BYTES,
  SNAPSHOT_HEADER_BYTES,
  animToCode,
  codeToAnim,
  decodeHello,
  decodeInput,
  decodePing,
  decodeSnapshot,
  dequantizePhase,
  dequantizeQuatComponent,
  encodeHello,
  encodeInput,
  encodePing,
  encodeSnapshot,
  quantizePhase,
  quantizeQuatComponent,
  snapshotByteLength,
  type SnapshotEntity,
  type SnapshotMsg,
} from './protocol';
import type { AnimName, EntityId } from '../core/types';

// ───────────────────────────── 测试数据生成 ─────────────────────────────

/**
 * 确定性伪随机（mulberry32）。
 *
 * 用固定种子而不是 Math.random：失败时能原样复现那一条数据。
 * 这不是洁癖——协议单测一旦随机失败又无法复现，等于没有这条测试。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把一个「任意实数」投影到**本协议的量化网格**上。
 *
 * 为什么必须这么做：snapshot 的位置是 float32、四元数是 int16、相位是 uint8，
 * 这三步都是有损的。所以「round-trip 完全一致」只在**输入本身已经落在网格上**时成立——
 * 拿任意 double 去要求逐位相等，是在要求 float32 表示所有实数，物理上不可能。
 *
 * 单测里因此分两类：
 * - 网格内数据 → 断言 `toEqual` 逐字段完全一致（spec §6 M7 第 4 条）；
 * - 网格外数据 → 断言误差在量化步长之内（这才是这个编码真正承诺的东西）。
 */
function snapToGrid(e: SnapshotEntity): SnapshotEntity {
  const q = (v: number): number => dequantizeQuatComponent(quantizeQuatComponent(v));
  return {
    id: e.id,
    p: [Math.fround(e.p[0]), Math.fround(e.p[1]), Math.fround(e.p[2])],
    r: [q(e.r[0]), q(e.r[1]), q(e.r[2]), q(e.r[3])],
    anim: e.anim,
    phase: dequantizePhase(quantizePhase(e.phase)),
  };
}

/** 生成一条随机但落在量化网格上的实体记录。 */
function randomEntity(rnd: () => number, id: EntityId): SnapshotEntity {
  // 位置范围取 ±24m（房间尺度），四元数用 yaw 构造（角色只有绕 y 转）
  const yaw = rnd() * Math.PI * 2;
  return snapToGrid({
    id,
    p: [(rnd() - 0.5) * 48, rnd() * 3, (rnd() - 0.5) * 48],
    r: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    anim: ANIM_CODES[Math.floor(rnd() * ANIM_CODES.length)]!,
    phase: rnd(),
  });
}

function tableFor(count: number): { table: IdTable; ids: EntityId[] } {
  const table = new IdTable();
  const ids: EntityId[] = [];
  for (let i = 0; i < count; i++) {
    const id = `a:${i + 1}`;
    table.add(id);
    ids.push(id);
  }
  return { table, ids };
}

// ───────────────────────────── 布局常量 ─────────────────────────────

describe('M7 协议：字节布局与常量', () => {
  it('单条记录 24 字节：2+4*3+2*4+1+1', () => {
    // 这条断言是"改字段顺序忘了改常量"的哨兵
    expect(SNAPSHOT_ENTITY_BYTES).toBe(2 + 4 * 3 + 2 * 4 + 1 + 1);
    expect(SNAPSHOT_ENTITY_BYTES).toBe(24);
  });

  it('头部 6 字节：uint32 seq + uint16 count', () => {
    expect(SNAPSHOT_HEADER_BYTES).toBe(4 + 2);
  });

  it('snapshotByteLength 与 encode 的真实长度一致（0 / 1 / 7 个实体）', () => {
    for (const n of [0, 1, 7]) {
      const { table, ids } = tableFor(n);
      const buf = encodeSnapshot(
        { seq: 1, entities: ids.map((id) => randomEntity(mulberry32(1), id)) },
        table,
      );
      expect(buf.byteLength).toBe(snapshotByteLength(n));
    }
  });

  it('input 29 字节、ping 12 字节', () => {
    expect(INPUT_BYTES).toBe(4 + 4 + 4 + 1 + 16);
    expect(PING_BYTES).toBe(4 + 8);
  });

  it('动画码表与 spec §4.1 的 7 个状态逐字一致，顺序固定', () => {
    expect([...ANIM_CODES]).toEqual(['idle', 'walk', 'run', 'jump', 'fall', 'sit', 'emote']);
    // 顺序即线上编码：idle 必须是 0（未知码回落到它）
    expect(animToCode('idle')).toBe(0);
    expect(codeToAnim(0)).toBe('idle');
  });

  it('消息类型号唯一且覆盖 §4.3 的 6 种', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
    expect(Object.keys(MSG).sort()).toEqual(['EVENT', 'HELLO', 'INPUT', 'PING', 'PONG', 'SNAPSHOT']);
  });
});

// ───────────────────────────── round-trip ─────────────────────────────

describe('M7 snapshot：随机 1000 条 round-trip 完全一致', () => {
  it('1000 个快照逐字段完全相等（网格内数据）', () => {
    const rnd = mulberry32(20261120);
    // 表一次建好：实体数在 0..12 之间变化，下标覆盖 0..11
    const { table, ids } = tableFor(12);

    for (let i = 0; i < 1000; i++) {
      const count = Math.floor(rnd() * 13); // 0..12
      const entities: SnapshotEntity[] = [];
      // 洗牌式取样：用随机下标，允许重复实体（快照里理论上不该重复，但编码器不该因此出错）
      for (let k = 0; k < count; k++) {
        const id = ids[Math.floor(rnd() * ids.length)]!;
        entities.push(randomEntity(rnd, id));
      }
      const msg: SnapshotMsg = { seq: i, entities };

      const decoded = decodeSnapshot(encodeSnapshot(msg, table), table);

      expect(decoded.seq).toBe(msg.seq);
      expect(decoded.entities).toHaveLength(msg.entities.length);
      expect(decoded).toEqual(msg);
    }
  });

  it('seq 跨 uint32 边界与回绕值都原样保留', () => {
    const { table, ids } = tableFor(1);
    const entities = [randomEntity(mulberry32(7), ids[0]!)];
    for (const seq of [0, 1, 0xffff, 0x10000, 0xfffffffe, 0xffffffff]) {
      const out = decodeSnapshot(encodeSnapshot({ seq, entities }, table), table);
      expect(out.seq).toBe(seq);
    }
  });

  it('负数 seq 被按无符号截断（不产生 NaN / 不越界）', () => {
    const { table, ids } = tableFor(1);
    const entities = [randomEntity(mulberry32(8), ids[0]!)];
    const out = decodeSnapshot(encodeSnapshot({ seq: -1, entities }, table), table);
    expect(out.seq).toBe(0xffffffff);
  });

  it('网格外的位置误差不超过 float32 精度、四元数不超过量化步长', () => {
    const { table, ids } = tableFor(1);
    const raw: SnapshotEntity = {
      id: ids[0]!,
      // 这些数在 float32 里都不是精确值
      p: [0.1, 1 / 3, -123.456789],
      r: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.01 - 0.04 - 0.09)],
      anim: 'walk',
      phase: 0.123456,
    };
    const out = decodeSnapshot(encodeSnapshot({ seq: 1, entities: [raw] }, table), table);
    const got = out.entities[0]!;

    for (let i = 0; i < 3; i++) {
      expect(Math.abs(got.p[i]! - raw.p[i]!)).toBeLessThan(1e-5);
    }
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(got.r[i]! - raw.r[i]!)).toBeLessThan(1 / 32767 + 1e-9);
    }
    expect(Math.abs(got.phase - raw.phase)).toBeLessThan(1 / 255);
    expect(got.anim).toBe('walk');
  });
});

// ───────────────────────────── 边界 ─────────────────────────────

describe('M7 snapshot：空快照与最大实体数边界', () => {
  it('空快照只占 6 字节头部，解码出 0 条', () => {
    const { table } = tableFor(0);
    const buf = encodeSnapshot({ seq: 42, entities: [] }, table);
    expect(buf.byteLength).toBe(SNAPSHOT_HEADER_BYTES);

    const out = decodeSnapshot(buf, table);
    expect(out.seq).toBe(42);
    expect(out.entities).toEqual([]);
  });

  it('空快照在 seq=0 时也合法（不是"假快照"）', () => {
    const { table } = tableFor(0);
    const out = decodeSnapshot(encodeSnapshot({ seq: 0, entities: [] }, table), table);
    expect(out).toEqual({ seq: 0, entities: [] });
  });

  it('最大实体数 65535 能编能解，长度 = 6 + 65535×24', () => {
    const n = MAX_SNAPSHOT_ENTITIES;
    const { table, ids } = tableFor(n);
    const rnd = mulberry32(99);
    const entities = ids.map((id) => randomEntity(rnd, id));

    const buf = encodeSnapshot({ seq: 7, entities }, table);
    expect(buf.byteLength).toBe(snapshotByteLength(n));
    expect(buf.byteLength).toBe(SNAPSHOT_HEADER_BYTES + n * SNAPSHOT_ENTITY_BYTES);

    const out = decodeSnapshot(buf, table);
    expect(out.seq).toBe(7);
    expect(out.entities).toHaveLength(n);
    // 抽查首尾：中间的逐字段比对留给上面的 1000 条用例（65535 条全比会拖慢单测）
    expect(out.entities[0]).toEqual(entities[0]);
    expect(out.entities[n - 1]).toEqual(entities[n - 1]);
  });

  it('超过 65535 条直接抛（uint16 count 装不下）', () => {
    const n = MAX_SNAPSHOT_ENTITIES + 1;
    const { table, ids } = tableFor(1);
    const entities = ids.map((id) => randomEntity(mulberry32(1), id));
    // 复用同一个 id 造 n 条：这里测的是 count 上限，不是 id 唯一性
    const many = Array.from({ length: n }, () => entities[0]!);
    expect(() => encodeSnapshot({ seq: 1, entities: many }, table)).toThrow(/超过 uint16 上限/);
  });

  it('映射表超过 65535 个 id 时 add 抛（下标无法用 uint16 表达）', () => {
    const table = new IdTable();
    for (let i = 0; i < MAX_SNAPSHOT_ENTITIES; i++) table.add(`a:${i}`);
    expect(table.size).toBe(MAX_SNAPSHOT_ENTITIES);
    expect(() => table.add('a:overflow')).toThrow(/映射表已满/);
    // 已存在的 id 仍然幂等（不该因为表满而抛）
    expect(table.add('a:0')).toBe(0);
  });
});

// ───────────────────────────── 脏数据 ─────────────────────────────

describe('M7 snapshot：解码对脏数据宽容、对截断严格', () => {
  it('包长不足头部 → 抛（不能越界读）', () => {
    const { table } = tableFor(0);
    expect(() => decodeSnapshot(new ArrayBuffer(5), table)).toThrow(/不足头部/);
  });

  it('声明 3 个实体但只有 1 条的字节 → 抛（传输截断）', () => {
    const { table, ids } = tableFor(3);
    const entities = ids.map((id) => randomEntity(mulberry32(2), id));
    const full = encodeSnapshot({ seq: 1, entities }, table);
    const truncated = full.slice(0, snapshotByteLength(2));
    expect(() => decodeSnapshot(truncated, table)).toThrow(/实收/);
  });

  it('多出来的尾巴字节被忽略（向前兼容：未来追加字段不炸老客户端）', () => {
    const { table, ids } = tableFor(1);
    const entities = [randomEntity(mulberry32(3), ids[0]!)];
    const full = encodeSnapshot({ seq: 5, entities }, table);
    const padded = new Uint8Array(full.byteLength + 8);
    padded.set(new Uint8Array(full), 0);
    const out = decodeSnapshot(padded.buffer, table);
    expect(out.seq).toBe(5);
    expect(out.entities).toHaveLength(1);
  });

  it('未知 idIndex 的那条被跳过，其余照常解出', () => {
    // 编码用 2 个 id 的表，解码用只有 1 个 id 的表
    const enc = tableFor(2);
    const entities = enc.ids.map((id) => randomEntity(mulberry32(4), id));
    const buf = encodeSnapshot({ seq: 9, entities }, enc.table);

    const small = new IdTable();
    small.add(enc.ids[0]!);
    const out = decodeSnapshot(buf, small);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.id).toBe(enc.ids[0]);
  });

  it('未知动画码回落 idle（不是 undefined，也不是抛）', () => {
    expect(codeToAnim(200)).toBe('idle');
    expect(codeToAnim(-1)).toBe('idle');
    expect(codeToAnim(1.5)).toBe('idle');
    // 每个合法码都能往返
    for (const a of ANIM_CODES) expect(codeToAnim(animToCode(a))).toBe(a);
  });

  it('未知动画名编码成 idle 码（宽容，见协议文件头第 3 条）', () => {
    expect(animToCode('dance' as AnimName)).toBe(0);
  });

  it('NaN / Infinity 的四元数分量与相位不产生越界字节', () => {
    // 非有限值统一映射到 0（而不是饱和到满量程）：
    // 满量程意味着"这个分量确实是 1.0"，而 NaN/Infinity 的真实语义是"不知道"。
    // 0 是可辨别的中性值，饱和值会被当成一个合法姿态读进去。
    expect(quantizeQuatComponent(NaN)).toBe(0);
    expect(quantizeQuatComponent(Infinity)).toBe(0);
    expect(quantizeQuatComponent(-Infinity)).toBe(0);
    // 有限的越界值才饱和（那是"值太大"，不是"值未知"）
    expect(quantizeQuatComponent(2)).toBe(32767);
    expect(quantizeQuatComponent(-2)).toBe(-32767);

    expect(quantizePhase(NaN)).toBe(0);
    expect(quantizePhase(5)).toBe(255);
    expect(quantizePhase(-5)).toBe(0);
    expect(dequantizePhase(255)).toBe(1);
    expect(dequantizePhase(0)).toBe(0);
  });
});

// ───────────────────────────── id 映射表 ─────────────────────────────

describe('M7 id 映射表（随 hello 下发）', () => {
  it('add 幂等：同一个 id 反复 add 拿到同一下标，表不变长', () => {
    const t = new IdTable();
    expect(t.add('a:1')).toBe(0);
    expect(t.add('a:2')).toBe(1);
    expect(t.add('a:1')).toBe(0);
    expect(t.size).toBe(2);
  });

  it('indexOf / idAt 双向一致，越界返回 undefined（不抛）', () => {
    const t = new IdTable(['p:1', 'a:2', 'prop:3']);
    expect(t.indexOf('a:2')).toBe(1);
    expect(t.idAt(1)).toBe('a:2');
    expect(t.indexOf('nope')).toBeUndefined();
    expect(t.idAt(3)).toBeUndefined();
    expect(t.idAt(-1)).toBeUndefined();
    expect(t.idAt(1.5)).toBeUndefined();
    expect(t.has('prop:3')).toBe(true);
  });

  it('toArray 保持插入顺序（顺序即下标，排序会错位）', () => {
    const t = new IdTable(['a:3', 'a:1', 'a:2']);
    expect(t.toArray()).toEqual(['a:3', 'a:1', 'a:2']);
    expect(t.idAt(0)).toBe('a:3');
  });

  it('编码时 id 不在表里 → 抛（不静默写下标 0）', () => {
    const t = new IdTable(['a:1']);
    expect(() =>
      encodeSnapshot(
        { seq: 1, entities: [randomEntity(mulberry32(1), 'a:999')] },
        t,
      ),
    ).toThrow(/不在 id 映射表里/);
  });
});

// ───────────────────────────── hello / input / ping ─────────────────────────────

describe('M7 hello（JSON，含 id 映射表）', () => {
  it('往返一致，且带上 idTable', () => {
    const msg = {
      token: 'tok',
      name: '你',
      tint: 'tint-2',
      idTable: ['p:1', 'a:2', 'prop:3'],
    };
    const decoded = decodeHello(encodeHello(msg));
    expect(decoded).toEqual(msg);
  });

  it('tint 可选', () => {
    const decoded = decodeHello(encodeHello({ token: 't', name: 'n', idTable: [] }));
    expect(decoded).toEqual({ token: 't', name: 'n', idTable: [] });
  });

  it('版本不一致返回 null（调用方应断开，而不是尽力继续）', () => {
    const raw = JSON.stringify({ v: PROTOCOL_VERSION + 1, token: 't', name: 'n', idTable: [] });
    expect(decodeHello(raw)).toBeNull();
  });

  it('坏 JSON / 缺字段 / 表不是字符串数组 → null', () => {
    expect(decodeHello('{')).toBeNull();
    expect(decodeHello('null')).toBeNull();
    expect(decodeHello('[]')).toBeNull();
    expect(decodeHello(JSON.stringify({ v: PROTOCOL_VERSION, name: 'n', idTable: [] }))).toBeNull();
    expect(
      decodeHello(JSON.stringify({ v: PROTOCOL_VERSION, token: 't', name: 'n', idTable: [1, 2] })),
    ).toBeNull();
    expect(
      decodeHello(JSON.stringify({ v: PROTOCOL_VERSION, token: 't', name: 'n' })),
    ).toBeNull();
  });

  it('解出的 idTable 能直接喂给 IdTable（端到端：hello → snapshot）', () => {
    const hello = decodeHello(
      encodeHello({ token: 't', name: 'n', idTable: ['p:1', 'a:2'] }),
    )!;
    const table = new IdTable(hello.idTable);
    const entities = [
      randomEntity(mulberry32(11), 'p:1'),
      randomEntity(mulberry32(12), 'a:2'),
    ];
    const out = decodeSnapshot(encodeSnapshot({ seq: 1, entities }, table), table);
    expect(out.entities.map((e) => e.id)).toEqual(['p:1', 'a:2']);
  });
});

describe('M7 input（C→S 30Hz 二进制）', () => {
  it('往返一致（float32 网格内）', () => {
    const msg = {
      tick: 12345,
      moveX: 0.5,
      moveZ: -0.25,
      jump: true,
      look: [0, 0.7071068, 0, 0.7071068] as [number, number, number, number],
    };
    const out = decodeInput(encodeInput(msg));
    expect(out.tick).toBe(12345);
    expect(out.moveX).toBe(0.5);
    expect(out.moveZ).toBe(-0.25);
    expect(out.jump).toBe(true);
    for (let i = 0; i < 4; i++) expect(out.look[i]).toBeCloseTo(msg.look[i]!, 6);
  });

  it('jump=false 与 0 方向', () => {
    const out = decodeInput(
      encodeInput({ tick: 0, moveX: 0, moveZ: 0, jump: false, look: [0, 0, 0, 1] }),
    );
    expect(out.jump).toBe(false);
    expect(out.moveX).toBe(0);
    expect(out.moveZ).toBe(0);
  });

  it('包长不足 → 抛', () => {
    expect(() => decodeInput(new ArrayBuffer(INPUT_BYTES - 1))).toThrow(/不足/);
  });
});

describe('M7 ping/pong（双向 1Hz）', () => {
  it('往返一致，时钟是 float64（不因 uint32 回绕变负）', () => {
    const msg = { nonce: 77, t: 1_700_000_000_123.456 };
    const out = decodePing(encodePing(msg));
    expect(out.nonce).toBe(77);
    expect(out.t).toBe(msg.t);
  });

  it('大时间戳（会话长开）仍精确', () => {
    const t = 4_294_967_296 + 0.5; // 超过 uint32 毫秒
    expect(decodePing(encodePing({ nonce: 1, t })).t).toBe(t);
  });

  it('包长不足 → 抛', () => {
    expect(() => decodePing(new ArrayBuffer(11))).toThrow(/不足/);
  });
});
