// 直接数场景里的对象，判断 6 个 avatar 到底有没有被加进场景。
// drawCalls:0 可能是统计没刷新，不能据此断定"没渲染"。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/';

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__worldDebug === 'object' && window.__worldDebug !== null, { timeout: 30000 });
await page.waitForTimeout(5000);

// 遍历场景统计（通过调试口暴露的 renderer 或全局 three 对象）
const stats = await page.evaluate(() => {
  const out = { skinned: 0, meshes: 0, groups: 0, named: [] };
  // __worldDebug 可能有 scene 或 renderer 引用
  const d = window.__worldDebug;
  const scene = d?.scene ?? d?.renderer?.scene ?? null;
  if (!scene) return { error: 'scene not exposed via __worldDebug', keys: d ? Object.keys(d) : null };
  scene.traverse((o) => {
    if (o.isSkinnedMesh) out.skinned++;
    else if (o.isMesh) out.meshes++;
    if (o.type === 'Group') out.groups++;
    if (o.name && out.named.length < 30) out.named.push(o.name);
  });
  return out;
});

console.log(JSON.stringify({ stats, pageErrors: errors.slice(0, 5) }, null, 2));
await browser.close();
process.exit(0);
