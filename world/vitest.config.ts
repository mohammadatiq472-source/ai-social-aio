import { defineConfig } from 'vitest/config';

/**
 * 单测只跑纯逻辑（core/*）与无 DOM 依赖的渲染数学（render/camera 的弹簧与夹取）。
 * 需要 WebGL 的东西一律交给 Playwright（e2e/），不在 node 里假装渲染。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
});
