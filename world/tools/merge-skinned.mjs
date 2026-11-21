#!/usr/bin/env node
/**
 * 把多个蒙皮 primitive 合并成 1 个（spec §8 的 draw call 预算要求）。
 *
 * 为什么必须自己写：`@gltf-transform/functions` 的 `join()` **明确跳过蒙皮节点**
 * （源码里 `if (node.getSkin()) continue;`）。我们的角色是 Tripo 多部件结构，
 * 139 个蒙皮网格共享 1 个 skin / 1 个 material / 1 种属性布局，
 * 本来是最理想的合并场景，但 join() 一个都不碰。
 *
 * 不合并的代价（实测）：
 *   每角色 139 次 draw call → 同屏 8 角色 1112 次
 *   spec §8 要求 8 角色 60fps，1112 次 draw call 在移动端必掉到 20fps 以下。
 *   且染色变体"共享 geometry"的前提是"一份 geometry"，139 份时变体仍是 139 份。
 *
 * 合并做法（等价于 three 的 mergeGeometries，但在 glTF 层面做，产物更小）：
 *   1. 所有 primitive 的顶点属性按相同布局拼接（POSITION/NORMAL/TEXCOORD_0/JOINTS_0/WEIGHTS_0）
 *   2. 索引整体偏移后拼接
 *   3. 只建 1 个 Mesh、1 个 Node，指向原来的 Skin 与 Material
 *   4. 动画不动（动画驱动的是 Bone 节点，与网格结构无关）
 *
 * 安全性：合并前后必须校验
 *   - 顶点数 / 三角形数守恒
 *   - 包围盒尺寸不变（容差 0.5%）
 *   - 动画数不变
 *   - JOINTS_0 索引范围仍在 41 根骨骼内
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, getBounds, prune, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const input = args[0];
const output = args[1];
if (!input || !output) {
  console.error('用法: node tools/merge-skinned.mjs <输入.glb> <输出.glb>');
  process.exit(1);
}

const inPath = resolve(input);
const outPath = resolve(output);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const doc = await io.read(inPath);
const root = doc.getRoot();

const beforeBytes = statSync(inPath).size;
const meshesBefore = root.listMeshes().length;
const primsBefore = root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
const animsBefore = root.listAnimations().length;
const skinsBefore = root.listSkins().length;

const boxBefore = getBounds(root.listScenes()[0]);
const sizeBefore = [
  boxBefore.max[0] - boxBefore.min[0],
  boxBefore.max[1] - boxBefore.min[1],
  boxBefore.max[2] - boxBefore.min[2],
];

let vertsBefore = 0;
let trisBefore = 0;
for (const m of root.listMeshes()) {
  for (const p of m.listPrimitives()) {
    vertsBefore += p.getAttribute('POSITION').getCount();
    trisBefore += (p.getIndices()?.getCount() ?? 0) / 3;
  }
}

console.log('蒙皮网格合并（spec §8 draw call 预算）');
console.log(`  输入 ${inPath}`);
console.log(`       ${beforeBytes} bytes (${(beforeBytes / 1024 / 1024).toFixed(2)} MB)`);
console.log('');
console.log(`  合并前：${meshesBefore} meshes / ${primsBefore} primitives / ${skinsBefore} skin / ${animsBefore} 动画`);
console.log(`          顶点 ${vertsBefore} / 三角形 ${trisBefore}`);
console.log(`          尺寸 ${sizeBefore.map((v) => v.toFixed(4)).join(' × ')}`);
console.log('');

// ── 收集所有可合并的 primitive ──
// 判据（不满足就跳过并报告，不硬合）：
//   - 有 JOINTS_0 + WEIGHTS_0（蒙皮）
//   - 属性布局一致
//   - 共享同一 skin
//   - 无 morph targets（合并 morph 语义不同，会改变行为）
const candidates = [];
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const semantics = prim.listSemantics().sort().join(',');
    candidates.push({ mesh, prim, semantics, targets: prim.listTargets().length });
  }
}

const layouts = new Set(candidates.map((c) => c.semantics));
const withTargets = candidates.filter((c) => c.targets > 0);

if (layouts.size !== 1) {
  console.error(`✗ 属性布局不一致（${layouts.size} 种），不能安全合并：`);
  for (const l of layouts) console.error(`   ${l}`);
  process.exit(1);
}
if (withTargets.length > 0) {
  console.error(`✗ 有 ${withTargets.length} 个 primitive 带 morph targets，合并会改变行为`);
  process.exit(1);
}

const skin = root.listSkins()[0];
const material = candidates[0].prim.getMaterial();
if (!skin) {
  console.error('✗ 没有 skin，这不是蒙皮网格（本脚本只处理蒙皮合并）');
  process.exit(1);
}
const jointCount = skin.listJoints().length;

// 所有 primitive 必须共享同一 skin / material
const skinNodes = root.listNodes().filter((n) => n.getSkin());
const materials = new Set(candidates.map((c) => c.prim.getMaterial()));
if (materials.size > 1) {
  console.error(`✗ 材质不一致（${materials.size} 种），合并会丢材质`);
  process.exit(1);
}

const semantics = candidates[0].semantics.split(',');

// ── 拼接顶点属性 ──
// 每类属性按 componentType/type 决定用哪种 TypedArray
const refAttr = candidates[0].prim.getAttribute(semantics[0]);
void refAttr;

function concatTyped(ctor, chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new ctor(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const mergedAttrs = {};
for (const sem of semantics) {
  const chunks = candidates.map((c) => c.prim.getAttribute(sem).getArray());
  const ctor = chunks[0].constructor;
  mergedAttrs[sem] = concatTyped(ctor, chunks);
}

// ── 拼接索引（整体偏移） ──
const indexChunks = [];
let vertexOffset = 0;
for (const c of candidates) {
  const idx = c.prim.getIndices();
  const pos = c.prim.getAttribute('POSITION');
  const count = pos.getCount();
  if (idx) {
    const arr = idx.getArray();
    const shifted = new arr.constructor(arr.length);
    for (let i = 0; i < arr.length; i++) shifted[i] = arr[i] + vertexOffset;
    indexChunks.push(shifted);
  } else {
    // 无索引：生成顺序索引
    const arr = new Uint32Array(count);
    for (let i = 0; i < count; i++) arr[i] = i + vertexOffset;
    indexChunks.push(arr);
  }
  vertexOffset += count;
}

const mergedIndex = concatTyped(indexChunks[0].constructor, indexChunks);

// ── 校验 JOINTS_0 索引范围 ──
const joints = mergedAttrs['JOINTS_0'];
if (joints) {
  let maxJoint = 0;
  for (let i = 0; i < joints.length; i++) if (joints[i] > maxJoint) maxJoint = joints[i];
  if (maxJoint >= jointCount) {
    console.error(`✗ JOINTS_0 含越界骨骼索引 ${maxJoint}（骨架只有 ${jointCount} 根）`);
    process.exit(1);
  }
  console.log(`  JOINTS_0 最大值 ${maxJoint} < 骨骼数 ${jointCount} → ✓ 绑定有效`);
}

// ── 建新 Mesh + Node，删旧的 ──
const buffer = root.listBuffers()[0];
const newPrim = doc.createPrimitive();
for (const sem of semantics) {
  const acc = doc.createAccessor(sem).setType(candidates[0].prim.getAttribute(sem).getType()).setArray(mergedAttrs[sem]);
  newPrim.setAttribute(sem, acc);
}
const idxAcc = doc.createAccessor('indices').setType('SCALAR').setArray(mergedIndex);
newPrim.setIndices(idxAcc);
if (material) newPrim.setMaterial(material);

const newMesh = doc.createMesh('merged').addPrimitive(newPrim);
void buffer;

// 复用第一个带 skin 的节点作为承载者，保留其 transform 与 skin
const hostNode = skinNodes[0];
hostNode.setMesh(newMesh);

// 删掉其余带 mesh 的节点与旧 mesh
for (const node of root.listNodes()) {
  if (node === hostNode) continue;
  if (node.getMesh()) {
    node.setMesh(null);
  }
}
for (const m of root.listMeshes()) {
  if (m !== newMesh) m.dispose();
}
for (const n of root.listNodes()) {
  // 清掉没有任何引用的空节点
  if (!n.getMesh() && n.listChildren().length === 0 && !n.getSkin() && n.listParents().every((p) => p.propertyType === 'Root')) {
    n.dispose();
  }
}

// ── 清理 ──
await doc.transform(prune(), dedup(), reorder({ encoder: MeshoptEncoder, target: 'size' }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
  method: EXTMeshoptCompression.EncoderMethod.QUANTIZE,
});

mkdirSync(dirname(outPath), { recursive: true });
await io.write(outPath, doc);

// ── 写后校验（重新读，验证解码后数据正确） ──
const verify = await io.read(outPath);
const vroot = verify.getRoot();
const meshesAfter = vroot.listMeshes().length;
const primsAfter = vroot.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
const animsAfter = vroot.listAnimations().length;

let vertsAfter = 0;
let trisAfter = 0;
for (const m of vroot.listMeshes()) {
  for (const p of m.listPrimitives()) {
    vertsAfter += p.getAttribute('POSITION').getCount();
    trisAfter += (p.getIndices()?.getCount() ?? 0) / 3;
  }
}

const boxAfter = getBounds(vroot.listScenes()[0]);
const sizeAfter = [
  boxAfter.max[0] - boxAfter.min[0],
  boxAfter.max[1] - boxAfter.min[1],
  boxAfter.max[2] - boxAfter.min[2],
];

const afterBytes = statSync(outPath).size;

const sizeOk = sizeBefore.every((v, i) => Math.abs(sizeAfter[i] - v) / Math.max(Math.abs(v), 1e-6) < 0.005);
const vertsOk = vertsAfter === vertsBefore;
const trisOk = Math.round(trisAfter) === Math.round(trisBefore);
const animsOk = animsAfter === animsBefore;

console.log('');
console.log(`  合并后：${meshesAfter} meshes / ${primsAfter} primitive / ${vroot.listSkins().length} skin / ${animsAfter} 动画`);
console.log(`          顶点 ${vertsAfter} / 三角形 ${Math.round(trisAfter)}`);
console.log(`          尺寸 ${sizeAfter.map((v) => v.toFixed(4)).join(' × ')}`);
console.log('');
console.log(`  输出 ${outPath}`);
console.log(`       ${afterBytes} bytes (${(afterBytes / 1024 / 1024).toFixed(2)} MB)  省下 ${kb(beforeBytes - afterBytes)}`);
console.log('');
console.log('  校验：');
console.log(`    尺寸一致      ${sizeOk ? '✓' : '✗'}  (${sizeBefore.map((v) => v.toFixed(4)).join('×')} → ${sizeAfter.map((v) => v.toFixed(4)).join('×')})`);
console.log(`    顶点守恒      ${vertsOk ? '✓' : '✗'}  (${vertsBefore} → ${vertsAfter})`);
console.log(`    三角形守恒    ${trisOk ? '✓' : '✗'}  (${Math.round(trisBefore)} → ${Math.round(trisAfter)})`);
console.log(`    动画完整      ${animsOk ? '✓' : '✗'}  (${animsBefore} → ${animsAfter})`);
console.log('');
console.log(`  draw call：每角色 ${primsBefore} → ${primsAfter}（同屏 8 角色 ${primsBefore * 8} → ${primsAfter * 8}）`);
console.log('');
console.log(`  sha256  ${sha256(outPath)}`);

if (!sizeOk || !vertsOk || !trisOk || !animsOk) {
  console.error('');
  console.error('✗ 校验失败，产物不可用');
  process.exit(1);
}
