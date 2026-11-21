import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期固定 5173：/api、/ws 全部代理到本机后端 8787；生产由后端静态托管 dist。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  base: './', // 构建产物用相对路径，后端挂在 / 或子路径都能直接跑
  plugins: [react()],
  define: {
    // 版本号从 package.json 注入，避免前端再写死
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true, changeOrigin: false },
      '/media': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/packs': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        /**
         * React 运行时单独一个 vendor chunk：app 代码（含组件拆分）每次改都会换 index-*.js 的 hash，
         * vendor 的 hash 不动，浏览器就能继续用缓存里的 React。
         *
         * 只收 node_modules 里的 react / react-dom / scheduler：
         * - scheduler 必须一起进来，react-dom 运行时依赖它；漏在外面的会让 index ↔ vendor 互相 import，
         *   Rollup 只能靠提前执行勉强跑通，还可能把 app 模块卷进 vendor。
         * - 别在这里按 `node_modules` 前缀一把抓：那会把任何第三方依赖都塞进 vendor，
         *   升一个包就让 vendor 全量失效，缓存收益反而没了。
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          return /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'vendor' : undefined
        },
      },
    },
  },
})
