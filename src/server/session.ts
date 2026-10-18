export const SESSION_COOKIE = 'mt_sess';
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60; // 30 天，对应"常驻房间"

export type SessionPayload = {
  room: string;
  clientId: string;
  name: string;
  /** 过期时刻，Unix 毫秒 */
  exp: number;
};

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * 校验签名并解出载荷。任何异常都返回 null，绝不抛出 ——
 * 这个函数的输入完全来自攻击者可控的 Cookie。
 *
 * crypto.subtle.verify 是常量时间比较，不存在签名逐字节爆破的旁路。
 */
export async function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SessionPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const sigBytes = b64urlDecode(token.slice(dot + 1));
  if (!sigBytes) return null;

  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, enc.encode(body));
  if (!valid) return null;

  const payloadBytes = b64urlDecode(body);
  if (!payloadBytes) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (typeof payload?.room !== 'string' || typeof payload?.clientId !== 'string') return null;
  if (typeof payload?.name !== 'string') return null;
  if (typeof payload?.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export async function readSession(request: Request, secret: string): Promise<SessionPayload | null> {
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (!token) return null;
  return verifySession(token, secret);
}

export function sessionCookie(token: string, maxAgeSec = DEFAULT_TTL_SEC, secure = true): string {
  // Secure 由调用方按协议决定：http://localhost 开发时浏览器不会种 Secure Cookie
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
