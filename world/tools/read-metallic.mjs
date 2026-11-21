// 读 metallicRoughness 贴图的实际像素值，判断角色到底有多"金属"。
// glTF 规范：G 通道 = roughness，B 通道 = metallic。
// 如果 B 通道普遍接近 1.0，说明是纯金属 → 无 IBL 必发灰。
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const path = process.argv[2] ?? 'assets/characters/whalegirl.glb';
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;

const target = (json.images ?? []).find((im) => /_rm|metallic|rough/i.test(im.name ?? ''));
if (!target) {
  console.log('找不到 metallicRoughness 贴图');
  process.exit(1);
}

const bv = json.bufferViews[target.bufferView];
const bytes = buf.subarray(binStart + (bv.byteOffset ?? 0), binStart + (bv.byteOffset ?? 0) + bv.byteLength);

const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

// 统计 G（roughness）与 B（metallic）的分布
let sumR = 0, sumG = 0, sumB = 0;
let metallicHigh = 0; // B > 0.5
let roughLow = 0;     // G < 0.3（很光滑）
const total = width * height;
const hist = { g: new Array(10).fill(0), b: new Array(10).fill(0) };

for (let i = 0; i < total; i++) {
  const r = data[i * channels] / 255;
  const g = data[i * channels + 1] / 255;
  const b = data[i * channels + 2] / 255;
  sumR += r; sumG += g; sumB += b;
  if (b > 0.5) metallicHigh++;
  if (g < 0.3) roughLow++;
  hist.g[Math.min(9, Math.floor(g * 10))]++;
  hist.b[Math.min(9, Math.floor(b * 10))]++;
}

console.log(`贴图 ${target.name}  ${width}x${height}`);
console.log(`平均 R = ${(sumR / total).toFixed(3)}`);
console.log(`平均 G (roughness) = ${(sumG / total).toFixed(3)}`);
console.log(`平均 B (metallic)  = ${(sumB / total).toFixed(3)}   ← 关键`);
console.log('');
console.log(`B(metallic) > 0.5 的像素占比: ${((metallicHigh / total) * 100).toFixed(1)}%`);
console.log(`G(roughness) < 0.3 的像素占比: ${((roughLow / total) * 100).toFixed(1)}%`);
console.log('');
console.log('metallic 分布（0→1，每 10% 一格）:');
for (let i = 0; i < 10; i++) {
  const pct = (hist.b[i] / total) * 100;
  console.log(`  ${(i * 10).toString().padStart(2)}-${(i * 10 + 10).toString().padStart(3)}%  ${'█'.repeat(Math.round(pct / 2))} ${pct.toFixed(1)}%`);
}
console.log('');
const avgMetal = sumB / total;
if (avgMetal > 0.6) {
  console.log(`❌ 平均金属度 ${avgMetal.toFixed(2)} → 这是**纯金属**材质。`);
  console.log('   PBR 下金属没有漫反射，颜色全靠环境反射。没有 IBL 就会渲染成灰黑块。');
  console.log('   这就是"色差大、样子假"的根因，和贴图分辨率无关。');
} else if (avgMetal > 0.25) {
  console.log(`⚠️ 平均金属度 ${avgMetal.toFixed(2)} → 偏高。建议加 IBL。`);
} else {
  console.log(`✅ 平均金属度 ${avgMetal.toFixed(2)} → 正常非金属，金属度不是问题。`);
}
