/**
 * 沙箱内的进程内测试运行器（只在本机 DSH 沙箱用；CI 走 `npm run test` / Vitest）。
 *
 * 为什么需要它：
 * esbuild 的 JS API 会 spawn 子进程并用**管道 stdio** 通信。本机沙箱禁止管道 stdio
 * （spawn 默认 stdio 直接 EPERM），所以 `vitest` 一加载就在 ensureServiceIsRunning 挂掉。
 *
 * 它做的事很有限，**不替代** Vitest：
 * - 用 Node 22 内置的 `module.stripTypeScriptTypes` 剥类型（不引入新工具链）；
 * - 提供 describe / it / expect 的最小实现，覆盖本仓库实际用到的 matcher；
 * - 跑的就是 src/**\/*.test.ts 那批**同一份文件**，断言是同一批断言。
 *
 * 它不是"让测试通过"的捷径：断言失败照样非零退出。
 * 但它确实不等价于 Vitest（没有 vi.mock、没有快照、没有并发隔离），
 * 所以 CI 里必须是 Vitest，这个脚本只用来在本机取数。
 *
 * ⚠️ 必须带 `--expose-gc` 运行（package.json 的 test:sandbox 已带）：
 * P12 的内存用例靠 `globalThis.gc` 在测量前后各清一次垃圾，
 * 没有这个标志时 `tryGc()` 返回 false、垃圾堆着不回收，
 * 会让 P12 误报堆增长超标（实测 461KB vs 真实值）。这是测量工具的锅，不是物理的。
 */

import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ───────────────────────────── loader hooks ─────────────────────────────

const SHIM_URL = pathToFileURL(join(HERE, 'vitest-shim.mjs')).href;

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'vitest') return { url: ${JSON.stringify(SHIM_URL)}, shortCircuit: true };
      // 本仓库用无扩展名的相对导入（Vite 风格），Node ESM 需要补 .ts
      if (specifier.startsWith('.') && !/\\.(m?[jt]s|json)$/.test(specifier)) {
        try { return await next(specifier + '.ts', context); } catch {}
        try { return await next(specifier + '/index.ts', context); } catch {}
      }
      return next(specifier, context);
    }
    export async function load(url, context, next) {
      if (url.endsWith('.ts')) {
        const { readFile } = await import('node:fs/promises');
        const { stripTypeScriptTypes } = await import('node:module');
        const src = await readFile(new URL(url), 'utf8');
        let out;
        try {
          out = stripTypeScriptTypes(src, { mode: 'strip' });
        } catch (err) {
          // strip 模式不支持参数属性（constructor(private x)）、enum、namespace。
          // 这些在 Vitest 的 esbuild 链路里合法，所以退回 transform 模式。
          if (String(err && err.code).includes('UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
            out = stripTypeScriptTypes(src, { mode: 'transform' });
          } else {
            throw err;
          }
        }
        return { format: 'module', source: out, shortCircuit: true };
      }
      return next(url, context);
    }
  `)}`,
  import.meta.url,
);

// ───────────────────────────── 发现测试文件 ─────────────────────────────

function findTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findTests(p));
    else if (name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = findTests(join(ROOT, 'src')).sort();
const filter = process.argv[2];
const selected = filter ? files.filter((f) => f.includes(filter)) : files;

// ───────────────────────────── 运行 ─────────────────────────────

const results = { pass: 0, fail: 0, failures: [], suites: 0, skipped: 0 };

const g = globalThis;
g.__runner = {
  onPass() {
    results.pass += 1;
  },
  onFail(name, err) {
    results.fail += 1;
    results.failures.push({ name, err });
  },
  onSuite() {
    results.suites += 1;
  },
  onSkip() {
    results.skipped += 1;
  },
};

console.log(`进程内测试运行器（非 Vitest，仅本机取数）`);
console.log(`测试文件 ${selected.length} 个\n`);

// 每个文件独立跑 beforeAll → 用例 → afterAll，避免跨文件的状态泄漏
const shim = await import(pathToFileURL(join(HERE, 'vitest-shim.mjs')).href);

for (const file of selected) {
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
  try {
    await import(pathToFileURL(file).href);
    await shim.__runBeforeAll();
    await shim.__runCollected();
    await shim.__runAfterAll();
  } catch (err) {
    results.fail += 1;
    results.failures.push({ name: `${rel}（模块加载/钩子失败）`, err });
  }
}

console.log('');
for (const f of results.failures) {
  console.error(`✗ ${f.name}`);
  console.error(`   ${String(f.err && f.err.message ? f.err.message : f.err).split('\n')[0]}`);
  console.error('');
}

const total = results.pass + results.fail;
console.log(`测试：${results.pass} passed / ${results.fail} failed（共 ${total}，${results.suites} 个 describe）`);

process.exit(results.fail === 0 ? 0 : 1);
