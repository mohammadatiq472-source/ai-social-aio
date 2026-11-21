import { describe, it, expect } from 'vitest';
import {
  MATERIALS,
  FALLBACK_MATERIAL,
  materialSpec,
  bucketByMaterial,
  floorOcclusionAt,
  roomBounds,
  buildFloorGeometry,
  mergeSolids,
  actorSourceOf,
  CONTACT_SHADOW_CAPACITY,
  TILE_WORLD_SIZE,
} from './env';
import { roomSolids, parseRoom } from '../core/room';
import { DEMO_ROOM, ROOM_HALF } from '../../rooms/demo-room';

/**
 * 场景环境的**纯逻辑**部分。
 *
 * 需要 WebGL / canvas 的部分（RoomVisual、ContactShadows、程序化贴图）
 * 一律交给浏览器验收（`tools/verify-scene.mjs`），不在 node 里假装渲染
 * —— 这是 vitest.config.ts 已经定好的分工。
 */

describe('材质表', () => {
  it('房间 JSON 用到的每个 mat key 都有定义（否则会静默退化成兜底色）', () => {
    const used = new Set<string>();
    for (const s of DEMO_ROOM.static) if (s.mat) used.add(s.mat);
    for (const p of DEMO_ROOM.props) if (p.mat) used.add(p.mat);

    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      expect(MATERIALS[key], `mat "${key}" 在 MATERIALS 里没有定义`).toBeDefined();
    }
  });

  it('未知 mat key 回落兜底，不抛错（房间是手写 JSON，写错不该炸页面）', () => {
    expect(materialSpec('no-such-mat')).toBe(FALLBACK_MATERIAL);
    expect(materialSpec(undefined)).toBe(FALLBACK_MATERIAL);
  });

  it('墙类材质标了 insideOnly（BackSide），地板/台阶没有', () => {
    expect(MATERIALS['wall']!.insideOnly).toBe(true);
    expect(MATERIALS['trim']!.insideOnly).toBe(true);
    expect(MATERIALS['floor']!.insideOnly).toBeUndefined();
    expect(MATERIALS['stair']!.insideOnly).toBeUndefined();
  });

  it('只有地板标了 tiled（地板走细分 + 顶点色 AO 的单独路径）', () => {
    const tiled = Object.entries(MATERIALS)
      .filter(([, spec]) => spec.tiled)
      .map(([key]) => key);
    expect(tiled).toEqual(['floor']);
  });
});

describe('bucketByMaterial', () => {
  it('同材质合并成一桶，桶数 = 材质种类数', () => {
    const solids = roomSolids(DEMO_ROOM);
    const buckets = bucketByMaterial(solids);

    const keys = buckets.map((b) => b.key).sort();
    // demo 房间用到 floor / wall / trim / stair 四种
    expect(keys).toEqual(['floor', 'stair', 'trim', 'wall']);

    // 每块几何都只出现在一个桶里（不重不漏）
    const total = buckets.reduce((n, b) => n + b.solids.length, 0);
    expect(total).toBe(solids.length);
  });

  it('没有 mat 的块归到 __default__ 桶', () => {
    const buckets = bucketByMaterial([
      { sourceIndex: 0, sourceType: 'box', pos: [0, 0, 0], halfExtents: [1, 1, 1], rot: [0, 0, 0, 1] },
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.key).toBe('__default__');
    expect(buckets[0]!.spec).toBe(FALLBACK_MATERIAL);
  });
});

describe('roomBounds', () => {
  it('从地板推房间半边长（20×20 房间 → 10）', () => {
    expect(roomBounds(roomSolids(DEMO_ROOM)).half).toBeCloseTo(ROOM_HALF, 5);
  });

  it('不被高墙带偏：墙的中心在 y=1.5，不参与水平范围', () => {
    // 若把墙算进来，|z|=10 + 半厚 0.1 = 10.1，会让地板变成 20.2m（差 1%）
    const withWalls = roomBounds(roomSolids(DEMO_ROOM)).half;
    expect(withWalls).toBe(ROOM_HALF);
  });

  it('空房间回落到 10（不返回 0 导致退化几何）', () => {
    expect(roomBounds([]).half).toBe(10);
  });

  it('换一个房间文件，范围跟着变（不是硬编码 10）', () => {
    const small = parseRoom({
      name: 'small',
      spawn: [[0, 0, 0]],
      lights: [],
      static: [{ type: 'box', size: [6, 0.2, 6], pos: [0, -0.1, 0] }],
      props: [],
      seats: [],
    });
    expect(roomBounds(roomSolids(small)).half).toBeCloseTo(3, 5);
  });
});

describe('floorOcclusionAt（墙脚假 AO）', () => {
  it('房间正中不压暗', () => {
    expect(floorOcclusionAt(0, 0, 10, 1.6, 0.5)).toBe(1);
  });

  it('紧贴墙脚最暗，等于 1 - strength', () => {
    expect(floorOcclusionAt(10, 0, 10, 1.6, 0.5)).toBeCloseTo(0.5, 5);
    expect(floorOcclusionAt(0, -10, 10, 1.6, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('超出 reach 之后完全不压暗（不会把整块地板都算成暗的）', () => {
    expect(floorOcclusionAt(10 - 2.0, 0, 10, 1.6, 0.5)).toBe(1);
  });

  it('从墙脚到房间中心单调递增（没有回弹，否则画面上会有暗环）', () => {
    let prev = -Infinity;
    for (let d = 0; d <= 2.0; d += 0.1) {
      const k = floorOcclusionAt(10 - d, 0, 10, 1.6, 0.5);
      expect(k).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = k;
    }
  });

  it('结果始终在 [1-strength, 1] 内（不会被压成负数/过曝）', () => {
    for (let x = -10; x <= 10; x += 0.25) {
      for (let z = -10; z <= 10; z += 0.25) {
        const k = floorOcclusionAt(x, z, 10, 1.6, 0.5);
        expect(k).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect(k).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe('buildFloorGeometry', () => {
  it('顶点数 = (segments+1)²，且带 color 属性', () => {
    const geo = buildFloorGeometry(10, 8);
    const pos = geo.attributes['position']!;
    expect(pos.count).toBe(9 * 9);
    expect(geo.attributes['color']).toBeDefined();
    geo.dispose();
  });

  it('地板是水平的（所有顶点 y 相同），且略高于 0 避免与物理地板 z-fighting', () => {
    const geo = buildFloorGeometry(10, 4);
    const pos = geo.attributes['position']!;
    const ys = new Set<number>();
    for (let i = 0; i < pos.count; i++) ys.add(Math.round(pos.getY(i) * 1000) / 1000);
    expect(ys.size).toBe(1);
    const y = [...ys][0]!;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(0.01);
    geo.dispose();
  });

  it('墙脚顶点比中心顶点暗（顶点色真的写出了 AO）', () => {
    const half = 10;
    const geo = buildFloorGeometry(half, 8);
    const pos = geo.attributes['position']!;
    const col = geo.attributes['color']!;

    let cornerMin = Infinity;
    let centerVal = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const c = col.getX(i);
      if (Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6) centerVal = c;
      if (Math.abs(x) > half - 1e-6 || Math.abs(z) > half - 1e-6) {
        if (c < cornerMin) cornerMin = c;
      }
    }
    expect(centerVal).toBeCloseTo(1, 5);
    expect(cornerMin).toBeLessThan(centerVal);
    geo.dispose();
  });
});

describe('mergeSolids', () => {
  it('合并后顶点/索引数与输入总和一致（不丢三角形）', () => {
    const solids = roomSolids(DEMO_ROOM).filter((s) => s.mat === 'wall');
    const geo = mergeSolids(solids, 0.5);

    // 每个 box = 24 顶点 / 36 索引
    expect(geo.attributes['position']!.count).toBe(solids.length * 24);
    expect(geo.index!.count).toBe(solids.length * 36);

    // 索引不越界（越界会让整个房间几何错乱，是最难查的一类渲染 bug）
    let maxIndex = 0;
    for (let i = 0; i < geo.index!.count; i++) {
      const v = geo.index!.getX(i);
      if (v > maxIndex) maxIndex = v;
    }
    expect(maxIndex).toBeLessThan(geo.attributes['position']!.count);
    geo.dispose();
  });

  it('合并后的几何有包围球（否则视锥剔除会误删整个房间）', () => {
    const geo = mergeSolids(roomSolids(DEMO_ROOM), 1);
    expect(geo.boundingSphere).not.toBeNull();
    expect(geo.boundingSphere!.radius).toBeGreaterThan(0);
    geo.dispose();
  });

  it('空输入得到空几何，不抛错', () => {
    const geo = mergeSolids([], 1);
    expect(geo.attributes['position']!.count).toBe(0);
    geo.dispose();
  });
});

describe('actorSourceOf', () => {
  it('把 World.listActors 原样转成只读数据源', () => {
    const fake = {
      listActors: () => [
        { id: 'p:1', kind: 'human' as const, transform: { p: [1, 2, 3] as const } },
        { id: 'a:2', kind: 'agent' as const, transform: { p: [4, 5, 6] as const } },
      ],
    };
    const src = actorSourceOf(fake as unknown as Parameters<typeof actorSourceOf>[0]);
    const list = src.listActors();
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe('p:1');
    expect(list[1]!.transform.p).toEqual([4, 5, 6]);
  });
});

describe('demo 房间（本轮加墙之后）', () => {
  it('四面墙齐全，且都在房间边界上', () => {
    const walls = DEMO_ROOM.static.filter((s) => s.mat === 'wall');
    expect(walls).toHaveLength(4);

    const xs = walls.map((w) => w.pos[0]).sort((a, b) => a - b);
    const zs = walls.map((w) => w.pos[2]).sort((a, b) => a - b);
    expect(xs).toEqual([-ROOM_HALF, 0, 0, ROOM_HALF]);
    expect(zs).toEqual([-ROOM_HALF, 0, 0, ROOM_HALF]);
  });

  it('有台阶与平台（房间的"纵深"参照物）', () => {
    expect(DEMO_ROOM.static.some((s) => s.type === 'stairs')).toBe(true);
    expect(DEMO_ROOM.static.filter((s) => s.mat === 'stair').length).toBeGreaterThanOrEqual(2);
  });

  it('踢脚线贴着墙内侧，且不穿透地板/墙', () => {
    const trims = DEMO_ROOM.static.filter((s) => s.mat === 'trim');
    expect(trims).toHaveLength(4);
    for (const t of trims) {
      // 踢脚线顶面必须低于墙高，底面必须贴地（>= 0）
      const halfH = (t as { size: [number, number, number] }).size[1] / 2;
      expect(t.pos[1] - halfH).toBeGreaterThanOrEqual(-1e-9);
      expect(t.pos[1] + halfH).toBeLessThan(3);
    }
  });

  it('房间能装下 6 个 Agent 的环 + 巡逻半径（最远 5.6m）', () => {
    // 6 Agent 站在半径 4m 的环上，各自再巡逻 1.6m → 最远 5.6m
    expect(ROOM_HALF).toBeGreaterThan(5.6);
  });

  it('出生点到 +z 墙有足够走廊（verify-locomotion-live 从原点朝 +z 走）', () => {
    // 该脚本走 1s + 跑 1s（≈6.8m），墙在 z=+10，余量要 > 1m
    expect(ROOM_HALF).toBeGreaterThan(7);
  });

  it('两把椅子仍然在原点两侧、出生点够不着（>1.2m）', () => {
    expect(DEMO_ROOM.seats).toHaveLength(2);
    for (const s of DEMO_ROOM.seats) {
      const d = Math.hypot(s.pos[0], s.pos[2]);
      expect(d).toBeGreaterThan(1.2);
    }
  });

  it('箱子仍在原点正前方 1.8m（M10 推箱的验收位置）', () => {
    expect(DEMO_ROOM.props).toHaveLength(2);
    expect(DEMO_ROOM.props[0]!.pos[2]).toBeCloseTo(-1.8, 5);
    expect(DEMO_ROOM.props[0]!.mass).toBe(10);
  });

  it('墙不挡在台阶/平台上（台阶贴墙放，几何不相交）', () => {
    const stair = DEMO_ROOM.static.find((s) => s.type === 'stairs')!;
    // 台阶 x 范围 [pos.x - width/2, pos.x + width/2]
    const width = (stair as { width?: number }).width ?? 1.6;
    const xMin = stair.pos[0] - width / 2;
    const xMax = stair.pos[0] + width / 2;
    // 必须在房间内（左右墙内侧是 ±(ROOM_HALF - 0.1)）
    expect(xMin).toBeGreaterThan(-ROOM_HALF + 0.1);
    expect(xMax).toBeLessThan(ROOM_HALF - 0.1);
  });
});

describe('常量一致性', () => {
  it('接触阴影容量 ≥ spec §8 的同屏角色预算 8', () => {
    expect(CONTACT_SHADOW_CAPACITY).toBeGreaterThanOrEqual(8);
  });

  it('地砖世界尺寸能整除地板边长（否则边缘会出现半块砖）', () => {
    const repeats = (ROOM_HALF * 2) / TILE_WORLD_SIZE;
    expect(Math.abs(repeats - Math.round(repeats))).toBeLessThan(1e-9);
  });
});
