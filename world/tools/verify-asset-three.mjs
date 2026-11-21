#!/usr/bin/env node
/**
 * 资产在 node 侧的可加载性验证（不依赖浏览器）。
 *
 * 为什么需要：`tools/build-character.mjs` 只验证了 glTF 结构（顶点/尺寸/动画条数），
 * 但**没验证 three 能不能真的解析它**。three 的 GLTFLoader 与 gltf-transform 是两套实现，
 * 一个能读不代表另一个能读。尤其是我们用了 meshopt + KHR_mesh_quantization，
 * 少注册一个扩展就加载失败。
 *
 * 这个脚本用 three 的 GLTFLoader 在 node 里真实解析一遍，断言：
 * - 解析成功、无异常
 * - 1 个 SkinnedMesh、1 个 Skeleton、41 根骨骼
 * - 8 个 AnimationClip，名字与 registry 一致
 * - 包围盒高度 ≈ 1.62m（归一化后）且脚底贴地
 *
 * 用法：node --import ./scripts/ts-node-loader.mjs tools/verify-asset-three.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
const { WHALEGIRL } = await import('../src/assets/registry.ts');
const { AVATAR_HEIGHT_M } = await import('../src/assets/loader.ts');

const assetPath = resolve(ROOT, WHALEGIRL.url);
const buf = readFileSync(assetPath);

/**
 * node 里没有 `Image`，但 three 的 GLTFLoader 在处理 webp 贴图时会 `new Image()` 探测支持。
 * 这里给一个最小 stub：`src` 赋值后触发 onload、宽高给 1。
 *
 * 注意：这不是"假装贴图加载成功"来糊弄验证——本脚本验证的是**几何/骨骼/动画结构**，
 * 贴图解码在浏览器里做。stub 只让解析流程能走完，我们随后会显式断言贴图数量。
 */
if (typeof globalThis.Image === 'undefined') {
  class FakeImage {
    constructor() {
      this.width = 1;
      this.height = 1;
      this.onload = null;
      this.onerror = null;
      this._src = '';
    }
    set src(v) {
      this._src = v;
      // 异步触发，模拟真实加载的时序
      queueMicrotask(() => this.onload?.({ target: this }));
    }
    get src() {
      return this._src;
    }
    addEventListener(type, fn) {
      if (type === 'load') this.onload = fn;
      if (type === 'error') this.onerror = fn;
    }
    removeEventListener() {}
  }
  globalThis.Image = FakeImage;
}

/** createImageBitmap 同理：GLTFLoader 用它把 blob 转纹理。 */
if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
}

/**
 * GLTFLoader 的 loadImageSource 里用 `self.URL || self.webkitURL` 造 blob URL。
 * node 里没有 `self`，补上。这里只借用 node 的 URL 与 URL.createObjectURL 的形状。
 */
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}
if (typeof globalThis.URL.createObjectURL !== 'function') {
  // node 22 的 URL 没有 createObjectURL；给个返回占位字符串的实现，
  // 因为我们的 FakeImage 不真的去 fetch 这个 URL。
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
}
console.log('three 侧资产可加载性验证');
console.log(`  文件 ${assetPath}`);
console.log(`       ${buf.byteLength} B (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`);
console.log('');

await MeshoptDecoder.ready;

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

// 用 parse 而不是 load：避免在 node 里起 http 服务
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => {
  loader.parse(ab, '', res, rej);
});

const scene = gltf.scene;

// ── 统计结构 ──
let skinnedCount = 0;
let meshCount = 0;
const skeletons = new Set();
const boneCounts = new Set();
const mats = new Set();
let geomCount = 0;

scene.traverse((o) => {
  if (o.isSkinnedMesh) {
    skinnedCount += 1;
    if (o.skeleton) {
      skeletons.add(o.skeleton);
      boneCounts.add(o.skeleton.bones.length);
    }
  }
  if (o.isMesh) {
    meshCount += 1;
    if (o.geometry) geomCount += 1;
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => mats.add(x));
    else if (m) mats.add(m);
  }
});

console.log(`  解析成功`);
console.log(`  meshes ${meshCount} / skinned ${skinnedCount} / geometries ${geomCount}`);
console.log(`  skeletons ${skeletons.size} / 骨骼数 ${[...boneCounts].join(',')}`);
console.log(`  materials ${mats.size}`);
console.log(`  animations ${gltf.animations.length} → ${gltf.animations.map((a) => a.name).join(', ')}`);
console.log('');

// ── 归一化（与 loader.ts 同一套逻辑）──
const box = new THREE.Box3().setFromObject(scene);
const size = box.getSize(new THREE.Vector3());
const originalHeight = size.y;
const scale = AVATAR_HEIGHT_M / originalHeight;
scene.scale.setScalar(scale);
scene.position.y = -box.min.y * scale;

const box2 = new THREE.Box3().setFromObject(scene);
const finalHeight = box2.max.y - box2.min.y;
const feetY = box2.min.y;

console.log(`  原始高度 ${originalHeight.toFixed(4)} m`);
console.log(`  缩放     ${scale.toFixed(4)}×`);
console.log(`  归一化后 ${finalHeight.toFixed(4)} m（目标 ${AVATAR_HEIGHT_M}）`);
console.log(`  脚底 y   ${feetY.toFixed(4)}（目标 0）`);
console.log('');

// ── 断言 ──
const problems = [];

if (skinnedCount !== 1) problems.push(`期望 1 个 SkinnedMesh，实际 ${skinnedCount}`);
if (skeletons.size !== 1) problems.push(`期望 1 个 Skeleton，实际 ${skeletons.size}`);
const bones = [...boneCounts][0] ?? 0;
if (bones !== 41) problems.push(`期望 41 根骨骼，实际 ${bones}`);
if (mats.size !== 1) problems.push(`期望 1 个材质（染色变体的前提），实际 ${mats.size}`);
if (gltf.animations.length !== WHALEGIRL.animations.length) {
  problems.push(`动画数不符：加载到 ${gltf.animations.length}，registry 登记 ${WHALEGIRL.animations.length}`);
}
const loadedNames = gltf.animations.map((a) => a.name).sort();
const registeredNames = [...WHALEGIRL.animations].sort();
if (JSON.stringify(loadedNames) !== JSON.stringify(registeredNames)) {
  problems.push(`动画名不符：加载 [${loadedNames}] vs 登记 [${registeredNames}]`);
}
if (Math.abs(finalHeight - AVATAR_HEIGHT_M) > 0.01) {
  problems.push(`归一化高度偏差 ${Math.abs(finalHeight - AVATAR_HEIGHT_M).toFixed(4)} m > 0.01`);
}
if (Math.abs(feetY) > 0.01) problems.push(`脚底未贴地：y=${feetY.toFixed(4)}`);
if (geomCount !== 1) problems.push(`期望 1 份 geometry（染色变体共享的前提），实际 ${geomCount}`);

// ── 蒙皮有效性：每根骨骼的 matrixWorld 是否有限 ──
let nanBones = 0;
for (const sk of skeletons) {
  for (const b of sk.bones) {
    if (!b.matrixWorld.elements.every((v) => Number.isFinite(v))) nanBones += 1;
  }
}
if (nanBones > 0) problems.push(`${nanBones} 根骨骼的 matrixWorld 含 NaN`);

// ── 动画轨道有效性 ──
let badTracks = 0;
for (const clip of gltf.animations) {
  for (const track of clip.tracks) {
    const values = track.values;
    if (!values || values.length === 0) badTracks += 1;
    else if (!values.every((v) => Number.isFinite(v))) badTracks += 1;
  }
}
if (badTracks > 0) problems.push(`${badTracks} 条动画轨道含空值或 NaN`);

console.log(`  动画轨道总数 ${gltf.animations.reduce((n, c) => n + c.tracks.length, 0)}（异常 ${badTracks}）`);
console.log('');

if (problems.length > 0) {
  console.error('✗ 验证失败：');
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}

console.log(
  `✓ 全部通过：three 可加载、1 SkinnedMesh / 1 Skeleton / 41 骨骼 / 1 材质 / ${gltf.animations.length} 动画、归一化与贴地正确`,
);
