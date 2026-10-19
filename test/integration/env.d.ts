/// <reference types="@cloudflare/vitest-plugin/types" />

import type { Env as Bindings } from '../../src/server/env';

// Cloudflare.Env 默认是空接口，绑定声明进去才能访问 env.BUCKET。
// mainModule 让 `exports.default` 在测试里带上主 worker 的类型。
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
    interface GlobalProps {
      mainModule: typeof import('../../src/server/index');
    }
  }
}
