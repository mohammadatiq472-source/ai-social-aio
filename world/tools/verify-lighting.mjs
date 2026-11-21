// 四种时间/天气氛围的浏览器验收：截图 + 亮度/色调实测。
//
// 为什么必须截图：光照"对不对"只能看。数字只能证明"参数生效了"，
// 不能证明"看起来像黄昏"。两者都要。
import { chromiumLaunchOptions } from './chromium.mjs';
import { chromium } from '@playwright/test';
import { statSync } from 'node:fs';
import sharp from 'sharp';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5199/';
const PRESETS = ['day', 'dusk', 'night', 'storm'];

const browser = await chromium.launch(chromiumLaunchOptions());

async function shoot(key) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(`${BASE}?time=${key}&cam=face`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
      return !gl || !gl.isContextLost();
    },
    { timeout: 15000 },
  ).catch(() => {});
  await page.waitForTimeout(5000);
  await page.mouse.click(400, 600);
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => window.__worldDebug.lightingState());
  const f = `tmp/light-${key}.png`;
  await page.screenshot({ path: f });
  await page.close();
  return { f, kb: Math.round(statSync(f).size / 1024), state, errs };
}

/** 采样画面平均亮度与色调（判断"夜"是否真的更暗、"黄昏"是否真的偏暖）。 */
async function analyze(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  // 只看角色区域（避开左上角调试面板）
  for (let y = 250; y < info.height - 40; y += 4) {
    for (let x = 150; x < info.width - 100; x += 4) {
      const i = (y * info.width + x) * info.channels;
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      sum += R * 0.299 + G * 0.587 + B * 0.114;
      r += R;
      g += G;
      b += B;
      n++;
    }
  }
  return {
    luma: +(sum / n).toFixed(1),
    r: +(r / n).toFixed(1),
    g: +(g / n).toFixed(1),
    b: +(b / n).toFixed(1),
  };
}

const results = [];
for (const key of PRESETS) {
  const s = await shoot(key);
  const a = await analyze(s.f);
  // 冷暖：R-B 越大越暖
  const warmth = +(a.r - a.b).toFixed(1);
  results.push({ key, ...a, warmth, state: s.state, errs: s.errs.length, file: s.f });
  console.log(
    `${key.padEnd(6)} 亮度 ${String(a.luma).padStart(5)}  RGB(${a.r},${a.g},${a.b})  暖度 ${String(warmth).padStart(6)}  过渡状态 ${JSON.stringify(s.state)}  错误 ${s.errs.length}`,
  );
}

// 断言：夜比白天暗、黄昏比白天暖、暴雨比白天暗且饱和度低
const day = results.find((r) => r.key === 'day');
const night = results.find((r) => r.key === 'night');
const dusk = results.find((r) => r.key === 'dusk');
const storm = results.find((r) => r.key === 'storm');

console.log('\n=== 断言 ===');
const checks = [
  ['夜晚比白天暗', night.luma < day.luma],
  ['黄昏比白天暖（R-B 更大）', dusk.warmth > day.warmth],
  ['暴雨比白天暗', storm.luma < day.luma],
  ['夜晚是最暗的', night.luma === Math.min(day.luma, dusk.luma, night.luma, storm.luma)],
  ['四个预设都无 JS 错误', results.every((r) => r.errs === 0)],
  ['每个预设的 state.current 正确', results.every((r) => r.state.current === r.key)],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (ok) pass++;
}
console.log(`\n全部通过：${pass}/${checks.length}`);
console.log(`截图：${results.map((r) => r.file).join('  ')}`);

await browser.close();
process.exit(pass === checks.length ? 0 : 1);
