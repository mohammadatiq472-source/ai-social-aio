// 裁出脸部区域并放大，做真正的清晰度对比。
//
// 为什么要裁+放大：整张 900x900 图里脸只占 ~80px，肉眼看不出 512 与 1024 的差别。
// 放大到 400px 再并排看，才接近"用户把脸凑近看"的感知。
import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { writeFileSync } from 'node:fs';

const [imgA, imgB, outA, outB] = process.argv.slice(2);
if (!imgA || !imgB) {
  console.error('用法: node tools/crop-face.mjs <a.png> <b.png> <outA.png> <outB.png>');
  process.exit(1);
}

// 脸在图中的大致位置（900x900 视口，角色居中偏下）
const CROP = { x: 380, y: 600, w: 150, h: 150 };
const SCALE = 4;

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: CROP.w * SCALE, height: CROP.h * SCALE } });

for (const [src, out] of [[imgA, outA], [imgB, outB]]) {
  const data = await import('node:fs').then((m) => m.readFileSync(src).toString('base64'));
  await page.setContent(`
    <body style="margin:0;background:#000">
      <div style="width:${CROP.w * SCALE}px;height:${CROP.h * SCALE}px;overflow:hidden;position:relative">
        <img src="data:image/png;base64,${data}"
             style="position:absolute;left:${-CROP.x * SCALE}px;top:${-CROP.y * SCALE}px;
                    width:${900 * SCALE}px;height:${900 * SCALE}px;
                    image-rendering:pixelated">
      </div>
    </body>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: out });
  console.log(`裁切放大 → ${out}`);
}

await browser.close();
