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
 * 流式写入 R2，同时累计字节数。
 *
 * 不信任 Content-Length —— 它可以伪造或省略（安全文档 §2.7），
 * 所以上限必须在读取过程中累计判定。
 */
export async function putTrack(
  env: Env,
  roomCode: string,
  trackId: string,
  filename: string,
  body: ReadableStream<Uint8Array>,
): Promise<number> {
  let total = 0;
  let aborted = false;

  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          aborted = true;
          controller.error(new Error('too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  try {
    // 注意：这里不写 httpMetadata.contentType —— 用户声明的 MIME 一律不进响应头。
    // 文件名只进 customMetadata，出站类型由 audioMimeFor() 从它推导（安全文档 §2.2）
    const obj = await env.BUCKET.put(trackKey(roomCode, trackId), counted, {
      customMetadata: { name: filename.slice(0, 200) },
    });
    return obj?.size ?? total;
  } catch (err) {
    // 半截对象不能留在桶里
    await env.BUCKET.delete(trackKey(roomCode, trackId)).catch(() => {});
    throw aborted ? new Error('too large') : err;
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

  // 文件名来自上传时写入的 customMetadata —— 同一次 get 就带回来了，不需要额外往返。
  // audioMimeFor 只输出白名单里的固定常量，所以哪怕文件名本身是恶意的，
  // 也无法让响应类型变成 text/html（安全文档 §2.2）
  const filename = obj.customMetadata?.name ?? '';

  const headers = new Headers({
    'Content-Type': audioMimeFor(filename),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    ETag: obj.httpEtag,
    'Cache-Control': 'private, max-age=3600',
  });

  if (!rangeHeader || !obj.range) {
    headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { status: 200, headers });
  }

  const start = obj.range.offset;
  const end = obj.range.offset + obj.range.length - 1;
  headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
  headers.set('Content-Length', String(obj.range.length));
  return new Response(obj.body, { status: 206, headers });
}
