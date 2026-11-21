// 关键性能问题取证：139 个 mesh 是否共享同一个 skin 与 material？
// 若共享，就能合并成 1 个 SkinnedMesh —— draw call 从 139 降到 1，
// 这是 8 角色同屏能否 60fps 的决定性因素（spec §8）。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

const skins = new Set();
const materials = new Set();
const attrSets = new Set();
let primCount = 0;

for (const m of json.meshes ?? []) {
  for (const p of m.primitives ?? []) {
    primCount++;
    if (p.material !== undefined) materials.add(p.material);
    attrSets.add(Object.keys(p.attributes ?? {}).sort().join(','));
  }
}
for (const n of json.nodes ?? []) {
  if (n.skin !== undefined) skins.add(n.skin);
  if (n.mesh !== undefined) {
    const m = json.meshes[n.mesh];
    for (const p of m?.primitives ?? []) {
      if (p.material !== undefined) materials.add(p.material);
    }
  }
}

const skinnedNodes = (json.nodes ?? []).filter((n) => n.skin !== undefined).length;
const meshNodes = (json.nodes ?? []).filter((n) => n.mesh !== undefined).length;

console.log(`primitive 总数        ${primCount}`);
console.log(`引用到的 skin 数      ${skins.size}   (joints=${json.skins?.[0]?.joints?.length ?? 0})`);
console.log(`引用到的 material 数  ${materials.size}`);
console.log(`带 skin 的节点数      ${skinnedNodes}`);
console.log(`带 mesh 的节点数      ${meshNodes}`);
console.log(`属性组合数            ${attrSets.size}  → ${[...attrSets].join(' | ')}`);
console.log('');
const mergeable = skins.size <= 1 && materials.size <= 1 && attrSets.size <= 1;
console.log(mergeable
  ? '✅ 全部共享同一 skin + material + 属性布局 → 可以合并成 1 个 SkinnedMesh（draw call 139 → 1）'
  : '❌ 不能简单合并：skin/material/属性布局不一致，需要分别处理');
console.log('');
console.log(`当前同屏 8 角色 draw call ≈ ${primCount * 8}`);
console.log(`合并后同屏 8 角色 draw call ≈ ${8}（再配合染色变体共享 geometry）`);
