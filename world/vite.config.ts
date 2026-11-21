import { defineConfig, type Plugin } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 把仓库根的 `assets/` 拷进 `dist/assets/`。
 *
 * 为什么不能用 `publicDir: 'assets'`：那会把 `assets/characters/x.glb`
 * 摊平到 `dist/characters/x.glb`，而 registry.ts 里的 URL 是
 * `assets/characters/x.glb`（带 `assets/` 前缀）→ 线上 404。
 * 所以必须保留 `assets/` 这一层目录，用显式拷贝最可控。
 *
 * 为什么必须拷：registry 里的 `url` 是**普通字符串**，不是 `import` 的模块依赖，
 * Vite 不会把它当资产处理。不拷的话构建产物里没有 glb，dev 能跑（直读磁盘）、
 * 部署后角色全 404 —— 这个坑只在线上暴露，最难查。
 */
function copyStaticAssets(): Plugin {
  return {
    name: 'aio-copy-static-assets',
    apply: 'build',
    closeBundle() {
      const from = resolve(__dirname, 'assets');
      const to = resolve(__dirname, 'dist/assets');
      if (!existsSync(from)) {
        this.warn('assets/ 目录不存在，跳过拷贝（角色将无法加载）');
        return;
      }
      cpSync(from, to, { recursive: true });
      // 体积大，给个明确日志，避免"以为拷了其实没拷"
      this.info?.(`已拷贝静态资产 assets/ → dist/assets/`);
    },
  };
}

/**
 * 构建目标 ES2022：Rapier WASM 与 three r170 都要求现代浏览器，不向下兼容 IE/旧 Safari。
 * base 用相对路径：提交物会部署在 Qoder Sites 的子路径下，绝对路径会 404。
 *
 * 关于 WASM 体积（这条踩过坑，别改回去）：
 * `@dimforge/rapier3d-compat` 会把 2.94MB 的 rapier_wasm3d_bg.wasm **base64 内联**进 JS，
 * 膨胀成 4.14MB（base64 是 4/3）。JS 合计 4.86MB，直接破掉 spec §8 的「首屏 ≤3MB」
 * 与 M0 的「JS ≤2MB」。所以必须用非 compat 的 `@dimforge/rapier3d`，
 * 让 .wasm 作为**独立资产**被 fetch——它仍然计入首屏传输，但不进 JS bundle。
 *
 * 下面 `assetsInclude` + `manualChunks` 排除，都是为了守住这条。
 */
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  // .wasm 当资产处理（默认就会，这里显式写出来防后人改成 inline）
  assetsInclude: ['**/*.wasm'],
  plugins: [copyStaticAssets()],
  build: {
    target: 'es2022',
    sourcemap: false,
    // 首屏预算 3MB（spec §8），超了要让构建输出里的体积一眼能看见
    reportCompressedSize: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // three 单独成 chunk：490KB+ 且几乎不变，和业务代码分开能吃到长期缓存
          if (id.includes('node_modules/three')) return 'three';
          // Rapier 的 JS 胶水也单独成 chunk（WASM 本身是资产，不在这里）
          if (id.includes('@dimforge/rapier3d')) return 'rapier';
          return undefined;
        },
      },
    },
  },
});
