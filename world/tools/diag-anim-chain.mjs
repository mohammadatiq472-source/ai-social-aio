// 定位"跳跃后动画卡死"到底卡在哪一层。
// 四个来源同时读：actor / 物理控制器 / main 的镜像变量 / animator 状态机。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const b = await chromium.launch(chromiumLaunchOptions());
const p = await b.newPage({ viewport: { width: 800, height: 700 } });
await p.goto('http://127.0.0.1:5199/', { waitUntil: 'load' });
await p.waitForFunction(() => typeof window.__agentDebug === 'object', { timeout: 30000 });
await p.waitForTimeout(9000);
await p.mouse.click(400, 600);
await p.waitForTimeout(300);

const snap = () => p.evaluate(() => window.__worldDebug.animChain());

console.log('跳前:', JSON.stringify(await snap()));
await p.keyboard.press('Space');
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(700);
  console.log(`${String(i * 700).padStart(4)}ms`, JSON.stringify(await snap()));
}
await b.close();
