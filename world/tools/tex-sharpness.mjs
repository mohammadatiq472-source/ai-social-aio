// 判定"糊不糊"的关键：模型在屏幕上的实际像素占位 vs 贴图分辨率。
//
// 原理：贴图 512×512 意味着角色正面 UV 展开大约只有 512 像素的细节。
// 如果角色在屏幕上占 300px 高，那 512 贴图绰绰有余；
// 如果占 900px 高（近景特写），512 就会看出软。
//
// 这个脚本在几种典型观看距离下量出角色屏幕占位，给出"够不够"的结论。
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
await page.waitForTimeout(5000);

// 角色真实高度 1.62m。用相机距离 + fov 算屏幕占位：
// 屏幕高度像素 = (角色高度 / (2 * dist * tan(fov/2))) * viewportHeight
const distances = [1.5, 2.2, 4.2, 8, 15];
const viewportH = 720;
const fovDeg = 55; // 与 camera.ts 默认一致则更准；下面也会从页面读

const fov = await page.evaluate(() => {
  // 尝试从调试口读相机 fov
  const c = window.__worldDebug?.read?.()?.camera;
  return c?.fov ?? null;
});

console.log(`视口高 ${viewportH}px，fov ${fov ?? fovDeg}°\n`);
console.log('观看距离  角色屏幕高度   贴图 512 是否够（按 1 texel ≈ 1 px 估算）');
console.log('─'.repeat(72));

for (const d of distances) {
  const f = (fov ?? fovDeg) * Math.PI / 180;
  const screenH = (1.62 / (2 * d * Math.tan(f / 2))) * viewportH;
  // 角色 UV 展开：正面大约占贴图宽度的一部分，保守按"身高映射到贴图 512 像素"
  const texelsPerPixel = 512 / screenH;
  let verdict;
  if (texelsPerPixel >= 1.5) verdict = '✅ 充足（贴图细节比屏幕像素还多）';
  else if (texelsPerPixel >= 1.0) verdict = '✅ 刚好（1:1，肉眼难辨）';
  else if (texelsPerPixel >= 0.6) verdict = '⚠️ 略软（近看能察觉）';
  else verdict = '❌ 会糊（特写距离）';
  console.log(
    `${String(d).padStart(6)}m   ${screenH.toFixed(0).padStart(6)}px      ${verdict}  (${texelsPerPixel.toFixed(2)} texel/px)`,
  );
}

console.log('\n注：这是保守估算——角色 UV 通常不是"整张贴图给整身高"，');
console.log('    实际脸部区域会占贴图更大比例，所以真实观感比上表更好一些。');

// 再实际拍两张：远景（正常游玩）与近景（特写）
for (const [d, name] of [[4.2, 'far'], [1.5, 'near']]) {
  await page.evaluate((dist) => window.__worldDebug?.setDistance?.(dist), d);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `tmp/tex-${name}.png` });
  console.log(`已截图 tmp/tex-${name}.png（距离 ${d}m）`);
}

await browser.close();
