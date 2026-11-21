// 检查压缩是否损伤了贴图的"内容质量"（不只是分辨率）。
// 关键：法线贴图（normal）对压缩极敏感——webp 有损压缩会破坏法线的单位向量性质，
// 表现为"表面变平、光照细节丢失"。这是"糊"的另一个来源，且和分辨率无关。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

console.log(`文件 ${path}\n`);
console.log('=== 材质与贴图配置 ===');
for (const [i, m] of (json.materials ?? []).entries()) {
  console.log(`材质[${i}] ${m.name ?? '(none)'}`);
  const pbr = m.pbrMetallicRoughness ?? {};
  const nt = m.normalTexture;
  console.log(`  baseColorTexture: ${pbr.baseColorTexture ? '有' : '无'}`);
  console.log(`  normalTexture:    ${nt ? `有 (scale=${nt.scale ?? 1})` : '无'}`);
  console.log(`  metallicRoughness: ${pbr.metallicRoughnessTexture ? '有' : '无'}`);
  console.log(`  occlusion:        ${m.occlusionTexture ? '有' : '无'}`);
  console.log(`  emissive:         ${m.emissiveTexture ? '有' : '无'}`);
}

console.log('\n=== 贴图采样器（过滤模式）===');
for (const [i, s] of (json.samplers ?? []).entries()) {
  const mag = s.magFilter === 9729 ? 'LINEAR' : s.magFilter === 9728 ? 'NEAREST' : String(s.magFilter ?? '默认');
  const min = s.minFilter === 9987 ? 'LINEAR_MIPMAP_LINEAR' : s.minFilter === 9729 ? 'LINEAR' : String(s.minFilter ?? '默认');
  console.log(`采样器[${i}] mag=${mag} min=${min} wrap=${s.wrapS ?? '默认'}`);
}

console.log('\n=== 贴图尺寸汇总 ===');
for (const im of json.images ?? []) {
  const bv = json.bufferViews[im.bufferView];
  console.log(`  ${(im.name ?? '').padEnd(30)} ${im.mimeType.padEnd(12)} ${Math.round(bv.byteLength / 1024)} KB`);
}

const tris = (json.meshes ?? []).reduce(
  (s, m) => s + (m.primitives ?? []).reduce((t, p) => t + (p.indices !== undefined ? (json.accessors[p.indices]?.count ?? 0) / 3 : 0), 0),
  0,
);
console.log(`\n三角形 ${Math.round(tris)}  骨骼 ${json.skins?.[0]?.joints?.length ?? 0}`);
