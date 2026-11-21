// 校验 P1–P10 的 driver 字段是否真的是真控制器（防止用简化驱动冒充 M4 通过）。
import { runVerify } from '../src/verify/harness.ts';

const r = await runVerify({ only: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'] });
let bad = 0;
for (const c of r.cases) {
  const d = String(c.detail['driver'] ?? '(missing)');
  const ok = d === 'm4-character-controller';
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${c.id.padEnd(4)} driver=${d}`);
}
console.log(bad === 0 ? '\n全部使用真控制器 m4-character-controller' : `\n${bad} 条不是真控制器`);
process.exit(bad === 0 ? 0 : 1);
