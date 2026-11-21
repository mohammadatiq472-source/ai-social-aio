// 读 animator 内部的一次性动作状态，定位为什么 4 秒兜底没生效。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const b = await chromium.launch(chromiumLaunchOptions());
const p = await b.newPage({ viewport: { width: 800, height: 700 } });
await p.goto('http://127.0.0.1:5199/', { waitUntil: 'load' });
await p.waitForFunction(() => typeof window.__agentDebug === 'object', { timeout: 30000 });
await p.waitForTimeout(9000);
await p.mouse.click(400, 600);
await p.waitForTimeout(300);

const snap = () =>
  p.evaluate(() => ({
    os: window.__worldDebug.oneShotState(),
    chain: window.__worldDebug.animChain(),
  }));

console.log('跳前:', JSON.stringify(await snap()));
await p.keyboard.press('Space');
for (let i = 0; i < 10; i++) {
  await p.waitForTimeout(700);
  const s = await snap();
  console.log(
    `${String(i * 700).padStart(4)}ms os=${JSON.stringify(s.os)} chain=${JSON.stringify(s.chain)}`,
  );
}
await b.close();
