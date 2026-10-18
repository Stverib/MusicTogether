import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    projects: [
      {
        // 纯函数与前端逻辑：跑在 node 里，不碰 Worker 运行时。
        // 前端代码里有 localStorage / indexedDB 这类浏览器专有 API，
        // 所以它们不进这一层 —— 那部分靠 Playwright 的 E2E 覆盖。
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // 服务端：跑在真实的 workerd 里，用真实的 Durable Object 与 R2 模拟
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
