#!/usr/bin/env node
/**
 * M11 验收（spec §6 M11 最后一条）：**生产构建里不存在调试面板的代码**。
 *
 * 为什么必须对着**产物**断言，而不是写个单测 import 一下：
 * `src/render/debug.test.ts` 能 import 到 `debug.ts`，那只证明"文件存在"，
 * 证明不了"它会被摇掉"——恰恰相反，能被 import 到说明模块还在。
 * tree-shake 的结果只存在于 `dist/` 里，所以只能 grep 产物。
 *
 * 判定方法（三重，缺一不可）：
 * 1. **正向 marker**：`DEBUG_PANEL_MARKER`（`__AIO_DEBUG_PANEL__`）在所有产物里
 *    出现 0 次。这个字符串只存在于 `debug.ts`，出现即说明模块进了包。
 * 2. **负向守卫**：`debug.ts` 里的独有标识（DOM id、`__aioDebug` 全局、面板文案）
 *    也都是 0 次。marker 是单一字符串，万一被压缩器重排了会漏；多抓几个更稳。
 * 3. **对照片段**：同样的 grep 在 **dev 构建** 里必须**能找到** marker。
 *    没有这一步，上面的"0 次"可能只是因为路径写错/产物目录空——
 *    那是假绿。这一条把"grep 方法本身有效"也验了。
 *
 * 用法：
 *   node tools/verify-debug-treeshake.mjs            # 自己 build 两份产物再比
 *   node tools/verify-debug-treeshake.mjs --no-build # 只用已有的 dist/ 与 dist-debug/
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = resolve(HERE, '..');
const NO_BUILD = process.argv.includes('--no-build');

/**
 * 面板在产物里留下的指纹。
 *
 * 每一条都必须是**只在 debug.ts 里出现**的字符串：
 * 若某条也出现在 main.ts 或别处，"生产里 0 次"就说明不了任何问题
 * （main.ts 的代码本来就在产物里）。所以改这些字符串时要同步检查唯一性。
 *
 * 也别挑模板字符串里的**静态前缀**（比如 `近 ${N} 帧` 里的 "近 帧"）——
 * 拼接后的字面量在产物里是分开的片段，grep 找不到，会让对照组假失败。
 * 这里全挑完整字面量。
 */
const FINGERPRINTS = [
  '__AIO_DEBUG_PANEL__', // DEBUG_PANEL_MARKER 的值
  'aio-debug-panel', // 面板 DOM id
  '__aioDebug', // 面板的 window 调试口
  '物理线框', // 面板文案（toggles 行）
  '三角面', // 面板文案（drawCall/三角面 行）
  'installDebugPanel', // 接线函数名（未压缩时保留）
];

/** 递归列出目录下所有文本类产物。 */
function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (['.js', '.mjs', '.html', '.css'].includes(extname(p))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 在每个文件里找每条指纹，返回 { fingerprint -> [相对路径...] }。 */
function scan(dir) {
  const hits = new Map(FINGERPRINTS.map((f) => [f, []]));
  for (const file of listFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const fp of FINGERPRINTS) {
      if (text.includes(fp)) hits.get(fp).push(file.slice(dir.length + 1));
    }
  }
  return hits;
}

function build(mode, outDir) {
  console.log(`构建 mode=${mode} → ${outDir}`);
  const env = { ...process.env };
  // Windows 上 esbuild 有时因系统临时目录权限失败（Access is denied），
  // 把 TEMP/TMP 指到工作区内就没问题。只在未显式设置时兜底。
  const tmp = join(WORLD_ROOT, 'tmp', 'esbtmp');
  env.TEMP = tmp;
  env.TMP = tmp;
  // 直接调 vite 的 JS 入口，不经过 npx：
  // Windows 上 spawnSync("npx.cmd", …) 会 EINVAL（Node 的 .cmd 处理限制）。
  const viteBin = join(WORLD_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(
    process.execPath,
    [viteBin, 'build', '--mode', mode, '--outDir', outDir, '--emptyOutDir'],
    { cwd: WORLD_ROOT, stdio: 'pipe', env },
  );
}

const PROD_DIR = join(WORLD_ROOT, 'dist');
const DEBUG_DIR = join(WORLD_ROOT, 'dist-debug');

if (!NO_BUILD) {
  try {
    build('production', 'dist');
    build('debug', 'dist-debug');
  } catch (err) {
    console.error('构建失败：');
    console.error(err instanceof Error ? err.message : String(err));
    if (err && typeof err === 'object' && 'stderr' in err) {
      console.error(String(err.stderr).slice(0, 3000));
    }
    process.exit(2);
  }
} else if (!existsSync(PROD_DIR) || !existsSync(DEBUG_DIR)) {
  console.error('--no-build 需要 dist/ 与 dist-debug/ 都已存在');
  process.exit(2);
}

console.log('');
console.log('M11 验收：调试面板在生产构建里必须不存在');
console.log('─'.repeat(64));

// ── 1. 生产构建：一条都不许出现 ──
const prodHits = scan(PROD_DIR);
const prodFiles = listFiles(PROD_DIR);
let leaked = 0;

for (const [fp, files] of prodHits) {
  const ok = files.length === 0;
  if (!ok) leaked += 1;
  console.log(
    `${ok ? '✓' : '✗'} 生产产物里 "${fp}" ${ok ? '不存在' : `出现在 ${files.join(', ')}`}`,
  );
}
console.log(`  扫描了 ${prodFiles.length} 个产物文件`);

// ── 2. 对照：debug 构建里必须能找到（证明 grep 方法本身有效） ──
console.log('');
const debugHits = scan(DEBUG_DIR);
const debugFiles = listFiles(DEBUG_DIR);
let controlOk = 0;

for (const [fp, files] of debugHits) {
  const found = files.length > 0;
  if (found) controlOk += 1;
  console.log(
    `${found ? '✓' : '✗'} 对照（mode=debug）里 "${fp}" ${found ? `找到（${files[0]}）` : '找不到 —— grep 方法无效'}`,
  );
}
console.log(`  扫描了 ${debugFiles.length} 个产物文件`);

// ── 判定 ──
console.log('');
console.log('─'.repeat(64));

// 对照至少要命中 marker 与 DOM id 这两条：少了说明"0 次"不可信
const controlRequired = ['__AIO_DEBUG_PANEL__', 'aio-debug-panel'];
const controlPassed = controlRequired.every((fp) => (debugHits.get(fp) ?? []).length > 0);

if (!controlPassed) {
  console.log('✗ 对照组失败：debug 构建里都找不到面板指纹，说明 grep 路径/产物有问题。');
  console.log('  这时"生产里不存在"不能算通过——那是假绿。');
  process.exit(1);
}

if (leaked > 0) {
  console.log(`✗ 调试面板泄漏进生产构建：${leaked} 条指纹出现。`);
  console.log('  常见原因：main.ts 的守卫写成了运行时条件（读 location 再 import），');
  console.log('  或 debug.ts 里有模块顶层副作用，Rollup 不敢删。');
  process.exit(1);
}

console.log(
  `全部通过：生产 0/${FINGERPRINTS.length} 条指纹泄漏，对照 mode=debug 命中 ${controlOk}/${FINGERPRINTS.length}`,
);
