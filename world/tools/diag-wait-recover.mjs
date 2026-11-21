import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';
const b = await chromium.launch(chromiumLaunchOptions());
const p = await b.newPage({ viewport: { width: 800, height: 700 } });
await p.goto('http://127.0.0.1:5199/', { waitUntil: 'load' });
await p.waitForFunction(() => typeof window.__agentDebug === 'object', { timeout: 30000 });
await p.waitForTimeout(9000);
await p.mouse.click(400, 600);
await p.keyboard.press('Space');
// 等到 animator 恢复 idle（最多 30 秒）
let ok = false;
for (let i = 0; i < 60; i++) {
  await p.waitForTimeout(500);
  const st = await p.evaluate(() => window.__worldDebug.animChain().animator);
  if (st === 'idle' || st === 'walk') { console.log(`恢复于 ${(i+1)*0.5}s: animator=${st}`); ok = true; break; }
}
if (!ok) console.log('30 秒内未恢复');
const os = await p.evaluate(() => window.__worldDebug.oneShotState());
console.log('最终:', JSON.stringify(os));
await b.close();
process.exit(ok ? 0 : 1);
