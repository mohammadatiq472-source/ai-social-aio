/**
 * 让 Node 直接跑 src/ 下的 TS（tools/ 里的独立脚本用）。
 *
 * 三件事：
 * 1. 无扩展名相对导入补 `.ts`（Vite 风格，Node ESM 默认要求写全）；
 * 2. 用 `module.stripTypeScriptTypes` 在进程内剥类型（不需要 esbuild）；
 * 3. **strip 失败时降级到 transform 模式**。
 *
 * 为什么第 3 步必须有：
 * `mode:'strip'` 只删类型、不改语法，所以不支持 TS 的「参数属性」
 * （`constructor(private readonly world: X)`）、`enum`、`namespace`。
 * 物理层的 `PhysicsWorld` 正好用了参数属性，于是任何 import 物理层的 tools 脚本
 * 都会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` —— 而那个报错信息完全没提
 * "你需要换个 loader"，排查成本很高。
 * 降级到 `mode:'transform'` 会真正改写语法，等价于 esbuild 的行为。
 *
 * 用法：node --import ./scripts/ts-node-loader.mjs tools/xxx.mjs
 */

import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
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
          // 参数属性 / enum / namespace 等 strip 模式不支持的语法，降级到 transform
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
