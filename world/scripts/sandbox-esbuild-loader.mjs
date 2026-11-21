/**
 * 把 `esbuild` 重定向到纯 JS 替身的 loader（只在本机沙箱用）。
 *
 * 用法：`node --import ./scripts/sandbox-esbuild-loader.mjs <script>`
 * 不挂这个 loader 时行为完全不变（正常机器/CI 不需要它）。
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = pathToFileURL(join(HERE, 'sandbox-esbuild-shim.mjs')).href;

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'esbuild') {
        return { url: ${JSON.stringify(SHIM)}, shortCircuit: true };
      }
      return next(specifier, context);
    }
  `)}`,
  import.meta.url,
);

// 顺带把 Vite 在 Windows 上的 `net use` 探测与 spawn 报错提示也接上
await import('./sandbox-preload.mjs');
