import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineConfig({
  test: {
    projects: [
      {
        // 纯函数与前端逻辑：跑在 node 里，不碰 Worker 运行时
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      // 服务端：跑在真实的 workerd 里，用真实的 Durable Object 与 R2 模拟
      defineWorkersProject({
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // 集成测试共用一个 makeRoom 辅助，串行更稳
          sequence: { concurrent: false },
        },
      }),
    ],
  },
});
