// 读取 glb 的 JSON chunk，列出动画/骨骼/网格/贴图规模。
// 为什么手写：只为了在排期前确认"资产够不够用"，不值得为它装 gltf-transform。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('用法: node tools/inspect-glb.mjs <file.glb>');
  process.exit(1);
}

const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== 0x46546c67) {
  console.error('不是 glb（magic 不匹配）');
  process.exit(1);
}
const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);

// chunk 0 必须是 JSON
const chunkLen = buf.readUInt32LE(12);
const chunkType = buf.readUInt32LE(16);
if (chunkType !== 0x4e4f534a) {
  console.error('首个 chunk 不是 JSON');
  process.exit(1);
}
const json = JSON.parse(buf.subarray(20, 20 + chunkLen).toString('utf8'));

const anims = (json.animations ?? []).map((a) => ({
  name: a.name ?? '(unnamed)',
  channels: a.channels?.length ?? 0,
}));

let tris = 0;
let skinnedMeshes = 0;
let totalMeshes = 0;
for (const m of json.meshes ?? []) {
  totalMeshes++;
  for (const p of m.primitives ?? []) {
    const idx = p.indices;
    if (idx !== undefined) {
      const acc = json.accessors[idx];
      tris += (acc?.count ?? 0) / 3;
    }
    if (p.attributes?.JOINTS_0 !== undefined) skinnedMeshes++;
  }
}

const images = (json.images ?? []).map((i) => ({
  mime: i.mimeType ?? '?',
  name: i.name ?? '',
  bufferView: i.bufferView !== undefined,
}));

const nodes = json.nodes?.length ?? 0;
const skins = (json.skins ?? []).map((s) => ({ name: s.name ?? '', joints: s.joints?.length ?? 0 }));

console.log(JSON.stringify({
  file: path,
  bytes: buf.length,
  version,
  declaredTotal: total,
  generator: json.asset?.generator ?? '?',
  nodes,
  meshes: totalMeshes,
  skinnedMeshes,
  triangles: Math.round(tris),
  skins,
  animations: anims,
  images,
  materials: (json.materials ?? []).length,
}, null, 2));
