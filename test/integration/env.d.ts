/// <reference types="@cloudflare/vitest-plugin/types" />

import type { Env as Bindings } from '../../src/server/env';

// cloudflare:test 的 env 类型是 Cloudflare.Env，默认是空接口。
// 把我们的绑定声明进去，否则测试里访问 env.BUCKET 会报"属性不存在"。
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
