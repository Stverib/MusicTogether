export interface Env {
  ROOMS: DurableObjectNamespace<import('./room').RoomDO>;
  GUARD: DurableObjectNamespace<import('./guard').GuardDO>;
  /**
   * 本地开发与测试用的 R2 绑定。生产环境不绑 R2（见 wrangler.prod.jsonc），
   * 改用 B2_* 那组变量 —— R2 即使只用免费额度也要求先绑定付款方式。
   */
  BUCKET?: R2Bucket;
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_BUCKET_ID?: string;
  B2_BUCKET_NAME?: string;
  /**
   * 显式指定存储后端，**仅测试用**：设成 `r2` 就强制走本地 R2，
   * 哪怕 .dev.vars 里配了真实的 B2 密钥。E2E 靠它避免往真桶里写数据。
   */
  STORAGE?: string;
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
