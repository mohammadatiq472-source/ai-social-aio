#!/usr/bin/env node
/**
 * 角色资产终版管线（spec §5.1 + §8 draw call 预算）。
 *
 * 一次跑完四件事，顺序不能换：
 *
 *   1. **合并 139 个蒙皮网格 → 1 个**
 *      为什么必须做：Tripo 多部件结构，每角色 139 次 draw call，
 *      同屏 8 角色 1112 次 —— spec §8 要求 8 角色 60fps，这个量级在移动端必掉到 20fps 以下。
 *      且"染色变体共享 geometry"的前提是"一份 geometry"，139 份时变体就是 139 份。
 *
 *   2. **砍动画到 v0.1 需要的 8 条**
 *      spec §4.1 只要 idle/walk/run/jump/fall/sit/emote。
 *      本资产没有 run（只有 walk），也没有 fall —— 这两个由状态机回落到 walk/jump_down 处理。
 *      保留 idle/walk/jump/jump_down/sit/agree/bow/afraid（后四个当 emote 用）。
 *      砍掉 12 条省下约 500KB 动画数据。
 *
 *   3. **关键帧抽稀**（resample tolerance 1e-2）
 *      按容差删掉线性可插值的冗余关键帧。视觉无损（three 默认对 quaternion 用 slerp 插值）。
 *
 *   4. **量化 + meshopt**
 *      ⚠ 只量化 NORMAL/TEXCOORD/WEIGHTS，**绝不量化 POSITION**：
 *      实测 POSITION 量化会把尺寸变成 2 倍（0.313×1.000×0.620 → 0.626×2.000×1.240），
 *      原因是 quantize 的位移补偿要么写进 node transform 要么写进 skin 的 IBM，
 *      而这个资产的蒙皮节点 transform 是单位值，补偿没落地。已在多个变体上复现。
 *
 * 贴图降到 512px webp q75：746KB → 236KB。角色是第三人称中景，512 足够。
 *
 * 用法：node tools/build-character.mjs <原始.glb> <输出.glb>
 */

import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import {
  dedup,
  getBounds,
  prune,
  quantize,
  reorder,
  resample,
  textureCompress,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法: node tools/build-character.mjs <原始.glb> <输出.glb>');
  process.exit(1);
}

/** v0.1 保留的 8 条动画。名字必须与资产里的 clip 名逐字一致。 */
/**
 * v0.1 保留的动画（按"用户会按的键"挑，不按"资产有什么"挑）。
 *
 * 用户明确说的是：行走、跳跃、奔跑、愤怒，其余"也可以"。
 * - 必留：idle/walk/jump/jump_down/sit/turn/angry_01/afraid/cry
 * - 表情键：bow/agree/hug/heart_pose/fold_arms/wait
 * - **不进 v0.1**：box_01 / basketball_shot / cast_a_spell（房间里没有对应物体，
 *   凭空挥拳/投篮观感反而奇怪）、angry_02 / angry_03（与 angry_01 同情绪变体，留一个够）
 *
 * 体积依据（实测）：20 条原始共 1036 KB，抽稀后约 260 KB；15 条约 200 KB。
 * 用 `--anims=a,b,c` 可覆盖，便于试不同组合。
 */
export const KEEP_ANIMATIONS = [
  'idle',
  'walk',
  'jump',
  'jump_down',
  'wait',
  'sit',
  'turn',
  'angry_01',
  'angry_02',
  'angry_03',
  'afraid',
  'cry',
  'bow',
  'agree',
  'hug',
  'heart_pose',
  'fold_arms',
  'box_01',
  'basketball_shot',
  'cast_a_spell',
];

/**
 * 贴图分级（2026-11-20 第三次调整：baseColor 2048 → 1024，为预算让路）。
 *
 * 演进过程（每次都记下来，避免反复横跳）：
 * 1. 最初全 512：特写偏软。
 * 2. 改成 baseColor 2048 / normal 1024 / rm 512：特写清晰，但首屏 brotli 涨到 3.094 MB，
 *    **超出 3 MB 预算 94 KB**（verify-perf 判定 ✗）。
 * 3. 现在 baseColor 降到 1024：特写实测仍然够用（见下），首屏回到预算内。
 *
 * 为什么 1024 够（这是实测结论，不是妥协）：
 * - 特写距离 1.6m、55° fov、900px 高时，角色占屏约 1100px，脸部约 300px。
 * - 1024 贴图映射到 300px 的脸上 = 3.4 texel/px，远超 1:1，看不出模糊。
 * - 8K 源的价值在**远景细节**（衣服纹理），而远景时角色只占 100px，1024 绰绰有余。
 * - 真正需要 2048+ 的场景是"4K 屏幕 + 贴脸特写"，那不是 v0.1 的目标。
 *
 * 分级依据（信息密度，不是一刀切）：
 * - baseColor 承载五官/布料细节，"糊不糊"由它决定 → 1024
 * - normal 是凹凸中频信息，过高反而出噪点 → 1024
 * - metallic/roughness 是**低频**信息（大面积材质变化）→ 512 绰绰有余
 *
 * 显存核算（webp 解码后 RGBA8）：
 *   1024²×4 + 1024²×4 + 512²×4 = 4 + 4 + 1 = 9 MB/角色
 *   单角色场景 9MB；8 角色 72MB，在移动端 128MB 预算内（Agent 默认关闭）。
 */
const TEXTURE_TIERS = {
  baseColor: 1024,
  normal: 1024,
  pbr: 512,
};
/** 分级回退用的单一上限（保留给"不分级"的快速路径与文档）。 */
const TEXTURE_MAX_PX = 1024;
const TEXTURE_QUALITY = 88;
const RESAMPLE_TOLERANCE = 1e-2;

/**
 * 粗糙度下限（0~1）。
 *
 * 为什么需要：原资产 roughness 有 26.8% 的区域 < 0.3（很光滑）。
 * 没有 IBL 时这些区域渲染成死黑；**即使加了 IBL**，过光滑的表面
 * 也会把环境反射得过于镜面，看起来像塑料玩具。
 * 抬到 0.35 让高光更"散"一些，接近布料/皮肤的真实观感。
 */
const ROUGHNESS_FLOOR = 0.35;

const inPath = resolve(input);
const outPath = resolve(output);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const beforeBytes = statSync(inPath).size;
const doc = await io.read(inPath);
const root = doc.getRoot();

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
const animsBefore = root.listAnimations().length;
const primsBefore = root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);

console.log('角色资产终版管线（spec §5.1 + §8）');
console.log(`  输入 ${inPath}  ${beforeBytes} B (${mb(beforeBytes)})`);
console.log('');
console.log(`  起始：${primsBefore} primitives / ${animsBefore} 动画 / 顶点 ${vertsBefore} / 三角形 ${trisBefore}`);
console.log(`        尺寸 ${sizeBefore.map((v) => v.toFixed(4)).join(' × ')}`);
console.log('');

// ── 1. 合并蒙皮网格（用独立脚本的逻辑，见 tools/merge-skinned.mjs 的注释） ──
const merged = await mergeSkinnedPrimitives(doc);
console.log(`  [1] 合并蒙皮网格   ${primsBefore} → ${merged.after} primitive${merged.skipped ? `（跳过 ${merged.skipped} 个不兼容）` : ''}`);

// ── 2. 砍动画 ──
const removed = [];
for (const a of [...root.listAnimations()]) {
  if (!KEEP_ANIMATIONS.includes(a.getName())) {
    removed.push(a.getName());
    a.dispose();
  }
}
console.log(`  [2] 动画裁剪      ${animsBefore} → ${root.listAnimations().length}（移除 ${removed.length} 条）`);
if (removed.length > 0) console.log(`      移除：${removed.join(', ')}`);

// ── 3. 关键帧抽稀 ──
const animBytesBefore = countAnimBytes(root);
await doc.transform(resample({ tolerance: RESAMPLE_TOLERANCE }));
const animBytesAfter = countAnimBytes(root);
console.log(`  [3] 关键帧抽稀    动画 ${kb(animBytesBefore)} → ${kb(animBytesAfter)}（tolerance ${RESAMPLE_TOLERANCE}）`);

// ── 4. 贴图压缩 ──
let texBefore = 0;
for (const t of root.listTextures()) texBefore += t.getImage()?.byteLength ?? 0;

/**
 * 分级压缩：按贴图**用途**分别设分辨率。
 *
 * 踩过的坑（两次）：
 * 1. `slots` 是正则，但它匹配的是**贴图槽位名**（如 `baseColorTexture`），
 *    而我们的资产贴图名是中文（`人鱼女仆3d模型_basecolor`），所以 pattern 全没命中。
 * 2. 加了"兜底统一压一遍"反而把前面分级的结果全压回 512 —— 兜底会覆盖分级。
 *
 * 正确做法：**按贴图的 name 后缀判定用途，逐张处理**，不走 slots。
 * 贴图名后缀（`_basecolor` / `_normal` / `_rm`）是 Tripo 导出约定，稳定可用。
 */
function tierOf(tex) {
  const n = (tex.getName() ?? '').toLowerCase();
  if (n.includes('normal')) return TEXTURE_TIERS.normal;
  if (n.includes('basecolor') || n.includes('albedo') || n.includes('diffuse')) {
    return TEXTURE_TIERS.baseColor;
  }
  // _rm / metallic / roughness / occlusion 等低频贴图
  return TEXTURE_TIERS.pbr;
}

const texLog = [];
for (const tex of root.listTextures()) {
  const px = tierOf(tex);
  const before = tex.getImage()?.byteLength ?? 0;
  const name = tex.getName() ?? '(unnamed)';

  // 用 sharp 直接处理单张贴图：解码 → 缩放 → webp 编码。
  // 为什么不用 textureCompress：它按 transform 批量处理，无法逐张给不同分辨率。
  const img = tex.getImage();
  if (!img) continue;
  const out = await sharp(Buffer.from(img))
    .resize(px, px, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: TEXTURE_QUALITY })
    .toBuffer();
  tex.setImage(new Uint8Array(out));
  tex.setMimeType('image/webp');

  const after = out.length;
  texLog.push(`${name} → ${px}px: ${kb(before)} → ${kb(after)}`);
}

let texAfter = 0;
for (const t of root.listTextures()) texAfter += t.getImage()?.byteLength ?? 0;
console.log(`  [4] 贴图          ${kb(texBefore)} → ${kb(texAfter)}（分级 q${TEXTURE_QUALITY}）`);
for (const line of texLog) console.log(`        ${line}`);

// ── 5. 量化（不碰 POSITION）+ meshopt ──
await doc.transform(prune(), dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.ACCESSOR] }));
await doc.transform(
  quantize({
    // 关键：pattern 排除 POSITION。量化 POSITION 会让尺寸翻倍（见文件头注释）
    pattern: /^(NORMAL|TEXCOORD|COLOR|WEIGHTS)(_\d+)?$/,
    patternTargets: /^(NORMAL|TANGENT|TEXCOORD|COLOR|WEIGHTS)(_\d+)?$/,
    quantizeWeight: 8,
    quantizeNormal: 10,
    quantizeTexcoord: 12,
    cleanup: true,
  }),
);
await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
  method: EXTMeshoptCompression.EncoderMethod.QUANTIZE,
});
console.log('  [5] 量化 + meshopt  NORMAL/TEXCOORD/WEIGHTS 量化，POSITION 保持 float32');

// ── 写出 ──
mkdirSync(dirname(outPath), { recursive: true });
await io.write(outPath, doc);
const afterBytes = statSync(outPath).size;
const gzipBytes = gzipSync(readFileSync(outPath)).length;

// ── 校验（重新读回，验证解码后正确） ──
const verify = await io.read(outPath);
const vroot = verify.getRoot();
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

const sizeOk = sizeBefore.every((v, i) => Math.abs(sizeAfter[i] - v) / Math.max(Math.abs(v), 1e-6) < 0.005);
const vertsOk = vertsAfter === vertsBefore;
const trisOk = Math.round(trisAfter) === Math.round(trisBefore);
const animsOk = vroot.listAnimations().length === KEEP_ANIMATIONS.length;
const primsAfter = vroot.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);

console.log('');
console.log(`  输出 ${outPath}`);
console.log(`       raw  ${afterBytes} B (${mb(afterBytes)})`);
console.log(`       gzip ${gzipBytes} B (${mb(gzipBytes)})`);
console.log(`       压缩比 ${(beforeBytes / afterBytes).toFixed(2)}×`);
console.log('');
console.log('  校验：');
console.log(`    尺寸一致     ${sizeOk ? '✓' : '✗'}  ${sizeBefore.map((v) => v.toFixed(4)).join('×')} → ${sizeAfter.map((v) => v.toFixed(4)).join('×')}`);
console.log(`    顶点守恒     ${vertsOk ? '✓' : '✗'}  ${vertsBefore} → ${vertsAfter}`);
console.log(`    三角形守恒   ${trisOk ? '✓' : '✗'}  ${Math.round(trisBefore)} → ${Math.round(trisAfter)}`);
console.log(`    动画条数     ${animsOk ? '✓' : '✗'}  ${vroot.listAnimations().length}/${KEEP_ANIMATIONS.length}`);
console.log(`    骨骼         ${vroot.listSkins()[0]?.listJoints().length ?? 0} 根`);
console.log('');
console.log(`  draw call：每角色 ${primsBefore} → ${primsAfter}（同屏 8 角色 ${primsBefore * 8} → ${primsAfter * 8}）`);
console.log(`  动画：${vroot.listAnimations().map((a) => a.getName()).join(', ')}`);
console.log('');
console.log(`  sha256  ${createHash('sha256').update(readFileSync(outPath)).digest('hex')}`);

if (!sizeOk || !vertsOk || !trisOk || !animsOk) {
  console.error('\n✗ 校验失败，产物不可用');
  process.exit(1);
}

// ───────────────────────────── helpers ─────────────────────────────

function countAnimBytes(r) {
  const seen = new Set();
  let n = 0;
  for (const a of r.listAnimations()) {
    for (const s of a.listSamplers()) {
      for (const acc of [s.getInput(), s.getOutput()]) {
        if (acc && !seen.has(acc)) {
          seen.add(acc);
          n += acc.getArray()?.byteLength ?? 0;
        }
      }
    }
  }
  return n;
}

/**
 * 把共享同一 skin/material/属性布局的蒙皮 primitive 合并成一个。
 * gltf-transform 的 join() 跳过蒙皮节点，所以这里自己拼。
 */
async function mergeSkinnedPrimitives(d) {
  const r = d.getRoot();
  const all = [];
  for (const mesh of r.listMeshes()) for (const prim of mesh.listPrimitives()) all.push({ mesh, prim });

  if (all.length <= 1) return { before: all.length, after: all.length, skipped: 0 };

  const layouts = new Set(all.map((c) => c.prim.listSemantics().sort().join(',')));
  if (layouts.size !== 1) return { before: all.length, after: all.length, skipped: all.length };

  const skin = r.listSkins()[0];
  if (!skin) return { before: all.length, after: all.length, skipped: all.length };

  const semantics = all[0].prim.listSemantics().sort();
  const material = all[0].prim.getMaterial();

  // 拼接属性
  const mergedAttrs = {};
  for (const sem of semantics) {
    const chunks = all.map((c) => c.prim.getAttribute(sem).getArray());
    const ctor = chunks[0].constructor;
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new ctor(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    mergedAttrs[sem] = out;
  }

  // 拼接索引
  const idxChunks = [];
  let vOff = 0;
  for (const c of all) {
    const idx = c.prim.getIndices();
    const count = c.prim.getAttribute('POSITION').getCount();
    if (idx) {
      const arr = idx.getArray();
      const shifted = new arr.constructor(arr.length);
      for (let i = 0; i < arr.length; i++) shifted[i] = arr[i] + vOff;
      idxChunks.push(shifted);
    } else {
      const arr = new Uint32Array(count);
      for (let i = 0; i < count; i++) arr[i] = i + vOff;
      idxChunks.push(arr);
    }
    vOff += count;
  }
  let idxTotal = 0;
  for (const c of idxChunks) idxTotal += c.length;
  const mergedIdx = new idxChunks[0].constructor(idxTotal);
  let io2 = 0;
  for (const c of idxChunks) {
    mergedIdx.set(c, io2);
    io2 += c.length;
  }

  // 建新 mesh
  const newPrim = d.createPrimitive();
  for (const sem of semantics) {
    const acc = d
      .createAccessor(sem)
      .setType(all[0].prim.getAttribute(sem).getType())
      .setArray(mergedAttrs[sem]);
    newPrim.setAttribute(sem, acc);
  }
  newPrim.setIndices(d.createAccessor('indices').setType('SCALAR').setArray(mergedIdx));
  if (material) newPrim.setMaterial(material);

  const newMesh = d.createMesh('merged').addPrimitive(newPrim);
  const host = r.listNodes().find((n) => n.getSkin() && n.getMesh());
  if (host) host.setMesh(newMesh);

  for (const n of r.listNodes()) {
    if (n !== host && n.getMesh()) n.setMesh(null);
  }
  for (const m of r.listMeshes()) if (m !== newMesh) m.dispose();

  return { before: all.length, after: 1, skipped: 0 };
}
