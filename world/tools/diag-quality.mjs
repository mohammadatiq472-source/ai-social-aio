// 诊断"糊/色差/假"的三个可能根因，逐一量化。
//
// 已知：压缩版与原版画面几乎一样 → 不是压缩造成的。
// 所以问题在渲染管线或资产本身的材质参数。
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'assets/characters/whalegirl.glb';
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

console.log('=== 根因 1：金属度（metallicFactor）===');
for (const m of json.materials ?? []) {
  const p = m.pbrMetallicRoughness ?? {};
  const metal = p.metallicFactor ?? 1.0;
  const rough = p.roughnessFactor ?? 1.0;
  const hasMR = !!p.metallicRoughnessTexture;
  console.log(`  材质 "${m.name ?? ''}"`);
  console.log(`    metallicFactor  = ${metal}  ${metal > 0.9 ? '← 全金属！无 IBL 必发灰' : ''}`);
  console.log(`    roughnessFactor = ${rough}`);
  console.log(`    metallicRoughness 贴图 = ${hasMR ? '有（贴图会覆盖 factor）' : '无（纯 factor 生效）'}`);
}

console.log('\n=== 根因 2：法线贴图强度 ===');
for (const m of json.materials ?? []) {
  const nt = m.normalTexture;
  if (nt) {
    console.log(`  材质 "${m.name ?? ''}": normalScale = ${nt.scale ?? 1.0}`);
  } else {
    console.log(`  材质 "${m.name ?? ''}": 无 normalTexture`);
  }
}

console.log('\n=== 根因 3：贴图色彩空间声明 ===');
// glTF 规范：baseColor / emissive 必须是 sRGB；normal / metallicRoughness 必须是线性
// 这个信息不在 glb 里（由 loader 按语义决定），但要确认贴图名与语义匹配
for (const [i, im] of (json.images ?? []).entries()) {
  console.log(`  [${i}] ${im.name ?? '(unnamed)'}  ${im.mimeType}`);
}
console.log('  规范：baseColor → sRGB；normal/metallicRoughness → Linear');
console.log('  若 loader 未按语义设 colorSpace，baseColor 会被当线性数据 → 整体偏暗');

console.log('\n=== 结论 ===');
const mat = json.materials?.[0];
const p = mat?.pbrMetallicRoughness ?? {};
const metal = p.metallicFactor ?? 1.0;
const hasMR = !!p.metallicRoughnessTexture;
if (metal >= 0.9 && hasMR) {
  console.log('metallicFactor=1 但**有** metallicRoughness 贴图 → 贴图的 B 通道(metallic)会覆盖 factor，');
  console.log('所以实际金属度由贴图决定，不一定是全金属。需要看贴图内容才能确定。');
} else if (metal >= 0.9) {
  console.log('❌ metallicFactor=1 且**无** metallicRoughness 贴图 → 角色是纯金属材质。');
  console.log('   金属材质在 PBR 下几乎不产生漫反射，颜色完全来自环境反射。');
  console.log('   没有环境贴图（IBL）时会渲染成"发灰发黑的塑料块" —— 这就是"假"和"色差"的根源。');
  console.log('   修法二选一：');
  console.log('     a) 加环境贴图（RoomEnvironment 或 HDR）—— 推荐，观感提升最大');
  console.log('     b) 把 metallicFactor 改成 0.0~0.2（当作非金属）');
} else {
  console.log('metallicFactor 正常，不是金属度问题。');
}
