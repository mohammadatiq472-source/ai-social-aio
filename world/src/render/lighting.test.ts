import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  LIGHTING_PRESETS,
  PRESET_KEYS,
  DEFAULT_PRESET,
  resolvePresetKey,
  blendPreset,
  advanceTransition,
  smoothstep,
  TRANSITION_SECONDS,
  type BlendableColor,
} from './lighting';

/** 用真实的 three Color 做插值（与运行时同一套色彩空间逻辑）。 */
const makeColor = (hex: number): BlendableColor => new THREE.Color(hex);

describe('光照预设：数据完整性', () => {
  it('至少有白天/黄昏/夜晚/暴雨四个预设', () => {
    expect(PRESET_KEYS.length).toBeGreaterThanOrEqual(4);
    for (const k of ['day', 'dusk', 'night', 'storm']) {
      expect(PRESET_KEYS).toContain(k);
    }
  });

  it('每个预设的字段都齐全（防止漏改某一项导致残留）', () => {
    const required = ['label', 'sun', 'hemi', 'rim', 'background', 'fog', 'envIntensity', 'exposure', 'rain'];
    for (const [key, p] of Object.entries(LIGHTING_PRESETS)) {
      for (const f of required) {
        expect(p, `${key} 缺字段 ${f}`).toHaveProperty(f);
      }
      // 嵌套字段也要齐
      expect(p.sun).toHaveProperty('color');
      expect(p.sun).toHaveProperty('intensity');
      expect(p.sun).toHaveProperty('position');
      expect(p.hemi).toHaveProperty('sky');
      expect(p.hemi).toHaveProperty('ground');
      expect(p.hemi).toHaveProperty('intensity');
      expect(p.rim).toHaveProperty('color');
      expect(p.rim).toHaveProperty('intensity');
      expect(p.fog).toHaveProperty('color');
      expect(p.fog).toHaveProperty('near');
      expect(p.fog).toHaveProperty('far');
    }
  });

  it('数值都在合理范围（防止手滑写出 100 倍强度）', () => {
    for (const [key, p] of Object.entries(LIGHTING_PRESETS)) {
      expect(p.sun.intensity, `${key}.sun`).toBeGreaterThan(0);
      expect(p.sun.intensity, `${key}.sun`).toBeLessThan(10);
      expect(p.hemi.intensity, `${key}.hemi`).toBeGreaterThan(0);
      expect(p.hemi.intensity, `${key}.hemi`).toBeLessThan(3);
      expect(p.rim.intensity, `${key}.rim`).toBeGreaterThanOrEqual(0);
      expect(p.rim.intensity, `${key}.rim`).toBeLessThan(100);
      expect(p.envIntensity, `${key}.env`).toBeGreaterThanOrEqual(0);
      expect(p.envIntensity, `${key}.env`).toBeLessThanOrEqual(1);
      expect(p.exposure, `${key}.exposure`).toBeGreaterThan(0.5);
      expect(p.exposure, `${key}.exposure`).toBeLessThan(2);
      expect(p.rain, `${key}.rain`).toBeGreaterThanOrEqual(0);
      expect(p.rain, `${key}.rain`).toBeLessThanOrEqual(1);
      // 雾的 far 必须大于 near，否则 three 会渲染成一片纯色
      expect(p.fog.far, `${key}.fog`).toBeGreaterThan(p.fog.near);
    }
  });

  it('只有暴雨预设下雨，其它都不下', () => {
    expect(LIGHTING_PRESETS['storm']!.rain).toBe(1);
    for (const k of ['day', 'dusk', 'night']) {
      expect(LIGHTING_PRESETS[k]!.rain).toBe(0);
    }
  });

  it('夜晚的太阳强度低于白天（否则"夜"不成立）', () => {
    expect(LIGHTING_PRESETS['night']!.sun.intensity).toBeLessThan(
      LIGHTING_PRESETS['day']!.sun.intensity,
    );
  });

  it('夜晚的曝光高于白天（补偿低照度，否则角色看不清）', () => {
    expect(LIGHTING_PRESETS['night']!.exposure).toBeGreaterThan(
      LIGHTING_PRESETS['day']!.exposure,
    );
  });

  it('黄昏的太阳高度低于白天（长阴影是黄昏的关键特征）', () => {
    expect(LIGHTING_PRESETS['dusk']!.sun.position[1]).toBeLessThan(
      LIGHTING_PRESETS['day']!.sun.position[1],
    );
  });

  it('暴雨的雾比白天更近（"看不远"才是雨的观感）', () => {
    expect(LIGHTING_PRESETS['storm']!.fog.far).toBeLessThan(
      LIGHTING_PRESETS['day']!.fog.far,
    );
  });
});

describe('resolvePresetKey：URL 参数解析', () => {
  it('合法 key 原样返回', () => {
    expect(resolvePresetKey('dusk')).toBe('dusk');
    expect(resolvePresetKey('NIGHT')).toBe('night');
    expect(resolvePresetKey('  storm  ')).toBe('storm');
  });

  it('空值回落到默认', () => {
    expect(resolvePresetKey(null)).toBe(DEFAULT_PRESET);
    expect(resolvePresetKey(undefined)).toBe(DEFAULT_PRESET);
    expect(resolvePresetKey('')).toBe(DEFAULT_PRESET);
  });

  it('非法值回落到默认且不抛错（URL 是用户输入，不该炸页面）', () => {
    expect(() => resolvePresetKey('不存在的预设')).not.toThrow();
    expect(resolvePresetKey('不存在的预设')).toBe(DEFAULT_PRESET);
    expect(resolvePresetKey('../../etc/passwd')).toBe(DEFAULT_PRESET);
  });
});

describe('blendPreset：过渡插值', () => {
  const a = LIGHTING_PRESETS['day']!;
  const b = LIGHTING_PRESETS['night']!;

  it('t=0 时等于起点', () => {
    const r = blendPreset(a, b, 0, makeColor);
    expect(r.sun.intensity).toBeCloseTo(a.sun.intensity, 6);
    expect(r.exposure).toBeCloseTo(a.exposure, 6);
    expect(r.envIntensity).toBeCloseTo(a.envIntensity, 6);
  });

  it('t=1 时等于终点', () => {
    const r = blendPreset(a, b, 1, makeColor);
    expect(r.sun.intensity).toBeCloseTo(b.sun.intensity, 6);
    expect(r.exposure).toBeCloseTo(b.exposure, 6);
    expect(r.envIntensity).toBeCloseTo(b.envIntensity, 6);
  });

  it('t=0.5 时标量在中点', () => {
    const r = blendPreset(a, b, 0.5, makeColor);
    expect(r.sun.intensity).toBeCloseTo((a.sun.intensity + b.sun.intensity) / 2, 6);
    expect(r.exposure).toBeCloseTo((a.exposure + b.exposure) / 2, 6);
  });

  it('颜色插值不产生 NaN（sRGB 直接 lerp 会出问题，走 Color 才对）', () => {
    const r = blendPreset(a, b, 0.5, makeColor);
    expect(Number.isFinite(r.sun.color)).toBe(true);
    expect(Number.isFinite(r.background)).toBe(true);
    expect(Number.isFinite(r.fog.color)).toBe(true);
  });

  it('t 超界时被夹到 0..1（防止过渡被异常 dt 推飞）', () => {
    const lo = blendPreset(a, b, -5, makeColor);
    const hi = blendPreset(a, b, 5, makeColor);
    expect(lo.sun.intensity).toBeCloseTo(a.sun.intensity, 6);
    expect(hi.sun.intensity).toBeCloseTo(b.sun.intensity, 6);
  });

  it('太阳位置也是插值的（否则切换时影子会瞬移）', () => {
    const r = blendPreset(a, b, 0.5, makeColor);
    for (let i = 0; i < 3; i++) {
      expect(r.sun.position[i]).toBeCloseTo((a.sun.position[i]! + b.sun.position[i]!) / 2, 6);
    }
  });

  it('label 取更接近的那一端', () => {
    expect(blendPreset(a, b, 0.2, makeColor).label).toBe(a.label);
    expect(blendPreset(a, b, 0.8, makeColor).label).toBe(b.label);
  });
});

describe('过渡推进与缓动', () => {
  it('advanceTransition 按 TRANSITION_SECONDS 推进', () => {
    expect(advanceTransition(0, TRANSITION_SECONDS / 2)).toBeCloseTo(0.5, 6);
    expect(advanceTransition(0, TRANSITION_SECONDS)).toBeCloseTo(1, 6);
  });

  it('推进不会超过 1（防止过冲导致来回抖动）', () => {
    expect(advanceTransition(0.9, 100)).toBe(1);
  });

  it('dt 非法时保持原值（NaN 不该污染过渡状态）', () => {
    expect(advanceTransition(0.3, NaN)).toBe(0.3);
    expect(advanceTransition(0.3, -1)).toBe(0.3);
    expect(advanceTransition(0.3, 0)).toBe(0.3);
  });

  it('smoothstep 在端点精确为 0/1，中点为 0.5', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 6);
  });

  it('smoothstep 单调递增且两端变化慢（这就是"缓动"的含义）', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = smoothstep(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // 端点附近的变化量应小于中点附近
    const nearEnd = smoothstep(0.1) - smoothstep(0);
    const nearMid = smoothstep(0.55) - smoothstep(0.45);
    expect(nearMid).toBeGreaterThan(nearEnd);
  });
});
