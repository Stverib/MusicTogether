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
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // 测试用的密钥只存在于这里，绝不写进 wrangler.jsonc ——
            // 生产密钥走 `wrangler secret put`，见 AGENTS.md 安全红线第 9 条
            miniflare: {
              bindings: {
                SESSION_SECRET: 'test-only-secret-at-least-32-chars-long',
                // 显式锁回 1 倍：.dev.vars 里为了 E2E 把限速放宽了 50 倍，
                // 而限速本身正是这一层要测的东西
                RATE_LIMIT_SCALE: '1',
              },
            },
          }),
        ],
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          sequence: { concurrent: false },
          // workerd 冷启动叠加首次 R2 上传会超过默认的 5 秒；集成测试串行跑，
          // 放宽这一层不会掩盖真正的死循环（单测仍用默认值）
          testTimeout: 15_000,
        },
      },
    ],
  },
});
