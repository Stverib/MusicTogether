export interface Env {
  ROOMS: DurableObjectNamespace<import('./room').RoomDO>;
  GUARD: DurableObjectNamespace<import('./guard').GuardDO>;
  BUCKET: R2Bucket;
  SESSION_SECRET: string;
  /**
   * 限速倍率，**仅供本地开发与 E2E 使用**，默认 1。
   *
   * 存在的理由：本地跑 E2E 时所有请求都来自 127.0.0.1 这一个 IP，
   * 严格的生产限额会让测试套件自己把自己挡住。
   * 生产环境不要设这个变量 —— 见 docs/security.md §2.4。
   */
  RATE_LIMIT_SCALE?: string;
}
