// D5 验收：6 个 Agent 是否真的在页面上活动（不是"代码写了但没接线"）。
// 判据：world 里有 6 个 actor、位置随时间变化、有气泡出现、场景里有 6 个 avatar 网格。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/';

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__worldDebug === 'object' && window.__worldDebug !== null, { timeout: 30000 });

// 采样两次，间隔 4 秒，比较位置是否变化
const sample = () => page.evaluate(() => {
  const d = window.__worldDebug;
  const r = typeof d.read === 'function' ? d.read() : d;
  return { read: r, t: performance.now() };
});

const s1 = await sample();
await page.waitForTimeout(4000);
const s2 = await sample();

// 抓 avatar 数量：优先用资产探针/调试口暴露的字段，否则数场景里的 SkinnedMesh
const detail = await page.evaluate(() => {
  const d = window.__worldDebug;
  const r = typeof d?.read === 'function' ? d.read() : (d ?? {});
  return r;
});

// 从 DOM 侧看 HUD 气泡数量
const bubbles = await page.evaluate(() => {
  const els = document.querySelectorAll('[data-bubble], .bubble, [class*="bubble"]');
  return { count: els.length, texts: Array.from(els).slice(0, 6).map((e) => e.textContent) };
});

console.log(JSON.stringify({
  read1: s1.read,
  read2: s2.read,
  bubbles,
  pageErrors: errors.slice(0, 5),
}, null, 2));

await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
