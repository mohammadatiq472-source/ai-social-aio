#!/usr/bin/env node
/**
 * 可选实验工具：烘焙 LOD0/LOD1 二进制瓦片（baked 路径）。
 *
 * **默认运行时不读它**：2026-11-21 实测 5×5/12k 烘焙 LOD0 总 56MB，
 * 而 compact JSON 瓦片只要 3.4MB（17×）。默认格式是 `split_tiles.py` 产出的 v3 JSON 瓦片；
 * 本工具只保留作性能对照/将来"热片预烘"的实验，不对应 assets/city/nanshan 的 v3 index。
 */
/**
 * 离线烘焙 1km 瓦片（决策见 docs/world/决策-城市瓦片与流式加载.md，字节契约见 docs/world/瓦片格式-v2.md）。
 *
 * 为什么用 Node/TS 而不是 Python：瓦片的顶点必须和运行时**同一套几何**。
 * 这里直接 import `src/city/geometry.ts` 的 facadeChunks / roadGeometry / sidewalkGeometry，
 * 渲染和碰撞的顶点因此天然同源，不会出现"Python 烘的和 TS 画的不一样"。
 *
 * 用法：
 *   node --import ./scripts/ts-node-loader.mjs tools/bake-tiles.mjs --scene nanshan
 *   node --import ./scripts/ts-node-loader.mjs tools/bake-tiles.mjs --scene nanshan --check
 *   node --import ./scripts/ts-node-loader.mjs tools/bake-tiles.mjs --scene nanshan --tile 1000
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { facadeChunks, roadGeometry, sidewalkGeometry } from '../src/city/geometry.ts';
import { TILE_TINT_RGB } from '../src/city/materials.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD = resolve(HERE, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  return fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const scene = arg('scene', 'nanshan');
const tileSize = Number(arg('tile', '1000'));
const input = resolve(arg('input', join(WORLD, 'assets/city', `${scene}.json`)));
const outDir = resolve(arg('out', join(WORLD, 'assets/city', scene)));
const check = has('check');

const data = JSON.parse(readFileSync(input, 'utf8'));
const [xmin, zmin, xmax, zmax] = data.bounds;

function centroid(rings) {
  const ring = rings[0];
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}
function tileKey(x, z) {
  return `${Math.floor((x - xmin) / tileSize)}_${Math.floor((z - zmin) / tileSize)}`;
}
function tileBounds(ix, iz) {
  return [xmin + ix * tileSize, zmin + iz * tileSize, xmin + (ix + 1) * tileSize, zmin + (iz + 1) * tileSize];
}
function boundsOf(building) {
  const ring = building.rings[0];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** 几何 → 契约数组。colors 是每顶点的 Uint8 RGB（tint 乘子）。 */
function extract(geometry, { hasUV, color }) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = hasUV ? geometry.getAttribute('uv') : null;
  const count = position.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
    if (normal) {
      normals[i * 3] = normal.getX(i);
      normals[i * 3 + 1] = normal.getY(i);
      normals[i * 3 + 2] = normal.getZ(i);
    }
  }
  const uvs = hasUV ? new Float32Array(count * 2) : null;
  if (uvs && uv) {
    for (let i = 0; i < count; i++) {
      uvs[i * 2] = uv.getX(i);
      uvs[i * 2 + 1] = uv.getY(i);
    }
  }
  let colors = null;
  if (color) {
    colors = new Uint8Array(count * 3);
    const [r, g, b] = TILE_TINT_RGB[color];
    const cr = Math.max(0, Math.min(255, Math.round(r * 255)));
    const cg = Math.max(0, Math.min(255, Math.round(g * 255)));
    const cb = Math.max(0, Math.min(255, Math.round(b * 255)));
    for (let i = 0; i < count; i++) { colors[i * 3] = cr; colors[i * 3 + 1] = cg; colors[i * 3 + 2] = cb; }
  }
  const index = geometry.index;
  const indices = index ? new Uint32Array(index.count) : new Uint32Array(count);
  if (index) {
    for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
  } else {
    for (let i = 0; i < count; i++) indices[i] = i;
  }
  return { positions, normals, uvs, colors, indices, vertices: count, indicesCount: indices.length };
}

function binBytes(payload) {
  const parts = [payload.positions, payload.normals];
  if (payload.uvs) parts.push(payload.uvs);
  if (payload.colors) parts.push(payload.colors);
  parts.push(payload.indices);
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const buffer = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const part of parts) {
    Buffer.from(part.buffer, part.byteOffset, part.byteLength).copy(buffer, offset);
    offset += part.byteLength;
  }
  return buffer;
}

function writeLayer(tileDir, tileId, layer, payload) {
  if (!payload || payload.vertices === 0) return null;
  const file = `tiles/${tileId}.${layer}.bin`;
  writeFileSync(join(outDir, file), binBytes(payload));
  return { file, vertices: payload.vertices, indices: payload.indicesCount, hasUV: !!payload.uvs, colors: !!payload.colors };
}

/** 同一 tile 的多个 tint chunk 合并成一个 style mesh；颜色按 tint 逐顶点写。 */
function mergeStyleChunks(chunks) {
  const byStyle = new Map();
  for (const chunk of chunks) {
    if (!byStyle.has(chunk.style)) byStyle.set(chunk.style, []);
    byStyle.get(chunk.style).push(chunk);
  }
  const out = [];
  for (const [style, list] of byStyle) {
    const merged = [];
    for (const chunk of list) {
      const geometry = chunk.geometry.clone();
      const count = geometry.getAttribute('position').count;
      const colors = new Float32Array(count * 3);
      const [r, g, b] = TILE_TINT_RGB[chunk.tint];
      for (let i = 0; i < count; i++) { colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b; }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      merged.push(geometry);
    }
    const geometry = mergeGeometries(merged, false);
    for (const part of merged) part.dispose();
    if (geometry) {
      out.push({ style, geometry, vertices: geometry.getAttribute('position').count });
    }
  }
  return out;
}

/** LOD1：每栋楼一个盒子，12 三角，顶点色按高度。 */
function lod1Geometry(buildings) {
  const boxes = [];
  for (const building of buildings) {
    const { minX, maxX, minZ, maxZ } = boundsOf(building);
    const h = building.height;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const sx = Math.max(1, maxX - minX), sz = Math.max(1, maxZ - minZ);
    const t = Math.max(0, Math.min(1, (h - 10) / 150));
    const r = 0.62 + 0.10 * t, g = 0.66 + 0.06 * t, b = 0.70 + 0.06 * t;
    const box = new THREE.BoxGeometry(sx, h, sz);
    box.translate(cx, h / 2, cz);
    box.deleteAttribute('uv');
    const count = box.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b; }
    box.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    boxes.push(box);
  }
  const merged = boxes.length ? mergeGeometries(boxes, false) : null;
  for (const box of boxes) box.dispose();
  if (!merged) return { positions: new Float32Array(), normals: new Float32Array(), colors: new Uint8Array(), indices: new Uint32Array(), vertices: 0, indicesCount: 0 };
  const payload = extract(merged, { hasUV: false, color: null });
  const colorAttr = merged.getAttribute('color');
  if (colorAttr) {
    payload.colors = new Uint8Array(colorAttr.count * 3);
    for (let i = 0; i < colorAttr.count; i++) {
      payload.colors[i * 3] = Math.round(colorAttr.getX(i) * 255);
      payload.colors[i * 3 + 1] = Math.round(colorAttr.getY(i) * 255);
      payload.colors[i * 3 + 2] = Math.round(colorAttr.getZ(i) * 255);
    }
  }
  merged.dispose();
  return payload;
}

function roadsInTile(roads, bounds) {
  const [x0, z0, x1, z1] = bounds;
  return roads.filter(road => road.points.some(([x, z]) => x >= x0 && x <= x1 && z >= z0 && z <= z1));
}

function main() {
  if (check) {
    const indexPath = join(outDir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    let total = 0;
    for (const tile of index.tiles) {
      for (const key of ['lod0', 'lod1', 'roads', 'walkways', 'sidewalks']) {
        const layer = tile[key];
        if (!layer) continue;
        const entries = typeof layer === 'object' && !layer.file ? Object.values(layer) : [layer];
        for (const entry of entries) {
          const bytes = statSync(join(outDir, entry.file)).size;
          const expected = entry.vertices * 12 + entry.vertices * 12 + (entry.hasUV ? entry.vertices * 8 : 0) + (entry.colors ? entry.vertices * 3 : 0) + entry.indices * 4;
          if (bytes !== expected) throw new Error(`${entry.file} 字节 ${bytes} != ${expected}`);
          total += bytes;
        }
      }
    }
    console.log(JSON.stringify({ ok: true, tiles: index.tiles.length, bytes: total, counts: index.counts }));
    return;
  }

  const tiles = new Map();
  for (const building of data.buildings) {
    const [x, z] = centroid(building.rings);
    const key = tileKey(x, z);
    if (!tiles.has(key)) tiles.set(key, { buildings: [], roads: [] });
    tiles.get(key).buildings.push(building);
  }
  for (const road of data.roads) {
    const mid = road.points[Math.floor(road.points.length / 2)];
    const key = tileKey(mid[0], mid[1]);
    if (!tiles.has(key)) tiles.set(key, { buildings: [], roads: [] });
    tiles.get(key).roads.push(road);
  }

  rmSync(join(outDir, 'tiles'), { recursive: true, force: true });
  mkdirSync(join(outDir, 'tiles'), { recursive: true });
  const entries = [];
  const totals = { bytes: 0, vertices: 0, indices: 0, buildings: 0, roads: 0 };
  const started = Date.now();
  const sortedKeys = [...tiles.keys()].sort();
  for (const key of sortedKeys) {
    const bucket = tiles.get(key);
    if (!bucket.buildings.length && !bucket.roads.length) continue;
    const [ix, iz] = key.split('_').map(Number);
    const bounds = tileBounds(ix, iz);
    const subset = { ...data, buildings: bucket.buildings, roads: bucket.roads };
    const chunks = facadeChunks(subset);
    const styles = mergeStyleChunks(chunks);
    const tile = { id: key, bounds, lod0: {} };
    for (const { style, geometry } of styles) {
      const payload = extract(geometry, { hasUV: true, color: null });
      // 颜色已经由 mergeStyleChunks 写进 geometry.color；extract 只负责字节布局。
      const colorAttr = geometry.getAttribute('color');
      if (colorAttr) {
        payload.colors = new Uint8Array(colorAttr.count * 3);
        for (let i = 0; i < colorAttr.count; i++) {
          payload.colors[i * 3] = Math.round(colorAttr.getX(i) * 255);
          payload.colors[i * 3 + 1] = Math.round(colorAttr.getY(i) * 255);
          payload.colors[i * 3 + 2] = Math.round(colorAttr.getZ(i) * 255);
        }
      }
      const written = writeLayer(join(outDir, 'tiles'), key, `lod0.${style}`, payload);
      if (written) tile.lod0[style] = written;
      totals.bytes += written ? statSync(join(outDir, written.file)).size : 0;
      totals.vertices += payload.vertices;
      totals.indices += payload.indicesCount;
      geometry.dispose();
    }
    const lod1 = lod1Geometry(bucket.buildings);
    const written1 = writeLayer(join(outDir, 'tiles'), key, 'lod1', lod1);
    if (written1) { tile.lod1 = written1; totals.bytes += statSync(join(outDir, written1.file)).size; totals.vertices += lod1.vertices; totals.indices += lod1.indicesCount; }
    if (bucket.roads.length) {
      const road = roadGeometry(bucket.roads);
      const payload = extract(road, { hasUV: true, color: null });
      const written = writeLayer(join(outDir, 'tiles'), key, 'roads', payload);
      if (written) { tile.roads = written; totals.bytes += statSync(join(outDir, written.file)).size; totals.vertices += payload.vertices; totals.indices += payload.indicesCount; }
      road.dispose();
      const walkways = bucket.roads.filter(r => r.walkway);
      if (walkways.length) {
        const walk = roadGeometry(walkways);
        const payloadWalk = extract(walk, { hasUV: true, color: null });
        const writtenWalk = writeLayer(join(outDir, 'tiles'), key, 'walkways', payloadWalk);
        if (writtenWalk) { tile.walkways = writtenWalk; totals.bytes += statSync(join(outDir, writtenWalk.file)).size; totals.vertices += payloadWalk.vertices; totals.indices += payloadWalk.indicesCount; }
        walk.dispose();
      }
      const sidewalks = sidewalkGeometry(bucket.roads);
      if (sidewalks.getAttribute('position')?.count) {
        const payloadWalk = extract(sidewalks, { hasUV: true, color: null });
        const writtenWalk = writeLayer(join(outDir, 'tiles'), key, 'sidewalks', payloadWalk);
        if (writtenWalk) { tile.sidewalks = writtenWalk; totals.bytes += statSync(join(outDir, writtenWalk.file)).size; totals.vertices += payloadWalk.vertices; totals.indices += payloadWalk.indicesCount; }
      }
      sidewalks.dispose();
    }
    totals.buildings += bucket.buildings.length;
    totals.roads += bucket.roads.length;
    entries.push(tile);
  }

  const landmarks = [];
  for (const landmark of [...(data.landmarks ?? []), ...(data.landmark ? [data.landmark] : [])]) {
    const building = data.buildings.find(b => b.id === landmark.id);
    landmarks.push({ ...landmark, ...(building ? { rings: building.rings } : {}) });
  }
  const index = {
    version: 2,
    scene,
    tileSize,
    bounds: data.bounds,
    origin: data.origin,
    spawn: data.spawn,
    name: data.name,
    ...(data.note ? { note: data.note } : {}),
    attribution: data.attribution,
    ...(data.landmark ? { landmark: data.landmark } : {}),
    ...(landmarks.length ? { landmarks } : {}),
    ...(data.water ? { water: data.water } : {}),
    street: data.street,
    counts: { buildings: data.buildings.length, roads: data.roads.length },
    tiles: entries,
  };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index), 'utf8');
  const indexBytes = statSync(join(outDir, 'index.json')).size;
  console.log(JSON.stringify({
    scene, tileSize, tiles: entries.length,
    counts: index.counts,
    baked: { buildings: totals.buildings, roads: totals.roads },
    bytes: { tiles: totals.bytes, index: indexBytes, total: totals.bytes + indexBytes },
    vertices: totals.vertices, indices: totals.indices,
    ms: Date.now() - started,
    
  }));
}

main();
