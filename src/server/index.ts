import { generateCode, normalizeCode } from '../shared/codes';
import type { Env } from './env';
import { checkRate, clientIp } from './guard';
import { MAX_UPLOAD_BYTES, deleteTrack, putTrack, storageConfigured, streamTrack } from './media';
import { isRoomCode, isUuid, originAllowed, withSecurity } from './security';
import { readSession, signSession, sessionCookie } from './session';

const CREATE_LIMIT = { limit: 10, windowMs: 60_000 };
const JOIN_LIMIT = { limit: 20, windowMs: 60_000 };
const UPLOAD_LIMIT = { limit: 60, windowMs: 60_000 };

/**
 * 生产限额是上面那三个常量。RATE_LIMIT_SCALE 只是本地开发与 E2E 的逃生口 ——
 * 本地所有请求都来自同一个 IP，不放松的话测试套件会把自己挡住。
 * 生产环境不设这个变量即为 1 倍。见 docs/security.md §2.4。
 */
function limits(env: Env) {
  const raw = Number(env.RATE_LIMIT_SCALE);
  const scale = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 1000) : 1;
  const at = (cfg: { limit: number; windowMs: number }) => ({
    limit: cfg.limit * scale,
    windowMs: cfg.windowMs,
  });
  return { create: at(CREATE_LIMIT), join: at(JOIN_LIMIT), upload: at(UPLOAD_LIMIT) };
}

const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function fail(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/**
 * 取会话密钥，并且**在密钥不可用时响亮地失败**。
 *
 * 不能把这个检查省掉：WebCrypto 拿到空密钥只会抛一个含义不明的 DataError，
 * 而"密钥悄悄变成空字符串"意味着任何人都能伪造任意房间的任意身份。
 * 宁可整个服务起不来，也不要带着一个坏密钥跑。
 */
function sessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('SESSION_SECRET missing or shorter than 32 chars');
  }
  return secret;
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

  if (path === '/api/health') {
    // 密钥或存储配错时健康检查要如实报告，而不是假装一切正常。
    // 存储没配的话房间能建、歌却传不上去，这是最容易漏掉的部署失误
    let configured = true;
    try {
      sessionSecret(env);
    } catch {
      configured = false;
    }
    if (!storageConfigured(env)) configured = false;
    return json({ ok: configured, at: Date.now() }, { status: configured ? 200 : 503 });
  }

  const secret = sessionSecret(env);
  const lim = limits(env);

  if (path === '/api/me') {
    const session = await readSession(request, secret);
    return session ? json({ session }) : fail(401, 'no session');
  }

  if (path === '/api/rooms' && request.method === 'POST') {
    const limited = await guarded(env, request, 'create', lim.create);
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
    const limited = await guarded(env, request, 'join', lim.join);
    if (limited) return limited;

    const body = (await request.json().catch(() => ({}))) as { name?: string; clientId?: string };
    const name = (body.name ?? '').trim().slice(0, 24) || '匿名';
    const clientId = body.clientId?.trim() || crypto.randomUUID();

    const exists = await stub.fetch('https://do/exists');
    if (!exists.ok) return fail(404, '房间不存在');

    const token = await signSession(
      { room: code, clientId, name, exp: Date.now() + SESSION_TTL_SEC * 1000 },
      secret,
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

  const session = await readSession(request, secret);
  // 签名合法只证明"你是谁"，还要证明"你能进这个房间"（安全文档 §2.5）
  if (!session || session.room !== code) return fail(401, 'not a member of this room');

  if (rest === '/state') return stub.fetch('https://do/state');

  if (rest === '/chat' && request.method === 'GET') {
    // 游标只接受纯数字。不做这个校验就等于把一个任意字符串透传给 DO，
    // 而它会被 Number() 变成 NaN —— 与其依赖下游的容错，不如在这里挡掉
    const before = url.searchParams.get('before') ?? '';
    const query = /^\d+$/.test(before) ? `?before=${before}` : '';
    return stub.fetch(`https://do/chat-history${query}`);
  }

  if (rest === '/ws') {
    // WebSocket 握手不受同源策略与 SameSite 保护，必须单独校验 Origin（安全文档 §2.3）
    if (!originAllowed(request)) return fail(403, 'bad origin');
    const headers = new Headers(request.headers);
    headers.set('X-Client-Id', session.clientId);
    headers.set('X-Client-Name', encodeURIComponent(session.name));
    return stub.fetch('https://do/ws', { headers });
  }

  if (rest === '/tracks' && request.method === 'POST') {
    const limited = await guarded(env, request, 'upload', lim.upload);
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
    const limited = await guarded(env, request, 'upload', lim.upload);
    if (limited) return limited;

    // trackId 会被拼进对象存储 key，必须先证明它是 UUID（安全文档 §2.1）
    const trackId = blobMatch[1]!;
    if (!isUuid(trackId)) return fail(400, 'bad track id');
    if (!request.body) return fail(400, 'empty body');

    // 两条存储后端都要求流有已知长度，所以这里**必须**有 Content-Length。
    // 不能只把它当参考值：实际字节数会被 FixedLengthStream 强制成这个数，
    // 而登记时的配额也是按这个数算的，两者必须一致（安全文档 §2.7）
    const declared = Number(request.headers.get('Content-Length'));
    if (!Number.isInteger(declared) || declared <= 0) return fail(411, 'length required');
    if (declared > MAX_UPLOAD_BYTES) return fail(413, 'file too large');

    // 文件名与体积以 DO 里的登记为准，不让客户端在 PUT 时自己声明
    const meta = await stub.fetch(`https://do/track-meta?trackId=${trackId}`);
    if (!meta.ok) return fail(404, 'no such track');
    const { name, size } = (await meta.json()) as { name: string; size: number };
    if (declared !== size) return fail(400, 'length does not match registration');

    try {
      const written = await putTrack(env, code, trackId, name, request.body, declared);
      // 字节真的落地了才入队：这样队列里的每一首都是能播的，
      // 而登记与 PUT 之间的那段时间里它不会提前出现在两端
      await stub.fetch('https://do/track-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId }),
      });
      return json({ ok: true, size: written });
    } catch (err) {
      if ((err as Error).message === 'bad length') return fail(413, 'file too large');
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
      // 只在服务端记录细节，不把内部信息回给客户端（安全文档 §2.9）
      const e = err as Error;
      console.error('unhandled', request.method, new URL(request.url).pathname, e.name, e.message);
      return withSecurity(fail(500, 'internal error'));
    }
  },
} satisfies ExportedHandler<Env>;

export { RoomDO } from './room';
export { GuardDO } from './guard';
