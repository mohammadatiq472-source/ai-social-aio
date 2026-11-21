import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCityData } from './data';
import { parseCityIndex } from './tiles';

const asset = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../assets/city/${path}`, import.meta.url), 'utf8'));

describe('宝安试点数据', () => {
  it('单 JSON 通过冻结 schema：千余栋、海面在西、无地标', () => {
    const data = parseCityData(asset('baoan-pilot.json'));
    expect(data.buildings.length).toBeGreaterThan(900);
    expect(data.water?.rings.length).toBeGreaterThan(1);
    const sea = data.water?.rings[0] ?? [];
    expect(sea.length).toBeGreaterThan(2);
    expect(Math.min(...sea.map(([x]) => x))).toBeCloseTo(data.bounds[0], 0);
    expect(data.landmarks ?? []).toHaveLength(0);
  });

  it('瓦片索引与瓦片文件一一对应', () => {
    const index = parseCityIndex(asset('baoan-pilot/index.json'));
    const files = readdirSync(new URL('../../assets/city/baoan-pilot/tiles/', import.meta.url))
      .map(name => name.replace(/\.json$/, '')).sort();
    expect(index.tiles.map(tile => tile.id).sort()).toEqual(files);
    expect(index.counts?.buildings).toBe(parseCityData(asset('baoan-pilot.json')).buildings.length);
  });
});
