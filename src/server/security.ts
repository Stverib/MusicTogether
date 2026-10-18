import { isValidCode } from '../shared/codes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 严格 UUID 校验。任何会被拼进 R2 key 的路径片段都必须先过这一关，
 * 否则 `../../` 就能读到别的房间的文件。见 docs/security.md §2.1。
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** 房间码校验的统一入口，避免各处手写 */
export function isRoomCode(raw: string): boolean {
  return isValidCode(raw);
}

/**
 * 出站 Content-Type 白名单。
 *
 * 用户声明的 MIME 只用于存储元数据，绝不直接成为响应头 —— 否则上传一个 HTML
 * 再直接访问流地址，就是一个跑在同源下的存储型 XSS。见 docs/security.md §2.2。
 *
 * 这里只输出固定的常量字符串，所以即使调用方传入攻击者可控的文件名，
 * 也无法让响应类型变成 text/html。
 */
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

export function audioMimeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return AUDIO_MIME[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Origin 必须与部署主机一致。
 *
 * WebSocket 握手不受同源策略与 SameSite 保护，不校验就是现成的 CSRF 通道：
 * evil.com 上的一行 `new WebSocket(...)` 就能带着受害者的 Cookie 连进来。
 * 见 docs/security.md §2.3。
 */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 给响应补上安全响应头。只在 Worker 最外层调用一次。
 *
 * `Referrer-Policy: no-referrer` 尤其重要：房间码在 URL 路径里，
 * 任何外链跳转都会把它放进 Referer 泄漏出去。
 */
export function withSecurity(response: Response): Response {
  // 101 是 WebSocket 升级响应，重新包装会破坏它。
  // 204/205/304 是"无响应体"状态，重新构造 Response 会直接抛异常。
  if (response.status === 101 || response.webSocket) return response;

  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');

  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
