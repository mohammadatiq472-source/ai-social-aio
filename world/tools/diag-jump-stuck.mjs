// 追踪跳跃后 anim 与 playingClips 的逐帧变化，定位卡死点。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });

await page.goto(`${BASE}?time=day`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__agentDebug === 'object', { timeout: 30000 });
await page.waitForTimeout(9000);
await page.mouse.click(400, 600);
await page.waitForTimeout(300);

const snap = () =>
  page.evaluate(() => ({
    clips: window.__worldDebug.heroPlayingClips(),
    anim: window.__agentDebug.read().hero?.anim,
    grounded: window.__agentDebug.read().hero?.grounded,
    posY: window.__agentDebug.read().hero?.pos?.[1],
  }));

console.log('跳前:', JSON.stringify(await snap()));

await page.keyboard.press('Space');
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(700);
  const s = await snap();
  console.log(
    `${String(i * 700).padStart(5)}ms  anim=${String(s.anim).padEnd(5)} grounded=${String(s.grounded).padEnd(5)} y=${s.posY?.toFixed(2)}  clips=${JSON.stringify(s.clips)}`,
  );
}

await browser.close();
