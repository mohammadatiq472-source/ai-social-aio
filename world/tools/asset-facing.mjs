// 查模型的"原生朝向"：根节点有没有预置旋转？决定渲染层要不要加 facing offset。
// 这条坑交接文档里记过（"这个模型 rotation.y = -Math.PI/2 才正对 +Z 镜头"），
// 但新资产经过压缩/合并，必须重新确认，不能照抄旧结论。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

const scene = json.scenes?.[json.scene ?? 0];
console.log('场景根节点:', JSON.stringify(scene?.nodes));
for (const idx of scene?.nodes ?? []) {
  const n = json.nodes[idx];
  console.log(`\n节点[${idx}] name=${n.name ?? '(none)'}`);
  console.log('  rotation   =', JSON.stringify(n.rotation ?? null));
  console.log('  scale      =', JSON.stringify(n.scale ?? null));
  console.log('  translation=', JSON.stringify(n.translation ?? null));
  if (n.rotation) {
    const [x, y, z, w] = n.rotation;
    // 提取绕 Y 的偏航角（假设近似纯 yaw）
    const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
    console.log(`  → yaw ≈ ${((yaw * 180) / Math.PI).toFixed(1)}°`);
  }
  // 看子树里有没有额外旋转
  const kids = n.children ?? [];
  console.log('  子节点数 =', kids.length);
}

// 找 Armature
const armIdx = (json.nodes ?? []).findIndex((n) => /armature/i.test(n.name ?? ''));
if (armIdx >= 0) {
  const a = json.nodes[armIdx];
  console.log(`\nArmature 节点[${armIdx}] rotation=`, JSON.stringify(a.rotation ?? null), 'scale=', JSON.stringify(a.scale ?? null));
}
