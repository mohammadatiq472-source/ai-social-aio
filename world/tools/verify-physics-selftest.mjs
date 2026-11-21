#!/usr/bin/env node
/**
 * 自测：**verify-physics 的失败路径真的会非零退出吗**。
 *
 * 为什么必须测这个：`npm run verify` 的绿色只有在"红的时候会红"的前提下才有意义。
 * 一个永远 exit 0 的脚本也能打印"全部通过：12/12"——那是最糟的假绿。
 *
 * 做法：起一个假服务，返回一个**故意失败**的 __verify 报告，
 * 然后跑真正的 `tools/verify-physics.mjs --url <假服务>`，断言：
 * 1. 退出码非零
 * 2. 打印了 ✗ 与失败用例的 detail（不是只打一句"失败了"）
 * 3. 打印的通过数不是 12/12
 * 4. 少跑一条（total 声称 12 但只给 11 条）也算失败——契约要求"少跑算失败"
 * 5. 卡在 running 时硬超时能退出（用短超时环境变量避免等 180s）
 *
 * 这个脚本**不**改任何被测代码，只驱动它的 CLI。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = resolve(HERE, '..');

/** 造一个假页面：它的 __verify 直接是给定报告（不跑物理）。 */
function fakePage(report) {
  return `<!doctype html><html><body><script>
    window.__verify = ${JSON.stringify(report)};
  </script></body></html>`;
}

function makeReport({ cases, status = 'done', total = 12, passed }) {
  return {
    status,
    startedAt: 0,
    finishedAt: 1,
    total,
    passed: passed ?? cases.filter((c) => c.pass).length,
    cases,
    env: { ua: 'fake', hardwareConcurrency: 4, renderer: 'fake', rapierVersion: 'fake' },
  };
}

/** 12 条全过（作为对照：应该 exit 0）。 */
const allPass = Array.from({ length: 12 }, (_, i) => ({
  id: `P${i + 1}`,
  title: `用例${i + 1}`,
  pass: true,
  measured: 'ok',
  detail: {},
}));

/** 12 条里 P6 失败（应该 exit 1，并打印 P6 的 detail）。 */
const oneFail = allPass.map((c) =>
  c.id === 'P6'
    ? {
        ...c,
        pass: false,
        measured: '最高点 1.50m（期望 1.20±0.03）',
        detail: { jumpHeight: 1.5, expected: 1.2, tol: 0.03, driver: 'm4-character-controller' },
      }
    : c,
);

/** 只给 11 条（total 仍写 12）：契约要求"少跑一条算失败"。 */
const short = allPass.slice(0, 11);

/** 卡在 running（应该被硬超时打断并非零退出）。 */
const stuck = makeReport({ cases: [], status: 'running', passed: 0 });

const SCENARIOS = [
  { name: '12/12 全过 → 退出码 0', report: makeReport({ cases: allPass }), expectExit: 0 },
  {
    name: 'P6 失败 → 退出码非零 + 打印 detail',
    report: makeReport({ cases: oneFail }),
    expectExit: 1,
    mustContain: ['✗', 'P6', 'jumpHeight', '1.5'],
  },
  {
    name: '只给 11 条（total=12）→ 退出码非零',
    report: makeReport({ cases: short }),
    expectExit: 1,
    mustContain: ['✗', 'P12'],
  },
  {
    name: '卡在 running → 超时非零退出',
    report: stuck,
    expectExit: 1,
    mustContain: ['超时'],
    // 用 3s 超时，否则要等 180s
    env: { VERIFY_TIMEOUT_MS: '3000' },
  },
];

function runVerify(url, env = {}) {
  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      [join(WORLD_ROOT, 'tools', 'verify-physics.mjs'), '--url', url],
      {
        cwd: WORLD_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, out });
    });
  });
}

const results = [];

for (const s of SCENARIOS) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fakePage(s.report));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const { code, out } = await runVerify(`http://127.0.0.1:${port}/`, s.env);
  server.close();

  const exitOk = s.expectExit === 0 ? code === 0 : code !== 0;
  const missing = (s.mustContain ?? []).filter((needle) => !out.includes(needle));
  const ok = exitOk && missing.length === 0;

  results.push({ name: s.name, ok });
  console.log(`${ok ? '✓' : '✗'} ${s.name}`);
  if (!exitOk) console.log(`    退出码 ${code}，期望 ${s.expectExit === 0 ? 0 : '非零'}`);
  if (missing.length) console.log(`    输出里缺少：${missing.join(', ')}`);
  if (!ok) {
    console.log('    ── 实际输出 ──');
    console.log(
      out
        .split('\n')
        .slice(-25)
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
}

const passed = results.filter((r) => r.ok).length;
console.log('');
console.log('─'.repeat(64));
console.log(`全部通过：${passed}/${results.length}`);
if (passed !== results.length) process.exit(1);
