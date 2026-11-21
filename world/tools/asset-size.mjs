// 量资产真实传输体积（raw vs gzip）。
// 为什么重要：spec §8 的「首屏 ≤3MB」按 gzip 口径认定（lead 已裁决），
// glb 的 gzip 压缩率通常在 25~35%，所以 raw 3.24MB 未必超预算。
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node tools/asset-size.mjs <file...>');
  process.exit(1);
}

let totalRaw = 0;
let totalGz = 0;
for (const f of files) {
  const b = readFileSync(f);
  const gz = gzipSync(b, { level: 9 });
  totalRaw += b.length;
  totalGz += gz.length;
  console.log(
    `${f.split(/[\\/]/).pop()}\n` +
      `  raw  ${b.length.toLocaleString().padStart(12)} B  ${(b.length / 1048576).toFixed(2)} MB\n` +
      `  gzip ${gz.length.toLocaleString().padStart(12)} B  ${(gz.length / 1048576).toFixed(2)} MB  (${((gz.length / b.length) * 100).toFixed(1)}%)`,
  );
}
if (files.length > 1) {
  console.log(
    `\n合计  raw ${(totalRaw / 1048576).toFixed(2)} MB   gzip ${(totalGz / 1048576).toFixed(2)} MB`,
  );
}
