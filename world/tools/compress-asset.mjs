#!/usr/bin/env node
/**
 * 资产压缩（spec §5.1 标准流程）。
 *
 *  原始 glb → resize(贴图最长边 1024) → webp/ktx2 → prune + dedup → meshopt → assets/
 *
 * 为什么必须做（数字来自规格书 §5.1 与本次实测）：
 * 原始 Tripo 产出 34.29MB；只做 resize+webp+prune 后 4.31MB（贴图 30.61MB→0.74MB，
 * 但**几何仍约 3.5MB**）。4.31MB 超首屏 3MB 预算，所以角色资产必须再走 meshopt
 * （几何 3.5MB → 约 1.2MB），总量落到 ~2MB 才算达标。
 *
 * 用法：
 *   node tools/compress-asset.mjs <输入.glb> <输出.glb> [--max-texture=1024] [--no-meshopt]
 *
 * 输出会打印每一步前后的字节数，便于把"压缩前/压缩后"贴进交接文档。
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const input = args[0];
const output = args[1];

if (!input || !output) {
  console.error('用法: node tools/compress-asset.mjs <输入.glb> <输出.glb> [--max-texture=1024] [--no-meshopt]');
  process.exit(1);
}

const maxTextureArg = args.find((a) => a.startsWith('--max-texture='));
const maxTexture = maxTextureArg ? Number(maxTextureArg.split('=')[1]) : 1024;
const useMeshopt = !args.includes('--no-meshopt');

const inPath = resolve(input);
const outPath = resolve(output);

function bytes(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** 统计 glb 里几何与贴图各占多少（用于解释体积构成）。 */
async function breakdown(doc) {
  let geomBytes = 0;
  let texBytes = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const attr of prim.listAttributes()) {
        geomBytes += attr.getArray()?.byteLength ?? 0;
      }
      const idx = prim.getIndices();
      if (idx) geomBytes += idx.getArray()?.byteLength ?? 0;
      for (const target of prim.listTargets()) {
        for (const attr of target.listAttributes()) {
          geomBytes += attr.getArray()?.byteLength ?? 0;
        }
      }
    }
  }
  for (const tex of doc.getRoot().listTextures()) {
    texBytes += tex.getImage()?.byteLength ?? 0;
  }
  return { geomBytes, texBytes };
}

/**
 * 把重复的 Skin 合并成一个。
 *
 * 为什么需要：`meshopt()` 内部先调 `reorder()`，它为了让每个 primitive 的顶点局部性最好，
 * 会给**每个 primitive 各自建一个 Skin**（共享同一组 joints，但各持一份 inverseBindMatrices）。
 * 实测：原始 1 个 skin → meshopt 后 139 个 skin（139 个蒙皮网格各一个）。
 *
 * 后果不只是体积（多出 ~45KB）：运行时 three 会为每个 SkinnedMesh 建一个 Skeleton，
 * 41 骨骼 × 139 = 5699 个 Bone 对象，且每帧对每个 Skeleton 单独算骨骼矩阵——
 * 这是纯粹的浪费，且会让 `renderer.info.memory.geometries` 之类的计数被污染。
 *
 * 合并判据：joints 列表（节点索引数组）完全相同 → 视为同一个骨架，可安全复用。
 * inverseBindMatrices 的**数据**必须一致；若不一致说明真是不同骨架，跳过不合并（宁可慢不要错）。
 */
function mergeDuplicateSkins(doc) {
  const root = doc.getRoot();
  const skins = root.listSkins();
  if (skins.length <= 1) return { merged: 0, before: skins.length, after: skins.length };

  const signature = (skin) => {
    const joints = skin.listJoints().map((j) => root.listNodes().indexOf(j));
    const ibm = skin.getInverseBindMatrices();
    const data = ibm ? Array.from(ibm.getArray() ?? []) : [];
    // 用 joints + IBM 数据的哈希做签名：只有两者都一致才认为是同一骨架
    let hash = 0;
    for (const v of [...joints, ...data]) {
      hash = (hash * 31 + Math.round(v * 1e6)) | 0;
    }
    return `${joints.join(',')}|${hash}|${data.length}`;
  };

  const canonical = new Map(); // signature -> 首个 Skin
  let merged = 0;

  for (const skin of skins) {
    const sig = signature(skin);
    const first = canonical.get(sig);
    if (!first) {
      canonical.set(sig, skin);
      continue;
    }
    // 把引用这个 skin 的所有 node 改指向 first
    for (const node of root.listNodes()) {
      if (node.getSkin() === skin) node.setSkin(first);
    }
    skin.dispose();
    merged += 1;
  }

  return { merged, before: skins.length, after: root.listSkins().length };
}

const t0 = Date.now();

// 关键：meshopt 编码器必须显式注册，否则 meshopt() 会抛"encoder not ready"
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

/**
 * 编码器必须注册在 **I/O 实例**上，不能只传给 `meshopt()`。
 *
 * 原因：EXTMeshoptCompression 声明了 `writeDependencies = ["meshopt.encoder"]`，
 * 写出器在 prewrite 前会执行 `extension.install(key, io._dependencies[key])`——
 * 这一步会用 IO 的依赖**覆盖**实例上的 `_encoder`。只改实例字段没用，会被覆盖成 undefined，
 * 然后 `_prewriteAccessors` 调 `encoder.encodeFilterExp(...)` 就崩。
 *
 * `meshopt()` 变换只负责 reorder+quantize 并设置 EncoderMethod，不负责注入编码器。
 */
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const beforeBytes = bytes(inPath);
console.log('资产压缩（spec §5.1）');
console.log(`  输入  ${inPath}`);
console.log(`        ${beforeBytes} bytes (${(beforeBytes / 1024 / 1024).toFixed(2)} MB)`);
console.log('');

const doc = await io.read(inPath);
const before = await breakdown(doc);
console.log(`  读取后构成：几何 ${kb(before.geomBytes)} / 贴图 ${kb(before.texBytes)}`);
console.log(`  网格 ${doc.getRoot().listMeshes().length} 个，动画 ${doc.getRoot().listAnimations().length} 个，材质 ${doc.getRoot().listMaterials().length} 个`);
console.log('');

// ── 1. resize 贴图（4.x 的 resize 已并入 textureCompress）──
const tTex = Date.now();
await doc.transform(
  textureCompress({
    encoder: (await import('sharp')).default,
    targetFormat: 'webp',
    resize: [maxTexture, maxTexture],
    quality: 82,
  }),
);
const afterTex = await breakdown(doc);
console.log(`  [1] 贴图 resize→${maxTexture}px + webp  ${kb(before.texBytes)} → ${kb(afterTex.texBytes)}  (${Date.now() - tTex}ms)`);

// ── 2. prune + dedup ──
await doc.transform(prune(), dedup());
const afterPrune = await breakdown(doc);
console.log(`  [2] prune + dedup                 几何 ${kb(before.geomBytes)} → ${kb(afterPrune.geomBytes)}`);

// ── 3. reorder + meshopt 无损 buffer 压缩 ──
if (useMeshopt) {
  const tMesh = Date.now();
  /**
   * 这里**不调 `quantize()`**，只用 `reorder()` + EXTMeshoptCompression 的 buffer 压缩。
   *
   * 为什么（这是本次踩得最深的坑，实测数据都在）：
   * 本资产是 Tripo 的多部件结构 —— **139 个蒙皮网格共享 1 个 skin（41 骨骼）**。
   * `quantize()` 要把 POSITION 的位移补偿写进「父 Node transform 或 Skin 的 IBM」，
   * 但一个共享 skin 无法同时表达 139 个网格各自的量化尺度，于是：
   *   - POSITION 被压到 int16（±32767）
   *   - 补偿没写进 IBM（IBM 第一列仍是单位长度）
   *   - node 的 T/R/S 仍是 [1,1,1]
   *   → 加载后模型放大两万多倍：包围盒 0.313×1.000×0.620 变成 2.000×2.000×2.000。
   *
   * 试过的所有 quantize 变体都失败（尺寸全部 ≠ 原始）：
   *   level:'high'（收窄 pattern）    → 2.0×2.0×2.0，1261KB
   *   level:'medium'（默认 pattern）  → 2.0×2.0×2.0，1045KB
   *   quantizationVolume:'scene'      → 0.626×2.0×1.24
   *   只量化非 POSITION               → 尺寸对，但 3.66MB（比不量化还大）
   * `join()` 也合不动这 139 个 mesh（它们是独立 node）。
   *
   * 结论：在 gltf-transform 4.5.1 + 多网格共享 skin 的结构下，quantize 不可用。
   * 用无损 meshopt buffer 压缩，换来 4.31MB → 3.24MB 且**尺寸精确**。
   * 下方 `尺寸校验` 会兜住这类回归，任何让包围盒变化的压缩都会直接失败。
   */
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const afterMesh = await breakdown(doc);
  console.log(`  [3] reorder + meshopt buffer    几何 ${kb(afterPrune.geomBytes)} → ${kb(afterMesh.geomBytes)}  (${Date.now() - tMesh}ms)`);
} else {
  console.log('  [3] meshopt 已跳过（--no-meshopt）');
}

// ── 4. 合并 meshopt 拆出来的重复 skin ──
const skinResult = mergeDuplicateSkins(doc);
if (skinResult.before > 1) {
  console.log(
    `  [4] 合并重复 skin             ${skinResult.before} → ${skinResult.after}（合并 ${skinResult.merged} 个）`,
  );
}

// ── 写出 ──
mkdirSync(dirname(outPath), { recursive: true });
await io.write(outPath, doc);

/**
 * 自动校验：压缩前后 scene 包围盒必须一致（容差 1%）。
 *
 * 为什么必须校验：quantize/meshopt 会把 POSITION 压成 int16 并把缩放补偿写进
 * node transform 或 skin 的 IBM。一旦补偿路径出错，文件体积很好看、解码也不报错，
 * 但模型会放大/缩小几万倍——**只有算包围盒才能发现**。
 * 这个 bug 我在 level:'high' 上真踩到了（0.31×1.0×0.62 → 2×2×2），所以固化成断言。
 */
const ioVerify = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const verifyDoc = await ioVerify.read(outPath);
const origDoc = await ioVerify.read(inPath);
const { getBounds } = await import('@gltf-transform/functions');

const sizeOf = (d) => {
  const b = getBounds(d.getRoot().listScenes()[0]);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
};
const sizeBefore = sizeOf(origDoc);
const sizeAfter = sizeOf(verifyDoc);
const sizeOk = sizeBefore.every((v, i) => {
  const a = sizeAfter[i];
  const denom = Math.max(Math.abs(v), 1e-6);
  return Math.abs(a - v) / denom < 0.01;
});

const afterBytes = bytes(outPath);
const totalMs = Date.now() - t0;

console.log('');
console.log(`  输出  ${outPath}`);
console.log(`        ${afterBytes} bytes (${(afterBytes / 1024 / 1024).toFixed(2)} MB)`);
console.log('');
console.log(`  压缩比 ${(beforeBytes / afterBytes).toFixed(2)}×  省下 ${kb(beforeBytes - afterBytes)}  耗时 ${totalMs}ms`);
console.log('');
console.log(`  尺寸校验  原始 ${sizeBefore.map((v) => v.toFixed(3)).join(' × ')}`);
console.log(`            压缩 ${sizeAfter.map((v) => v.toFixed(3)).join(' × ')}  → ${sizeOk ? '✓ 一致' : '✗ 不一致（资产已损坏，不要用）'}`);
console.log('');
console.log(`  sha256  ${sha256(outPath)}`);
console.log('');
console.log('  ⚠ 注意：meshopt 压缩后的 glb 必须用 MeshoptDecoder 解码，');
console.log('    加载端（loader.ts）不注册解码器会直接报"no decoder"或顶点数据全错。');

if (!sizeOk) {
  console.error('');
  console.error('✗ 尺寸校验失败：压缩改变了模型尺寸，产物不可用。');
  console.error('  常见原因：quantize 的 pattern 收窄导致位移补偿没落到 node/IBM 上。');
  console.error('  处置：用 level:"medium"（默认 pattern），不要用 "high"。');
  process.exit(1);
}
