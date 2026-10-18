export interface Env {
  ROOMS: DurableObjectNamespace<import('./room').RoomDO>;
  GUARD: DurableObjectNamespace<import('./guard').GuardDO>;
  BUCKET: R2Bucket;
  SESSION_SECRET: string;
}
