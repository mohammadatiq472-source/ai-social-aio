import { defineConfig, devices } from '@playwright/test';

const PORT = 5174;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * headless Chromium 没有真 GPU，WebGL 走 SwiftShader。
 * 所以 e2e 断言的是「渲染链路通、resize 不变形、降级规则生效」，
 * 帧率只做「不崩、有 fps 数字」的弱断言——真机 60fps 由人眼/实测记录，不靠 CI 里的软渲染。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    },
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
});
