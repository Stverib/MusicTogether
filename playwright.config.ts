import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 90_000,
  // 同步相关的用例共享同一个服务端，串行更稳
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'edge',
      use: {
        ...devices['Desktop Chrome'],
        // 用系统已装的 Edge，避免下载 Playwright 自带的 Chromium
        channel: 'msedge',
        launchOptions: {
          // 无头浏览器默认禁止自动播放，而同步播放必须能自己 start
          args: ['--autoplay-policy=no-user-gesture-required'],
        },
      },
    },
  ],

  webServer: {
    // E2E 跑的是 wrangler 托管的构建产物，所以要先 build
    command: `npm run build && npx wrangler dev --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
