import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { parseCityData } from './data';
import { buildingGeometry, colliderArrays, facadeChunks } from './geometry';
import { buildStreetKit, STREET_KIT } from './kit';
import { landmarkScale, PING_AN_ID } from './landmark';
import { CITY_LIGHTING, facadeStyle, FACADE_MODULE } from './materials';
import { LIGHTING_PRESETS } from '../render/lighting';
import { CityScene } from './runtime';
import { PhysicsWorld } from '../physics/engine';
import { CharacterController } from '../physics/character';
import { bakeTrimesh } from '../physics/bake';

const raw = () => JSON.parse(readFileSync(new URL('../../assets/city/futian.json', import.meta.url), 'utf8'));
beforeAll(async () => { await RAPIER.init(); });

describe('程序化样板街零件契约', () => {
  it('地标收分单调且顶高不变', () => {
    expect(landmarkScale(0)).toBe(1);
    expect(landmarkScale(599.1)).toBeCloseTo(0.025);
    for (let y = 1; y <= 599; y++) expect(landmarkScale(y)).toBeLessThanOrEqual(landmarkScale(y - 1));
    const tower = parseCityData(raw()).buildings.find(b => b.id === PING_AN_ID)!;
    const geometry = buildingGeometry(tower);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.y).toBeCloseTo(599.1, 3);
    expect(geometry.boundingBox!.min.x).toBeCloseTo(Math.min(...tower.rings[0]!.map(p => p[0])), 3);
    geometry.dispose();
  });
  it('玻璃、办公、石材模板按可复现规则选择', () => {
    const b = parseCityData(raw()).buildings[0]!;
    expect(facadeStyle({ ...b, id: 'fixture', height: 100 })).toBe('glass');
    expect(facadeStyle({ ...b, id: 'fixture', height: 40 })).toBe('office');
    expect(facadeStyle({ ...b, id: 'fixture', height: 10 })).toBe('stone');
    expect(FACADE_MODULE).toEqual({ width: 3.2, height: 3.8, textureSize: 512, columns: 4, rows: 6 });
  });
  it('最多十二批立面，共享带颜色与米制UV的几何', () => {
    const chunks = facadeChunks(parseCityData(raw()));
    expect(chunks.length).toBeLessThanOrEqual(12);
    expect(new Set(chunks.map(c => c.style)).size).toBe(3);
    for (const { geometry } of chunks) {
      expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count);
      expect(geometry.getAttribute('uv').count).toBe(geometry.getAttribute('position').count);
      expect(colliderArrays(geometry).vertices).toEqual(geometry.getAttribute('position').array);
      geometry.dispose();
    }
  });
  it('室外预设不会修改原房间预设', () => {
    expect(LIGHTING_PRESETS.day!.background).toBe(0x1a2028);
    expect(CITY_LIGHTING.day!.background).toBe(0xc4d0d8);
    expect(Object.keys(CITY_LIGHTING)).toEqual(Object.keys(LIGHTING_PRESETS));
    expect(CITY_LIGHTING.day).not.toBe(LIGHTING_PRESETS.day);
  });
  it('拒绝损坏的铺装和未知零件类型', () => {
    const data = raw(); data.street.placements[0].kind = 'unknown';
    expect(() => parseCityData(data)).toThrow();
    const other = raw(); other.street.pavingHeight = 2;
    expect(() => parseCityData(other)).toThrow();
  });
  it('零件生成结果有限且标签是明确的示意路名', () => {
    const kit = buildStreetKit(parseCityData(raw()));
    expect(kit.labels.map(l => l.text)).toContain('平安金融中心');
    expect(STREET_KIT.tree.crownHeight - STREET_KIT.tree.crownRadius * .78).toBeGreaterThan(2);
    for (const geometry of [kit.paving, kit.solids, kit.lamps]) {
      expect([...geometry.getAttribute('position').array].every(Number.isFinite)).toBe(true);
      expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
      geometry.dispose();
    }
  });
  it('长椅座面与树干使用真实零件碰撞', () => {
    const data = parseCityData(raw()), kit = buildStreetKit(data);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const arrays = colliderArrays(kit.solids);
    const collider = bakeTrimesh(RAPIER, world, arrays.vertices, arrays.indices);
    const bench = data.street.placements.find(p => p.kind === 'bench')!;
    const tree = data.street.placements.find(p => p.kind === 'tree')!;
    const benchHit = collider.castRay(new RAPIER.Ray({ x: bench.x, y: data.street.pavingHeight + STREET_KIT.bench.seatHeight, z: bench.z + 2 }, { x: 0, y: 0, z: -1 }), 3, true);
    const treeHit = collider.castRay(new RAPIER.Ray({ x: tree.x + 2, y: 1.5, z: tree.z }, { x: -1, y: 0, z: 0 }), 3, true);
    expect(benchHit).toBeGreaterThan(0);
    expect(benchHit).toBeLessThan(2);
    expect(treeHit).toBeCloseTo(2 - STREET_KIT.tree.trunkRadius, 2);
    world.free(); kit.paving.dispose(); kit.solids.dispose(); kit.lamps.dispose();
  });
  it('完整样板街从铺装走到真实楼墙不会下沉', async () => {
    const data = parseCityData(raw()), city = new CityScene(data);
    const pw = await PhysicsWorld.create(RAPIER, city.room, { propPoolSize: 0 });
    const kit = buildStreetKit(data), chunks = facadeChunks(data);
    const geometries = [...chunks.map(c => c.geometry), kit.paving, kit.solids];
    for (const geometry of geometries) {
      const arrays = colliderArrays(geometry);
      bakeTrimesh(RAPIER, pw.world, arrays.vertices, arrays.indices);
    }
    const character = new CharacterController(RAPIER, pw, data.spawn[0], data.spawn[1] + .9, data.spawn[2]);
    let minY = Infinity, x = data.spawn[0];
    for (let i = 0; i < 400; i++) {
      character.update({ dirX: -1, dirZ: 0, run: true, jump: false }); pw.step();
      character.writeTransform(t => { minY = Math.min(minY, t.p[1]); x = t.p[0]; });
    }
    expect(minY).toBeGreaterThan(.84);
    expect(x).toBeLessThan(data.spawn[0] - 15);
    expect(x).toBeGreaterThan(-336);
    pw.dispose(); geometries.forEach(g => g.dispose()); kit.lamps.dispose();
  });
});
