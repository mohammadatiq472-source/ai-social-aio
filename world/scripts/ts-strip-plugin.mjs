/**
 * 无 esbuild 的 TS 转译插件（沙箱兜底；正常机器不需要它）。
 *
 * 为什么需要它：
 * esbuild 的 JS API 会 spawn 一个子进程、用**管道 stdio** 通信。
 * 本机 DSH 沙箱禁止管道 stdio（`spawn` 默认 stdio 直接 EPERM），
 * 于是 vite/vitest 一加载就挂在 `ensureServiceIsRunning`。
 *
 * 替代方案：用 Node 22 内置的 `module.stripTypeScriptTypes()` 在**进程内**剥类型。
 * 它正是 `node --experimental-strip-types` 用的那套实现，前提是代码符合
 * 「无 enum / 无 namespace / 无参数属性 / 显式 `import type`」——
 * 本仓库 tsconfig 已开 `verbatimModuleSyntax` + `isolatedModules`，正好满足。
 *
 * 注意：这个文件必须是**纯 JS**（不能有 `as const` 之类），
 * 否则 `--configLoader native` 下 Node 会当普通 ESM 解析而报语法错。
 */

import { stripTypeScriptTypes } from 'node:module';

/** Vite/Rollup 插件：拦截 .ts/.tsx，进程内剥类型。 */
export function tsStripPlugin() {
  return {
    name: 'aio-world:ts-strip',
    enforce: 'pre',
    transform(code, id) {
      const clean = id.split('?')[0] ?? id;
      if (!/\.(?:ts|tsx|mts|cts)$/.test(clean)) return null;
      // 声明文件不需要转译
      if (/\.d\.ts$/.test(clean)) return null;

      try {
        const out = stripTypeScriptTypes(code, { mode: 'strip', sourceMap: false });
        return { code: out, map: null };
      } catch (err) {
        // strip 模式不支持参数属性（constructor(private x)）、enum、namespace。
        // 这些在 Vite 的 esbuild 链路里是合法的，所以退回 transform 模式
        // （它会真正改写语法，而不只是删类型）。
        if (String(err?.code ?? '').includes('UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
          const out = stripTypeScriptTypes(code, { mode: 'transform', sourceMap: false });
          return { code: out, map: null };
        }
        throw err;
      }
    },
  };
}
