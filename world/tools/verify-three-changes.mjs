// 三项改动的一次性验收：
//   1. 贴图分级（1024/1024/512）是否真的生效，特写是否清晰
//   2. Agent 默认 0，?agents=6 能恢复
//   3. 相机特写模式 ?cam=face 是否对准脸
//
// 用真实浏览器 + 截图，因为这三项全都是"只能看出来"的东西。
import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { statSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
    return !gl || !gl.isContextLost();
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(5000);
  return { page, errs };
}

// ── 1. 默认（无参数）：只有玩家，没有 Agent ──
{
  const { page, errs } = await open(BASE);
  const r = await page.evaluate(() => window.__worldDebug.read());
  await page.mouse.click(500, 700);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'tmp/final-default.png' });
  console.log(`[默认] avatarCount=${r.avatarCount} agentCount=${r.agentCount} drawCalls=${r.drawCalls} triangles=${r.triangles} errors=${errs.length}`);
  console.log(`        期望 agentCount=0 → ${r.agentCount === 0 ? '✅' : '❌'}`);
  await page.close();
}

// ── 2. ?agents=6 恢复 ──
{
  const { page, errs } = await open(`${BASE}?agents=6`);
  const r = await page.evaluate(() => window.__worldDebug.read());
  console.log(`[?agents=6] avatarCount=${r.avatarCount} agentCount=${r.agentCount} drawCalls=${r.drawCalls} errors=${errs.length}`);
  console.log(`        期望 agentCount=6 → ${r.agentCount === 6 ? '✅' : '❌'}`);
  await page.close();
}

// ── 3. ?cam=face 特写 ──
{
  const { page, errs } = await open(`${BASE}?cam=face`);
  await page.mouse.click(500, 700);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'tmp/final-face.png' });
  const cam = await page.evaluate(() => window.__worldDebug.read().camera);
  console.log(`[?cam=face] camera=${JSON.stringify(cam)} errors=${errs.length}`);
  console.log(`        期望 distance≈0.75 → ${Math.abs(cam.distance - 0.75) < 0.1 ? '✅' : '❌'}`);
  await page.close();
}

// ── 4. 特写 + 近距（验证贴图清晰度）──
{
  const { page } = await open(`${BASE}?cam=face&agents=0`);
  await page.mouse.click(500, 700);
  await page.evaluate(() => window.__worldDebug.setDistance(0.55));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tmp/final-face-close.png' });
  const kb = Math.round(statSync('tmp/final-face-close.png').size / 1024);
  console.log(`[最近特写 0.55m] 截图 ${kb}KB → tmp/final-face-close.png`);
  await page.close();
}

await browser.close();
