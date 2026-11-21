// 一次性探针：在 node 里直接跑 verify harness，看 P1–P12 的真实状态。
// 为什么要有：`npm run verify` 的浏览器链路（tools/verify-physics.mjs）还归 qa-agent，
// 但物理用例本身能不能过，现在就要知道，不能等到 M12。
import { runVerify } from '../src/verify/harness.ts';

const report = await runVerify();
console.log(`status=${report.status} passed=${report.passed}/${report.total}\n`);
for (const c of report.cases) {
  const mark = c.pass ? '✓' : '✗';
  const skipped = c.detail && c.detail['skipped'] ? ' [SKIP]' : '';
  console.log(`${mark} ${c.id.padEnd(4)} ${c.title.padEnd(24)} ${c.measured}${skipped}`);
  if (!c.pass && c.error) console.log(`     error: ${c.error}`);
}
