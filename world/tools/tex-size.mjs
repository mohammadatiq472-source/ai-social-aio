// 从 glb 里提取贴图的真实像素尺寸与编码，判断"压缩后会不会糊"。
//
// 为什么必须量而不是猜：糊不糊取决于**贴图分辨率 vs 模型在屏幕上的像素占位**。
// 只看文件从 4.31MB 降到 1.54MB 说明不了问题——几何和动画也占了体积。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;

/** 从图片字节里读宽高。支持 webp / png / jpeg。 */
function imageSize(bytes) {
  // PNG: 89 50 4E 47 ... IHDR at offset 16
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { format: 'png', w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  // JPEG: 扫 SOF0/1/2 段
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { format: 'jpeg', h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      // lossy: 帧头在 offset 26，14 位宽高
      const w = bytes.readUInt16LE(26) & 0x3fff;
      const h = bytes.readUInt16LE(28) & 0x3fff;
      return { format: 'webp-lossy', w, h };
    }
    if (chunk === 'VP8L') {
      // lossless: offset 21 起 14+14 位
      const b = bytes.readUInt32LE(21);
      return { format: 'webp-lossless', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      // extended: 24 位宽高（减 1）
      const w = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
      const h = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
      return { format: 'webp-extended', w, h };
    }
  }
  return { format: 'unknown', w: 0, h: 0 };
}

console.log(`文件 ${path}`);
console.log(`  总大小 ${(buf.length / 1048576).toFixed(2)} MB\n`);

let totalBytes = 0;
for (const [i, im] of (json.images ?? []).entries()) {
  const bv = json.bufferViews[im.bufferView];
  const off = binStart + (bv.byteOffset ?? 0);
  const bytes = buf.subarray(off, off + bv.byteLength);
  const sz = imageSize(bytes);
  totalBytes += bv.byteLength;
  const mp = ((sz.w * sz.h) / 1e6).toFixed(2);
  console.log(
    `  [${i}] ${String(im.name ?? '').padEnd(28)} ${sz.format.padEnd(14)} ${String(sz.w).padStart(5)}x${String(sz.h).padEnd(5)} (${mp} MP)  ${Math.round(bv.byteLength / 1024)} KB`,
  );
}
console.log(`\n  贴图合计 ${(totalBytes / 1048576).toFixed(2)} MB（占文件 ${((totalBytes / buf.length) * 100).toFixed(0)}%）`);
