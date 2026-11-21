/**
 * `esbuild` 的纯 JS 替身（只在本机沙箱用）。
 *
 * 为什么需要：esbuild 的 Node API 靠 spawn 一个子进程 + **管道 stdio** 通信。
 * 本机 DSH 沙箱禁止管道 stdio，任何走 esbuild 的路径（vite 的 TS 转译、
 * HTML 的 define 替换、minify）都会 EPERM。
 *
 * 这个替身只实现 Vite 生产构建真正用到的那一小块：
 * - `transform(code, {loader, define, minify, target, sourcemap, sourcefile})`
 *   → 用 Node 22 的 `stripTypeScriptTypes` 剥类型，按 `define` 做字面量替换；
 * - `version` / `formatMessages` / `transformSync` 的最小形状。
 *
 * **不做**：bundle、tree-shaking、语法降级、真正的 minify。
 * 所以它只能用来"在本机量出产物体积"，不能当生产构建工具。
 * 正常机器上删掉 scripts/sandbox-esbuild-loader.mjs 的挂载即可，零影响。
 */

import { stripTypeScriptTypes } from 'node:module';

export const version = '0.0.0-sandbox-shim';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按 define 表做整词替换。只处理 Vite 传进来的那种「键 → 字面量字符串」。 */
function applyDefines(code, define) {
  if (!define || typeof define !== 'object') return code;
  let out = code;
  // 长的键先替换，避免 `import.meta.env` 抢先吃掉 `import.meta.env.DEV`
  const keys = Object.keys(define).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const value = define[key];
    if (typeof value !== 'string') continue;
    const re = new RegExp(`(?<![\\w$.])${escapeRe(key)}(?![\\w$])`, 'g');
    out = out.replace(re, value);
  }
  return out;
}

function stripIfTs(code, loader) {
  if (loader === 'ts' || loader === 'tsx' || loader === 'mts' || loader === 'cts') {
    return stripTypeScriptTypes(code, { mode: 'strip', sourceMap: false });
  }
  return code;
}

export async function transform(code, options = {}) {
  const loader = options.loader ?? 'js';
  let out = stripIfTs(String(code), loader);
  out = applyDefines(out, options.define);

  // 不实现真正的 minify：调用方应改用 terser（vite.config.sandbox.mjs 里已配）
  if (options.minify) {
    throw new Error('sandbox esbuild shim 不支持 minify，请用 terser');
  }

  return {
    code: out,
    // ⚠ 必须是**合法 JSON 字符串**，不能是空字符串：
    // Vite 的 transformWithEsbuild 会无条件 `JSON.parse(result.map)`，
    // 空串会抛 "Unexpected end of JSON input"（表现为 dev server 对该模块返回 500）。
    // esbuild 真实在不开 sourcemap 时返回的是空串，但 Vite 的调用路径假设它可解析，
    // 所以这里给一个最小合法 sourcemap。
    map: options.sourcemap ? minimalSourceMap(options.sourcefile ?? 'input', out) : minimalSourceMap(options.sourcefile ?? 'input', out),
    warnings: [],
  };
}

/** 最小合法 sourcemap（无 mappings，仅满足 JSON.parse 与下游形状检查）。 */
function minimalSourceMap(sourcefile, code) {
  return JSON.stringify({
    version: 3,
    sources: [sourcefile],
    sourcesContent: [String(code)],
    names: [],
    mappings: '',
  });
}

export function transformSync(code, options) {
  const loader = (options && options.loader) || 'js';
  let out = stripIfTs(String(code), loader);
  out = applyDefines(out, options && options.define);
  return {
    code: out,
    map: minimalSourceMap((options && options.sourcefile) ?? 'input', out),
    warnings: [],
  };
}

export async function formatMessages(messages) {
  return (messages || []).map((m) => `${m.text ?? m}`);
}

export async function build() {
  throw new Error('sandbox esbuild shim 不支持 build（bundle 由 rollup 负责）');
}

/**
 * Vite 的依赖预扫描（dev 模式）会调 `context()` + `rebuild()` 去扫 import。
 * 真正的扫描靠 esbuild 的 bundler；这里给一个**空扫描**的桩：
 * 返回空 metafile 等于"没有需要预打包的依赖"。
 *
 * 后果：dev 模式下不做依赖预打包，three 会被按需逐个 ESM 文件请求（慢一点，但能跑）。
 * 生产构建走 rollup，不受影响。这仍然只是沙箱兜底，正常机器不需要。
 */
export function context() {
  return Promise.resolve({
    async rebuild() {
      return { metafile: { inputs: {}, outputs: {} }, errors: [], warnings: [] };
    },
    async watch() {
      return { stop() {} };
    },
    async cancel() {},
    async dispose() {},
  });
}

export default { transform, transformSync, formatMessages, build, context, version };
