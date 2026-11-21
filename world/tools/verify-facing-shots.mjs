// 朝向验证（截图版）：走起来时，第三人称默认相机应该看到**后脑勺**。
//
// 判据不能只靠读 rotation.y —— 那是物理层的值，不受 MODEL_FACING_OFFSET_Y 影响。
// 必须看画面：角色向前走，相机在后面跟着，应该看到背面。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 800, height: 800 } });

await page.goto(`${BASE}?time=day`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__agentDebug === 'object', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.waitForFunction(
  () => {
    const c = document.querySelector('canvas');
    const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
    return !gl || !gl.isContextLost();
  },
  { timeout: 15000 },
).catch(() => {});
await page.waitForTimeout(5000);
await page.mouse.click(400, 700);
await page.waitForTimeout(300);

// 1. 静止时截图（相机在背后，应该看到背面）
await page.screenshot({ path: 'tmp/facing-idle.png' });
console.log('已截图 tmp/facing-idle.png（静止）');

// 2. 按 W 向前走，边跑边截图（应该看到背面，不是脸）
await page.keyboard.down('w');
await page.waitForTimeout(900);
await page.screenshot({ path: 'tmp/facing-walk.png' });
await page.keyboard.up('w');
console.log('已截图 tmp/facing-walk.png（按 W 向前走）');

// 3. 按 A 向左，应该看到身体转向左侧
await page.keyboard.down('a');
await page.waitForTimeout(900);
await page.screenshot({ path: 'tmp/facing-left.png' });
await page.keyboard.up('a');
console.log('已截图 tmp/facing-left.png（按 A 向左）');

// 4. 特写模式（?cam=face）应该看到正脸
const page2 = await browser.newPage({ viewport: { width: 800, height: 800 } });
await page2.goto(`${BASE}?time=day&cam=face`, { waitUntil: 'load' });
await page2.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });
await page2.waitForTimeout(2500);
await page2.waitForFunction(
  () => {
    const c = document.querySelector('canvas');
    const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
    return !gl || !gl.isContextLost();
  },
  { timeout: 15000 },
).catch(() => {});
await page2.waitForTimeout(5000);
await page2.mouse.click(400, 700);
await page2.waitForTimeout(600);
await page2.screenshot({ path: 'tmp/facing-face.png' });
console.log('已截图 tmp/facing-face.png（?cam=face 特写，应该看到正脸）');

await browser.close();
console.log('\n人工判读：');
console.log('  facing-walk.png 应看到【后脑勺/背影】（角色向前走，相机在后面）');
console.log('  facing-face.png 应看到【正脸】（特写模式）');
