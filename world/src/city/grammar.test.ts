import { describe, expect, it } from 'vitest';
import { categoryOf, facadeSpec, seeded } from './facade-grammar';
import { nearestPoi, parsePois } from './poi';

describe('立面语法', () => {
  it('同一栋楼每次结果一致，不同楼有变化', () => {
    const a = facadeSpec({ id: 'way/1:0', height: 24, category: 'urban_village' });
    expect(facadeSpec({ id: 'way/1:0', height: 24, category: 'urban_village' })).toEqual(a);
    const variants = new Set(Array.from({ length: 60 }, (_, i) => facadeSpec({ id: `b${i}`, height: 24, category: 'urban_village' }).windowVariant));
    expect(variants.size).toBeGreaterThan(2);
  });

  it('没有类别字段时按高度推断，与现有立面阈值一致', () => {
    expect(categoryOf({ id: 'x', height: 70 })).toBe('tower');
    expect(categoryOf({ id: 'x', height: 30 })).toBe('office');
    expect(categoryOf({ id: 'x', height: 10 })).toBe('generic');
    expect(categoryOf({ id: 'x', height: 10, category: 'industrial' })).toBe('industrial');
  });

  it('城中村有底商/挂件，塔楼没有空调外机', () => {
    for (let i = 0; i < 30; i++) {
      const village = facadeSpec({ id: `v${i}`, height: 21, category: 'urban_village' });
      expect(village.floorHeight).toBeGreaterThanOrEqual(2.8);
      expect(village.attachments.ac).toBeGreaterThan(0);
      expect(facadeSpec({ id: `t${i}`, height: 200, category: 'tower' }).attachments.ac).toBe(0);
    }
  });

  it('seeded 序列落在 [0,1)', () => {
    const r = seeded(1);
    for (let i = 0; i < 200; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe('互动点', () => {
  it('校验并找半径内最近的点', () => {
    const pois = parsePois([
      { id: 'wheel', kind: 'ride', name: '摩天轮', position: [0, 0, 0], radius: 10, actions: [{ key: 'F', label: '上摩天轮', action: 'ride' }] },
      { id: 'bench', kind: 'seat', name: '长椅', position: [5, 0, 0], radius: 3, actions: [] },
    ]);
    expect(nearestPoi(pois, 4, 0)?.id).toBe('bench');
    expect(nearestPoi(pois, 50, 0)).toBeNull();
  });
  it('拒绝未知类型、重复 id、过大半径', () => {
    const base = { id: 'a', kind: 'seat', name: 'a', position: [0, 0, 0], radius: 1, actions: [] };
    expect(() => parsePois([{ ...base, kind: 'teleport' }])).toThrow(/kind/);
    expect(() => parsePois([base, base])).toThrow(/id/);
    expect(() => parsePois([{ ...base, radius: 500 }])).toThrow(/radius/);
  });
});
