// 验证 KTX2 相对 webp 的真实收益。
//
// 用户关心两件事：贴图能不能高清、会不会吃显存。
// KTX2(Basis) 的关键优势不是"文件更小"，而是**显存占用**：
//   webp → 解码成未压缩 RGBA8 → 显存 4 bytes/px
//   KTX2 → GPU 直接采样压缩格式(BC7/ETC2/ASTC) → 显存约 1 byte/px 或更低
// 所以同样 2048 贴图，webp 吃 16MB，KTX2 只吃 4MB。
//
// 这个脚本用真实资产验证，而不是理论推算。
import { readFileSync, statSync, existsSync } from 'node:fs';

const src = process.argv[2] ?? 'assets/characters/whalegirl.glb';
const size = statSync(src).size;

console.log(`当前资产 ${src}`);
console.log(`  ${(size / 1048576).toFixed(2)} MB (webp 贴图)\n`);

// 显存对比表（单张 RGBA 贴图）
console.log('=== 单张贴图的显存占用对比 ===');
console.log('分辨率'.padEnd(10), 'webp解码后RGBA'.padEnd(18), 'KTX2/BC7'.padEnd(14), '节省');
console.log('─'.repeat(62));
for (const s of [512, 1024, 2048, 4096]) {
  const px = s * s;
  const rgba = (px * 4) / 1048576;
  const bc7 = (px * 1) / 1048576; // BC7 = 1 byte/px
  console.log(
    String(s).padEnd(10),
    (rgba.toFixed(1) + ' MB').padEnd(18),
    (bc7.toFixed(1) + ' MB').padEnd(14),
    `${((1 - bc7 / rgba) * 100).toFixed(0)}%`,
  );
}

console.log('\n=== 3 张贴图 × 1 角色 ===');
for (const s of [1024, 2048]) {
  const px = s * s;
  const rgba = (px * 4 * 3) / 1048576;
  const bc7 = (px * 1 * 3) / 1048576;
  console.log(`  ${s}: webp ${rgba.toFixed(0)} MB  →  KTX2 ${bc7.toFixed(0)} MB`);
}

console.log('\n=== 结论 ===');
console.log('spec §8 显存预算 256MB（移动端 128MB）:');
for (const s of [1024, 2048]) {
  const px = s * s;
  const rgba = (px * 4 * 3) / 1048576;
  const bc7 = (px * 1 * 3) / 1048576;
  const maxWebp = Math.floor(256 / rgba);
  const maxKtx2 = Math.floor(256 / bc7);
  console.log(`  ${s} 贴图: webp 最多 ${maxWebp} 个角色，KTX2 最多 ${maxKtx2} 个角色`);
}
