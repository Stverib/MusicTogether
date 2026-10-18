import type { Env } from './env';
import { audioMimeFor, isUuid } from './security';

/** 单文件上限。Workers 请求体的硬上限就是 100 MB（挂在 Zone 计划上） */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 每房间配额（安全文档 §2.7）：防止拿到一个房间码就把 R2 免费额度填满 */
export const MAX_TRACKS_PER_ROOM = 200;
export const MAX_ROOM_BYTES = 2 * 1024 * 1024 * 1024;

export function trackKey(roomCode: string, trackId: string): string {
  // 双保险：调用方已经校验过，这里再挡一次，避免将来有人绕过
  if (!isUuid(trackId)) throw new Error('bad track id');
  return `rooms/${roomCode}/tracks/${trackId}`;
}

/**
 * 流式写入 R2。
 *
 * R2 的 put() 要求可读流有**已知长度**（"Provided readable stream must have a
 * known length"），所以这里必须用 FixedLengthStream 包一层，而不能直接喂一个
 * pipeThrough 出来的流。
 *
 * 这同时是一条安全边界：FixedLengthStream 会**强制**实际字节数恰好等于
 * 声明值 —— 多了少了都会让流报错。调用方必须先确认这个 length 与登记时
 * 声明的体积一致，否则配额会被少算。
 */
export async function putTrack(
  env: Env,
  roomCode: string,
  trackId: string,
  filename: string,
  body: ReadableStream<Uint8Array>,
  length: number,
): Promise<number> {
  if (!Number.isInteger(length) || length <= 0 || length > MAX_UPLOAD_BYTES) {
    throw new Error('bad length');
  }

  const fixed = new FixedLengthStream(length);
  // 不 await：先把 readable 交给 R2，写入端并行推进
  const pumping = body.pipeTo(fixed.writable).catch(() => {
    // 长度不符导致的错误会同时反映在 put() 上，这里吞掉避免 unhandled rejection
  });

  try {
    const obj = await env.BUCKET.put(trackKey(roomCode, trackId), fixed.readable, {
      // customMetadata 会变成 HTTP 头，必须是 Latin-1 安全的 ——
      // 中文文件名直接写进去会炸，所以先做 URI 编码。
      // 出站 Content-Type 由 audioMimeFor() 从解码后的名字推导（安全文档 §2.2）
      customMetadata: { name: encodeURIComponent(filename.slice(0, 200)) },
    });
    await pumping;
    return obj?.size ?? length;
  } catch (err) {
    await pumping;
    // 半截对象不能留在桶里
    await env.BUCKET.delete(trackKey(roomCode, trackId)).catch(() => {});
    throw err;
  }
}

export async function deleteTrack(env: Env, roomCode: string, trackId: string): Promise<void> {
  if (!isUuid(trackId)) return;
  await env.BUCKET.delete(trackKey(roomCode, trackId));
}

/**
 * 流式返回 R2 对象，支持 Range。
 *
 * 三件必须自己做的事：
 * 1. 流式转发 —— Worker 内存只有 128 MB，缓冲会报 Memory limit exceeded
 * 2. 手写 206 / Content-Range —— R2 的 Worker API 不产出这两个头
 * 3. 强制 Content-Type 为白名单值 —— 否则是存储型 XSS（安全文档 §2.2）
 */
export async function streamTrack(
  env: Env,
  roomCode: string,
  trackId: string,
  request: Request,
): Promise<Response> {
  if (!isUuid(trackId)) return new Response('bad track id', { status: 400 });

  const rangeHeader = request.headers.get('Range');
  const obj = await env.BUCKET.get(trackKey(roomCode, trackId), {
    range: rangeHeader ? request.headers : undefined,
    onlyIf: request.headers,
  });
  if (!obj) return new Response('not found', { status: 404 });

  // 带 onlyIf 时 R2 可能只回元数据不回响应体（条件命中，例如 If-None-Match 匹配）
  const body = (obj as R2ObjectBody).body;
  if (!body) {
    return new Response(null, { status: 304, headers: { ETag: obj.httpEtag } });
  }

  // 文件名来自上传时写入的 customMetadata —— 同一次 get 就带回来了，不需要额外往返。
  // audioMimeFor 只输出白名单里的固定常量，所以哪怕文件名本身是恶意的，
  // 也无法让响应类型变成 text/html（安全文档 §2.2）
  let filename = '';
  const rawName = obj.customMetadata?.name;
  if (rawName) {
    try {
      filename = decodeURIComponent(rawName);
    } catch {
      filename = ''; // 编码坏了就退回 octet-stream，不影响可用性
    }
  }

  const headers = new Headers({
    'Content-Type': audioMimeFor(filename),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    ETag: obj.httpEtag,
    'Cache-Control': 'private, max-age=3600',
  });

  // R2Range 的联合类型里还包含 { suffix } 这种请求侧的写法，
  // 响应侧实际总是给出具体的 offset/length，但类型上要自己收窄
  const range = obj.range as { offset?: number; length?: number } | undefined;

  if (!rangeHeader || !range || typeof range.offset !== 'number') {
    headers.set('Content-Length', String(obj.size));
    return new Response(body, { status: 200, headers });
  }

  const start = range.offset;
  // length 缺省表示"一直到结尾"
  const end = typeof range.length === 'number' ? start + range.length - 1 : obj.size - 1;

  headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(body, { status: 206, headers });
}
