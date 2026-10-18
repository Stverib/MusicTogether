import type { Env } from './env';

export type RateVerdict = { ok: boolean; retryAfter?: number };

/**
 * 全局限速。房间码有 32^6 ≈ 10.7 亿种，只有配上限速才谈得上不可枚举。
 * 见 docs/security.md §2.4。
 *
 * 这是纵深防御，不是保证：按 IP 限速可以被代理池绕过。若项目将来对外开放，
 * 需要换成 Cloudflare 的 Rate Limiting 产品 + WAF。
 *
 * 计数器放在内存里，DO 被驱逐后窗口归零 —— 降级为"限速短暂失效"，
 * 而不是永久失效。对限速这个用途，这个代价换来了零存储成本。
 */
export class GuardDO implements DurableObject {
  private hits = new Map<string, number[]>();

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/check') {
      return new Response('not found', { status: 404 });
    }

    const { key, limit, windowMs } = (await request.json()) as {
      key: string;
      limit: number;
      windowMs: number;
    };

    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
      return Response.json({ ok: false, retryAfter }, { status: 429 });
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(cutoff);
    return Response.json({ ok: true });
  }

  /** 防止 Map 无限增长：清掉窗口内已无记录的 key */
  private sweep(cutoff: number): void {
    for (const [k, v] of this.hits) {
      const kept = v.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }
}

/** 在 Worker 里调用的入口。key 里应带上操作类型与来源 IP。 */
export async function checkRate(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateVerdict> {
  const stub = env.GUARD.get(env.GUARD.idFromName('global'));
  const res = await stub.fetch('https://guard/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, limit, windowMs }),
  });
  if (res.status === 429) {
    const body = (await res.json()) as { retryAfter?: number };
    return { ok: false, retryAfter: body.retryAfter ?? 60 };
  }
  return { ok: res.ok };
}

/** 取调用方 IP。本地 wrangler dev 可能没有这个头。 */
export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For') ??
    'local'
  );
}
