import { generateCode, normalizeCode } from '../shared/codes';
import type { Env } from './env';
import { checkRate, clientIp } from './guard';
import { MAX_UPLOAD_BYTES, deleteTrack, putTrack, streamTrack } from './media';
import { isRoomCode, isUuid, originAllowed, withSecurity } from './security';
import { readSession, signSession, sessionCookie } from './session';

const CREATE_LIMIT = { limit: 10, windowMs: 60_000 };
const JOIN_LIMIT = { limit: 20, windowMs: 60_000 };
const UPLOAD_LIMIT = { limit: 60, windowMs: 60_000 };

const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function fail(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/** 限速闸门。返回非 null 表示应该直接把这个响应回给客户端。 */
async function guarded(
  env: Env,
  request: Request,
  bucket: string,
  cfg: { limit: number; windowMs: number },
): Promise<Response | null> {
  const verdict = await checkRate(env, `${bucket}:${clientIp(request)}`, cfg.limit, cfg.windowMs);
  if (verdict.ok) return null;
  return json(
    { error: 'too many requests' },
    { status: 429, headers: { 'Retry-After': String(verdict.retryAfter ?? 60) } },
  );
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/api/')) return new Response('not found', { status: 404 });

  if (path === '/api/health') return json({ ok: true, at: Date.now() });

  if (path === '/api/me') {
    const session = await readSession(request, env.SESSION_SECRET);
    return session ? json({ session }) : fail(401, 'no session');
  }

  if (path === '/api/rooms' && request.method === 'POST') {
    const limited = await guarded(env, request, 'create', CREATE_LIMIT);
    if (limited) return limited;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const res = await stub.fetch(`https://do/init?code=${code}`, { method: 'POST' });
      if (res.ok) return json({ code });
    }
    return fail(503, 'could not allocate a room code');
  }

  const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
  if (!roomMatch) return fail(404, 'no such route');

  const code = normalizeCode(roomMatch[1]!);
  if (!isRoomCode(code)) return fail(400, 'bad room code');
  const rest = roomMatch[2] ?? '';
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

  if (rest === '/join' && request.method === 'POST') {
    const limited = await guarded(env, request, 'join', JOIN_LIMIT);
    if (limited) return limited;

    const body = (await request.json().catch(() => ({}))) as { name?: string; clientId?: string };
    const name = (body.name ?? '').trim().slice(0, 24) || '匿名';
    const clientId = body.clientId?.trim() || crypto.randomUUID();

    const exists = await stub.fetch('https://do/exists');
    if (!exists.ok) return fail(404, '房间不存在');

    const token = await signSession(
      { room: code, clientId, name, exp: Date.now() + SESSION_TTL_SEC * 1000 },
      env.SESSION_SECRET,
    );
    return json(
      { clientId, room: code },
      {
        headers: {
          'Set-Cookie': sessionCookie(token, SESSION_TTL_SEC, url.protocol === 'https:'),
        },
      },
    );
  }

  // ---- 以下都需要会话 ----

  const session = await readSession(request, env.SESSION_SECRET);
  // 签名合法只证明"你是谁"，还要证明"你能进这个房间"（安全文档 §2.5）
  if (!session || session.room !== code) return fail(401, 'not a member of this room');

  if (rest === '/state') return stub.fetch('https://do/state');

  if (rest === '/ws') {
    // WebSocket 握手不受同源策略与 SameSite 保护，必须单独校验 Origin（安全文档 §2.3）
    if (!originAllowed(request)) return fail(403, 'bad origin');
    const headers = new Headers(request.headers);
    headers.set('X-Client-Id', session.clientId);
    headers.set('X-Client-Name', encodeURIComponent(session.name));
    return stub.fetch('https://do/ws', { headers });
  }

  if (rest === '/tracks' && request.method === 'POST') {
    const limited = await guarded(env, request, 'upload', UPLOAD_LIMIT);
    if (limited) return limited;

    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      size?: number;
      mime?: string;
    };
    const size = Number(body.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) return fail(400, 'bad size');
    if (size > MAX_UPLOAD_BYTES) return fail(413, 'file too large');

    const trackId = crypto.randomUUID();
    const added = await stub.fetch('https://do/track-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: trackId,
        name: body.name ?? '未命名',
        size,
        mime: body.mime ?? 'audio/mpeg',
        uploaderId: session.clientId,
        uploaderName: session.name,
      }),
    });
    if (added.status === 413) return fail(413, '房间已满');
    if (!added.ok) return fail(500, 'could not register track');

    return json({ trackId, uploadUrl: `/api/rooms/${code}/tracks/${trackId}/blob` });
  }

  const blobMatch = rest.match(/^\/tracks\/([^/]+)\/blob$/);
  if (blobMatch && request.method === 'PUT') {
    const limited = await guarded(env, request, 'upload', UPLOAD_LIMIT);
    if (limited) return limited;

    // trackId 会被拼进 R2 key，必须先证明它是 UUID（安全文档 §2.1）
    const trackId = blobMatch[1]!;
    if (!isUuid(trackId)) return fail(400, 'bad track id');
    if (!request.body) return fail(400, 'empty body');

    // Content-Length 可以伪造或省略，这里只做快速拒绝；
    // 真正的上限由 putTrack 在流式读取时累计计数（安全文档 §2.7）
    const declared = Number(request.headers.get('Content-Length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return fail(413, 'file too large');

    // 文件名以 DO 里的登记为准，不让客户端在 PUT 时自己声明
    const meta = await stub.fetch(`https://do/track-meta?trackId=${trackId}`);
    if (!meta.ok) return fail(404, 'no such track');
    const { name } = (await meta.json()) as { name: string };

    try {
      const size = await putTrack(env, code, trackId, name, request.body);
      return json({ ok: true, size });
    } catch (err) {
      if ((err as Error).message === 'too large') return fail(413, 'file too large');
      throw err;
    }
  }

  const streamMatch = rest.match(/^\/tracks\/([^/]+)\/stream$/);
  if (streamMatch && request.method === 'GET') {
    return streamTrack(env, code, streamMatch[1]!, request);
  }

  const trackMatch = rest.match(/^\/tracks\/([^/]+)$/);
  if (trackMatch && request.method === 'DELETE') {
    const trackId = trackMatch[1]!;
    if (!isUuid(trackId)) return fail(400, 'bad track id');

    // 移出队列是平权的，删除云端文件不是 —— 只有上传者本人可以（安全文档 §2.5）
    const check = await stub.fetch(
      `https://do/track-deletable?trackId=${trackId}&clientId=${encodeURIComponent(session.clientId)}`,
    );
    if (!check.ok) return fail(403, 'only the uploader can delete');

    await deleteTrack(env, code, trackId);
    await stub.fetch('https://do/track-remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId }),
    });
    return json({ ok: true });
  }

  return fail(404, 'no such route');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withSecurity(await handle(request, env));
    } catch (err) {
      // 只记状态，不把内部细节回给客户端（安全文档 §2.9）
      console.error('unhandled', request.method, new URL(request.url).pathname, (err as Error).name);
      return withSecurity(fail(500, 'internal error'));
    }
  },
} satisfies ExportedHandler<Env>;

export { RoomDO } from './room';
export { GuardDO } from './guard';
