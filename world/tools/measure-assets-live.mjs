// M2 验收的浏览器内实测：3 个染色变体同屏时 geometries 是否线性增长。
// 这条只能在真浏览器里量（renderer.info.memory 是 WebGL 运行时统计），
// render-agent 的会话起不了浏览器，所以由 lead 跑一次把数字回填。
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

// 等调试口出现（dev 构建才有）
await page.waitForFunction(() => typeof window.__worldAssets === 'object' && window.__worldAssets !== null, { timeout: 30000 });

const result = await page.evaluate(async () => {
  const probe = window.__worldAssets;
  const out = {};
  out.measure = await probe.measure();
  return out;
});

console.log(JSON.stringify({ assets: result.measure, pageErrors: errors.slice(0, 5) }, null, 2));

await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
