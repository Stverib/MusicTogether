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
    // E2E 跑的是 wrangler 托管的构建产物，所以要先 build。
    // e2e:server 还会做两件事，都是为了"每轮从同一个已知状态开始"：
    //   1. 用独立的 --persist-to 目录，不跟 `npm run dev:worker` 抢同一份本地状态
    //      （否则跑测试会把开发中的房间和歌一起抹掉）
    //   2. 每轮开跑前清空它 —— 状态跨轮累积过 75 MB，之后会出现
    //      "上传静默不落地"这类完全看不出原因的失败
    command: 'npm run e2e:server',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
