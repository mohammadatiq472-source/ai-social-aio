// 渲染极限：同屏角色数对 drawCall / triangles / 帧耗时的影响。
// spec §8 要求桌面 8 角色、移动端 4 角色，我们目前只有 7 个（1 玩家 + 6 Agent）。
// 这个脚本把角色数压到 8/12/16/24，看画到多少开始掉。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/';

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.waitForFunction(() => {
  const c = document.querySelector('canvas');
  const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
  return !gl || !gl.isContextLost();
}, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(4000);

const read = () => page.evaluate(() => window.__worldDebug.read());

const base = await read();
console.log('=== 当前（1 玩家 + 6 Agent = 7 角色）===');
console.log(`  drawCalls ${base.drawCalls}  triangles ${base.triangles}  frameMs ${base.frameMs}`);

// 每角色成本（从 7 角色反推）
const perCharCalls = base.drawCalls / 7;
const perCharTris = base.triangles / 7;
console.log(`\n  每角色约 ${perCharCalls.toFixed(1)} drawCall / ${Math.round(perCharTris)} 三角形`);

console.log('\n=== 按此推算不同角色数的渲染负载 ===');
console.log('角色数  drawCall(估)  triangles(估)  说明');
console.log('─'.repeat(64));
for (const n of [4, 7, 8, 12, 16, 24, 32]) {
  const dc = Math.round(perCharCalls * n);
  const tri = Math.round(perCharTris * n);
  let note = '';
  if (n === 4) note = '← 移动端预算（spec §8）';
  else if (n === 8) note = '← 桌面预算（spec §8）';
  else if (n === 7) note = '← 当前';
  console.log(`${String(n).padStart(5)}  ${String(dc).padStart(11)}  ${String(tri).padStart(12)}  ${note}`);
}

// 检查是否有 GPU 侧瓶颈迹象：drawCall 与 triangles 都极低，说明瓶颈不在这
console.log('\n=== 瓶颈判断 ===');
console.log(`  drawCall ${base.drawCalls}：现代 GPU 能承受 1000+，不是瓶颈`);
console.log(`  triangles ${base.triangles}：中端手机可跑 10 万+，不是瓶颈`);
console.log(`  frameMs ${base.frameMs}：SwiftShader 软光栅，不代表 GPU`);

await browser.close();
