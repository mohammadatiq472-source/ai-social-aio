import { describe, it, expect } from 'vitest';
import {
  ALL_LAYERS,
  LAYERS,
  LAYER_COLORS,
  eventMask,
  filterMask,
  interactionGroups,
  layerOfGroups,
  layersCollide,
  layersEmitEvents,
  solidMask,
} from './layers';

describe('碰撞层常量', () => {
  it('层号是互不重叠的位', () => {
    for (let i = 0; i < ALL_LAYERS.length; i++) {
      for (let j = i + 1; j < ALL_LAYERS.length; j++) {
        expect(LAYERS[ALL_LAYERS[i]!] & LAYERS[ALL_LAYERS[j]!]).toBe(0);
      }
    }
  });

  it('ALL_LAYERS 覆盖 LAYERS 的全部键且顺序固定', () => {
    expect([...ALL_LAYERS].sort()).toEqual(Object.keys(LAYERS).sort());
    expect(ALL_LAYERS).toEqual(['WORLD_STATIC', 'CHARACTER', 'PROP', 'SENSOR', 'AGENT']);
  });

  it('每层都有调试配色', () => {
    for (const name of ALL_LAYERS) {
      expect(typeof LAYER_COLORS[name]).toBe('number');
    }
  });
});

describe('实心响应矩阵', () => {
  it('角色与静态几何会碰（这条错了角色会掉出地板）', () => {
    expect(layersCollide('CHARACTER', 'WORLD_STATIC')).toBe(true);
  });

  it('角色之间会碰（P10 两角色相撞要互相推开）', () => {
    expect(layersCollide('CHARACTER', 'CHARACTER')).toBe(true);
  });

  it('角色能推箱子（P8）', () => {
    expect(layersCollide('CHARACTER', 'PROP')).toBe(true);
  });

  it('传感器不与任何层产生物理响应', () => {
    for (const name of ALL_LAYERS) {
      expect(layersCollide('SENSOR', name)).toBe(false);
    }
  });

  it('AGENT 层不与 PROP 碰（Agent 推箱会让意图结果不可归因）', () => {
    expect(layersCollide('AGENT', 'PROP')).toBe(false);
  });

  it('静态几何之间不互碰（烘焙后永不移动，互碰只是白费窄相位）', () => {
    expect(layersCollide('WORLD_STATIC', 'WORLD_STATIC')).toBe(false);
  });

  it('碰撞判定必须双向：单向声明在 Rapier 里同样不生效', () => {
    // 矩阵本身是手工维护的，这条守住"两边一致"这个不变量
    for (const a of ALL_LAYERS) {
      for (const b of ALL_LAYERS) {
        expect(layersCollide(a, b)).toBe(layersCollide(b, a));
      }
    }
  });
});

describe('事件响应矩阵', () => {
  it('传感器与角色之间会产生事件', () => {
    expect(layersEmitEvents('SENSOR', 'CHARACTER')).toBe(true);
  });

  it('传感器与 Agent 之间会产生事件', () => {
    expect(layersEmitEvents('SENSOR', 'AGENT')).toBe(true);
  });

  it('传感器不产生物理响应但产生事件——两张表是分开的', () => {
    expect(layersCollide('SENSOR', 'CHARACTER')).toBe(false);
    expect(layersEmitEvents('SENSOR', 'CHARACTER')).toBe(true);
  });

  it('静态几何不产生任何事件', () => {
    for (const name of ALL_LAYERS) {
      expect(layersEmitEvents('WORLD_STATIC', name)).toBe(false);
    }
  });

  it('事件判定同样双向', () => {
    for (const a of ALL_LAYERS) {
      for (const b of ALL_LAYERS) {
        expect(layersEmitEvents(a, b)).toBe(layersEmitEvents(b, a));
      }
    }
  });
});

describe('interactionGroups 组装', () => {
  it('高 16 位是 membership、低 16 位是 filter', () => {
    const g = interactionGroups('CHARACTER');
    expect((g >>> 16) & 0xffff).toBe(LAYERS.CHARACTER);
    expect(g & 0xffff).toBe(filterMask('CHARACTER'));
  });

  it('filter 是实心位与事件位的按位或', () => {
    for (const name of ALL_LAYERS) {
      expect(filterMask(name)).toBe(solidMask(name) | eventMask(name));
    }
  });

  it('可以覆盖 filter', () => {
    const g = interactionGroups('CHARACTER', LAYERS.WORLD_STATIC);
    expect(g & 0xffff).toBe(LAYERS.WORLD_STATIC);
  });

  it('layerOfGroups 能反解回层名（debug draw 按层着色用）', () => {
    for (const name of ALL_LAYERS) {
      expect(layerOfGroups(interactionGroups(name))).toBe(name);
    }
    expect(layerOfGroups(0)).toBeNull();
    expect(layerOfGroups(0x0000ffff)).toBeNull();
  });

  it('传感器的 filter 只含事件位，不含实心位', () => {
    expect(solidMask('SENSOR')).toBe(0);
    expect(filterMask('SENSOR')).toBe(eventMask('SENSOR'));
  });
});
