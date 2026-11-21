// 诊断：跳跃后 anim 卡在 jump 的根因。
// 同时读物理控制器内部状态与 actor 值，分清是哪一层没更新。
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
    phys: window.__worldDebug.physState(),
    actorAnim: window.__agentDebug.read().hero?.anim,
    clips: window.__worldDebug.heroPlayingClips(),
  }));

console.log('跳前:', JSON.stringify(await snap()));
await p.keyboard.press('Space');
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(700);
  const s = await snap();
  console.log(
    `${String(i * 700).padStart(4)}ms phys=${JSON.stringify(s.phys)} actorAnim=${s.actorAnim} clips=${JSON.stringify(s.clips)}`,
  );
}
await b.close();
