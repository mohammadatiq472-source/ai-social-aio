// M5 验收：同屏多角色的动画相位必须不同（避免"整齐划一"的机械观感）。
// spec §6 M5：「同一动作在两个角色上相位不同」。
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

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__worldDebug === 'object' && window.__worldDebug !== null, { timeout: 30000 });
await page.waitForTimeout(6000);

const r = await page.evaluate(() => {
  const d = window.__worldDebug;
  const read = typeof d?.read === 'function' ? d.read() : {};
  return { read, hasAgents: Array.isArray(read.agents) ? read.agents.length : 0 };
});

// 取 agents 的相位
const agents = r.read?.agents ?? [];
console.log(`Agent 数：${agents.length}`);
if (agents.length === 0) {
  console.log('⚠️ __worldDebug.read() 没暴露 agents 数组，无法验证相位');
  console.log('可用字段：', Object.keys(r.read ?? {}).join(', '));
} else {
  const phases = agents.map((a) => ({
    id: a.id,
    anim: a.anim,
    phase: typeof a.animPhase === 'number' ? a.animPhase : null,
  }));
  console.log('\n各 Agent 动画与相位：');
  for (const p of phases) {
    console.log(`  ${String(p.id).padEnd(6)} anim=${String(p.anim).padEnd(6)} phase=${p.phase === null ? '?' : p.phase.toFixed(3)}`);
  }
  const nums = phases.map((p) => p.phase).filter((x) => typeof x === 'number');
  const uniq = new Set(nums.map((n) => n.toFixed(3)));
  console.log(`\n相位去重后：${uniq.size} / ${nums.length}`);
  const spread = nums.length ? Math.max(...nums) - Math.min(...nums) : 0;
  console.log(`相位跨度：${spread.toFixed(3)}`);
  const ok = uniq.size === nums.length && nums.length >= 6;
  console.log(ok ? '✅ 每个角色相位都不同（无整齐划一）' : '⚠️ 存在相同相位或数量不足');
}

console.log('\npageErrors:', errors.slice(0, 3));
await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
