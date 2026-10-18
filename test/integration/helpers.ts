import { SELF } from 'cloudflare:test';

export const ORIGIN = 'https://example.com';

/**
 * 每个 helper 调用分配一个不同的来源 IP。
 *
 * 这是必需的：建房有 10 次/分钟/IP 的限速，如果所有测试共用一个 IP，
 * 跑到第十几个用例就会开始集体返回 429 —— 而且失败原因看起来会像是功能坏了。
 * 需要测限速本身的用例显式传同一个 IP。
 */
let ipCounter = 0;
export function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 0xff}.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

type FetchOpts = { ip?: string; cookie?: string; origin?: string | null };

function headers(opts: FetchOpts, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? nextIp(), ...extra };
  if (opts.origin !== null) h['Origin'] = opts.origin ?? ORIGIN;
  if (opts.cookie) h['Cookie'] = opts.cookie;
  return h;
}

export async function newRoom(opts: FetchOpts = {}): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
    method: 'POST',
    headers: headers(opts),
  });
  if (!res.ok) throw new Error(`create room failed: ${res.status}`);
  return ((await res.json()) as { code: string }).code;
}

export type Member = { cookie: string; clientId: string; status: number };

export async function joinRoom(
  code: string,
  name: string,
  opts: FetchOpts & { clientId?: string } = {},
): Promise<Member> {
  const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/join`, {
    method: 'POST',
    headers: headers(opts, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, clientId: opts.clientId }),
  });
  const setCookie = res.headers.get('Set-Cookie') ?? '';
  const body = res.ok
    ? ((await res.json()) as { clientId: string })
    : ({ clientId: '' } as { clientId: string });
  return { cookie: setCookie.split(';')[0] ?? '', clientId: body.clientId, status: res.status };
}

/** 建房间并加入，返回房号与成员身份 */
export async function roomWith(name: string, opts: FetchOpts = {}) {
  const ip = opts.ip ?? nextIp();
  const code = await newRoom({ ...opts, ip });
  const member = await joinRoom(code, name, { ...opts, ip });
  return { code, ip, ...member };
}

export async function stateOf(code: string, cookie: string): Promise<any> {
  const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/state`, {
    headers: { Cookie: cookie, 'CF-Connecting-IP': nextIp() },
  });
  if (!res.ok) throw new Error(`state failed: ${res.status}`);
  return res.json();
}

export async function connectWs(
  code: string,
  cookie: string,
  opts: FetchOpts = {},
): Promise<WebSocket> {
  const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, {
    headers: headers(opts, { Upgrade: 'websocket', Cookie: cookie }),
  });
  if (res.status !== 101) throw new Error(`ws upgrade failed: ${res.status}`);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/** 把一个 WebSocket 收到的消息按到达顺序排成队列 */
export function reader(ws: WebSocket): () => Promise<any> {
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const v = JSON.parse(e.data as string);
    const w = waiters.shift();
    if (w) w(v);
    else queue.push(v);
  });
  return () =>
    new Promise<any>((resolve) => {
      const v = queue.shift();
      if (v !== undefined) resolve(v);
      else waiters.push(resolve);
    });
}

/** 跳过中间的其他消息类型，等到指定类型的那一帧 */
export async function nextOfType(next: () => Promise<any>, type: string, tries = 20): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const m = await next();
    if (m.type === type) return m;
  }
  throw new Error(`never saw a "${type}" frame`);
}

export function fakeSong(bytes = 2048): Uint8Array {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31) & 0xff;
  return buf;
}

/** 登记一首歌并上传字节，返回 trackId */
export async function uploadTrack(
  code: string,
  cookie: string,
  name: string,
  bytes: Uint8Array = fakeSong(),
): Promise<string> {
  const init = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'CF-Connecting-IP': nextIp() },
    body: JSON.stringify({ name, size: bytes.length, mime: 'audio/mpeg' }),
  });
  if (!init.ok) throw new Error(`register track failed: ${init.status}`);
  const { trackId, uploadUrl } = (await init.json()) as { trackId: string; uploadUrl: string };

  const put = await SELF.fetch(`${ORIGIN}${uploadUrl}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'CF-Connecting-IP': nextIp() },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  return trackId;
}
