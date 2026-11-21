import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { parseCityData, type CityBuilding } from './data';
import { buildingGeometry, buildingChunks, colliderArrays, roadGeometry } from './geometry';
import { CityScene } from './runtime';
import { bakeTrimesh } from '../physics/bake';
import { PhysicsWorld } from '../physics/engine';
import { CharacterController } from '../physics/character';
import { parseRoom } from '../core/room';

const raw = () => JSON.parse(readFileSync(new URL('../../assets/city/futian.json', import.meta.url), 'utf8'));
const square: CityBuilding = { id: 'fixture', height: 10, heightSource: 'estimate', rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]] };
beforeAll(async () => { await RAPIER.init(); });

describe('福田数据边界', () => {
  it('加载已清理样区，只有一个明确核验地标', () => {
    const data = parseCityData(raw());
    expect(data.buildings.length).toBe(1230);
    expect(data.roads.length).toBe(809);
    const landmarks = data.buildings.filter(b => b.heightSource === 'ctbuh');
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0]!.name).toBe('平安金融中心');
    expect(landmarks[0]!.height).toBe(599.1);
  });
  it.each([-1, 0, Infinity, NaN, 1001])('拒绝无效高度 %s', height => {
    const data = raw(); data.buildings[0].height = height;
    expect(() => parseCityData(data)).toThrow();
  });
  it('拒绝损坏的轮廓、重复ID、危险来源URL', () => {
    let data = raw(); data.buildings[0].rings = [[[0, 0]]];
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.buildings.push(data.buildings[0]);
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.attribution[0].url = 'javascript:alert(1)';
    expect(() => parseCityData(data)).toThrow();
  });
  it('拒绝出生点越界、错误版本和非有限坐标', () => {
    let data = raw(); data.spawn[0] = 2000;
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.version = 2;
    expect(() => parseCityData(data)).toThrow();
    data = raw(); data.buildings[0].rings[0][0][0] = Infinity;
    expect(() => parseCityData(data)).toThrow();
  });
  it('街区地面与可见边界使用同一房间数据', () => {
    const city = new CityScene(parseCityData(raw()));
    expect(parseRoom(city.room).static).toHaveLength(328);
    expect(city.room.static.filter(s => s.mat === 'floor').every(s => s.type === 'box' && s.size[0] <= 128 && s.size[2] <= 128)).toBe(true);
    expect(city.room.spawn[0]).toEqual(city.data.spawn);
  });
});

describe('街区渲染与碰撞同源', () => {
  it('挤出保持 x/z 与正高度方向', () => {
    const geometry = buildingGeometry(square);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.x).toBeCloseTo(0);
    expect(geometry.boundingBox!.max.z).toBeCloseTo(10);
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0);
    expect(geometry.boundingBox!.max.y).toBeCloseTo(10);
    geometry.dispose();
  });
  it('完整样区最多四个建筑draw call，碰撞顶点逐项等于渲染顶点', () => {
    const geometries = buildingChunks(parseCityData(raw()));
    expect(geometries.length).toBeLessThanOrEqual(4);
    for (const geometry of geometries) {
      const { vertices, indices } = colliderArrays(geometry);
      expect(vertices).toEqual(geometry.getAttribute('position').array);
      expect(indices.length % 3).toBe(0);
      expect(geometry.groups).toHaveLength(0);
      expect(geometry.boundingSphere!.radius).toBeGreaterThan(0);
      geometry.dispose();
    }
  });
  it('凹轮廓不会被碰撞包围盒填满', () => {
    const geometry = buildingGeometry({ ...square, rings: [[[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]]] });
    const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const data = colliderArrays(geometry);
    const collider = bakeTrimesh(RAPIER, physics, data.vertices, data.indices);
    expect(collider.castRay(new RAPIER.Ray({ x: 8, y: 20, z: 8 }, { x: 0, y: -1, z: 0 }), 30, true)).toBe(-1);
    expect(collider.castRay(new RAPIER.Ray({ x: 1, y: 20, z: 1 }, { x: 0, y: -1, z: 0 }), 30, true)).toBeCloseTo(10);
    physics.free(); geometry.dispose();
  });
  it('内院孔洞在可见屋顶和碰撞中都保留', () => {
    const geometry = buildingGeometry({ ...square, rings: [...square.rings, [[3, 3], [7, 3], [7, 7], [3, 7]]] });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster(new THREE.Vector3(5, 20, 5), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const data = colliderArrays(geometry);
    const collider = bakeTrimesh(RAPIER, physics, data.vertices, data.indices);
    expect(collider.castRay(new RAPIER.Ray({ x: 5, y: 20, z: 5 }, { x: 0, y: -1, z: 0 }), 30, true)).toBe(-1);
    physics.free(); geometry.dispose(); mesh.material.dispose();
  });
  it('真角色冲向楼墙会停住且能沿墙滑行', async () => {
    const pw = await PhysicsWorld.create(RAPIER, parseRoom({ name: 'test', spawn: [[0, 0, 0]], lights: [], props: [], seats: [], static: [{ type: 'box', pos: [0, -0.1, 0], size: [60, 0.2, 60] }] }), { propPoolSize: 0 });
    const geometry = buildingGeometry(square);
    const data = colliderArrays(geometry);
    bakeTrimesh(RAPIER, pw.world, data.vertices, data.indices);
    const character = new CharacterController(RAPIER, pw, -3, 0.9, 5);
    for (let i = 0; i < 150; i++) {
      character.update({ dirX: 1, dirZ: 0, run: true, jump: false }); pw.step();
    }
    let position = { x: 0, y: 0, z: 0 };
    character.writeTransform(t => { position = { x: t.p[0], y: t.p[1], z: t.p[2] }; });
    expect(position.x).toBeLessThan(-0.25);
    expect(position.x).toBeGreaterThan(-0.6);
    const before = position.z;
    for (let i = 0; i < 30; i++) {
      character.update({ dirX: 1, dirZ: 1, run: false, jump: false }); pw.step();
    }
    character.writeTransform(t => { position = { x: t.p[0], y: t.p[1], z: t.p[2] }; });
    expect(position.z).toBeGreaterThan(before + 0.4);
    expect(position.x).toBeLessThan(-0.25);
    expect(position.y).toBeGreaterThan(0.8);
    pw.dispose(); geometry.dispose();
  });
  it('真实福田出生点冲向地标墙不下沉', async () => {
    const data = parseCityData(raw());
    const city = new CityScene(data);
    const pw = await PhysicsWorld.create(RAPIER, city.room, { propPoolSize: 0 });
    const geometries = buildingChunks(data);
    for (const geometry of geometries) {
      const arrays = colliderArrays(geometry);
      bakeTrimesh(RAPIER, pw.world, arrays.vertices, arrays.indices);
    }
    const character = new CharacterController(RAPIER, pw, data.spawn[0], 0.9, data.spawn[2]);
    let minY = Infinity;
    let last: unknown;
    for (let i = 0; i < 400; i++) {
      character.update({ dirX: -1, dirZ: 0, run: true, jump: false });
      pw.step();
      character.writeTransform(t => { minY = Math.min(minY, t.p[1]); last = t.p; });
    }
    console.info('city wall contact', { minY, last });
    pw.dispose(); geometries.forEach(g => g.dispose());
    expect(minY).toBeGreaterThan(0.8);
  });
  it('真实角色跨地板块接缝不下沉也不被绊住', async () => {
    const city = new CityScene(parseCityData(raw()));
    const pw = await PhysicsWorld.create(RAPIER, city.room, { propPoolSize: 0 });
    const character = new CharacterController(RAPIER, pw, -353, 0.9, 31);
    let minY = Infinity, x = -353, z = 31;
    for (let i = 0; i < 240; i++) {
      character.update({ dirX: 1, dirZ: 1, run: true, jump: false }); pw.step();
      character.writeTransform(t => { minY = Math.min(minY, t.p[1]); x = t.p[0]; z = t.p[2]; });
    }
    pw.dispose();
    expect(minY).toBeGreaterThan(0.8);
    expect(x).toBeGreaterThan(-343);
    expect(z).toBeGreaterThan(41);
  });
  it('路面法线向上，重复点不制造无效顶点', () => {
    const geometry = roadGeometry([{ id: 'road', walkway: false, width: 6, points: [[0, 0], [0, 0], [10, 0]] }]);
    expect(geometry.getAttribute('position').count).toBe(6);
    expect(geometry.getAttribute('normal').getY(0)).toBeCloseTo(1);
    geometry.dispose();
  });
});
