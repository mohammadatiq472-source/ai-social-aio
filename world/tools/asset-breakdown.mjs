// 精确归因 glb 体积（按 bufferView 去重，避免共享 view 重复计数）。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const views = json.bufferViews ?? [];

const owner = new Map(); // bufferView index -> 'image' | 'anim' | 'geom' | 'other'
function claim(i, kind) {
  if (i === undefined || i === null) return;
  const prev = owner.get(i);
  // 优先级：image > anim > geom（一个 view 只归一类，避免重复计数）
  if (!prev || (prev !== 'image' && kind === 'image')) owner.set(i, kind);
}

for (const im of json.images ?? []) claim(im.bufferView, 'image');
for (const a of json.animations ?? []) {
  for (const s of a.samplers ?? []) {
    claim(s.input, 'anim');
    claim(s.output, 'anim');
  }
}
for (const m of json.meshes ?? []) {
  for (const p of m.primitives ?? []) {
    for (const accIdx of Object.values(p.attributes ?? {})) claim(json.accessors?.[accIdx]?.bufferView, 'geom');
    if (p.indices !== undefined) claim(json.accessors?.[p.indices]?.bufferView, 'geom');
    for (const t of p.targets ?? []) {
      for (const accIdx of Object.values(t)) claim(json.accessors?.[accIdx]?.bufferView, 'geom');
    }
  }
}

const sums = { image: 0, anim: 0, geom: 0, other: 0 };
for (let i = 0; i < views.length; i++) {
  const kind = owner.get(i) ?? 'other';
  sums[kind] += views[i].byteLength ?? 0;
}

const total = buf.length;
console.log(`总大小 ${(total / 1048576).toFixed(2)} MB (${total.toLocaleString()} B)`);
console.log(`  JSON chunk ${(jsonLen / 1024).toFixed(1)} KB  ← 元数据：节点/网格/动画轨道名`);
console.log('');
for (const [k, v] of Object.entries(sums)) {
  if (v === 0) continue;
  console.log(`  ${k.padEnd(6)} ${(v / 1048576).toFixed(2)} MB  (${((v / total) * 100).toFixed(0)}%)`);
}
console.log('');

// draw call 估算：每个 mesh primitive 一次
let prims = 0;
for (const m of json.meshes ?? []) prims += (m.primitives ?? []).length;
console.log(`网格 ${(json.meshes ?? []).length} 个 / primitive ${prims} 个  → 每角色约 ${prims} 次 draw call`);
console.log(`若同屏 8 角色 → ${prims * 8} 次 draw call（spec §8 要求 8 角色 60fps）`);
console.log('');
console.log(`动画 ${(json.animations ?? []).length} 条，每条约 ${Math.round((json.animations?.[0]?.channels ?? []).length)} 轨道`);
console.log(`骨骼 ${(json.skins?.[0]?.joints ?? []).length} 根`);
