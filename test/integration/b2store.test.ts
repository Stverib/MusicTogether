import { describe, it, expect } from 'vitest';
import { b2Store } from '../../src/server/media';
import type { FetchLike } from '../../src/server/b2';

const CONFIG = {
  keyId: 'key-id',
  applicationKey: 'application-key',
  bucketId: 'bucket-id',
  bucketName: 'my-bucket',
};
const DOWNLOAD = 'https://f001.backblazeb2.com';
const TRACK = '11111111-1111-4111-8111-111111111111';

type Call = { url: string; headers: Headers; body: Uint8Array | null };

function fakeB2(overrides: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    // 上传请求必须把流读完，否则 FixedLengthStream 会一直等
    const body = init?.body
      ? new Uint8Array(await new Response(init.body as ReadableStream).arrayBuffer())
      : null;
    const call = { url, headers: new Headers(init?.headers), body };
    calls.push(call);
    const key = Object.keys(overrides).find((k) => url.startsWith(k));
    if (key) return overrides[key]!(call);
    if (url.includes('b2_authorize_account')) {
      return Response.json({
        apiUrl: 'https://api001.backblazeb2.com',
        downloadUrl: DOWNLOAD,
        authorizationToken: 'account-token',
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchImpl, calls };
}

describe('B2 存储适配层', () => {
  it('读取时以白名单类型覆盖 B2 的 Content-Type，并保留 206 语义', async () => {
    const { fetchImpl } = fakeB2({
      [`${DOWNLOAD}/file/my-bucket/`]: () =>
        new Response('ab', {
          status: 206,
          headers: {
            'Content-Type': 'text/html',
            'Content-Range': 'bytes 0-1/2',
            'Content-Length': '2',
            'X-Bz-Info-name': encodeURIComponent('晴天.flac'),
            'X-Bz-File-Name': 'rooms/R/tracks/T',
          },
        }),
    });
    const store = b2Store(CONFIG, 'R', fetchImpl);

    const res = await store.stream(TRACK, new Request('https://x/', { headers: { Range: 'bytes=0-1' } }));

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/2');
    expect(res.headers.get('Content-Length')).toBe('2');
    expect(res.headers.get('Content-Type')).toBe('audio/flac');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // B2 的内部头不该透给浏览器
    expect(res.headers.get('X-Bz-Info-name')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x61, 0x62]));
  });

  it('B2 说没有这个对象时回 404', async () => {
    const { fetchImpl } = fakeB2({
      [`${DOWNLOAD}/file/my-bucket/`]: () => new Response('not found', { status: 404 }),
    });
    const store = b2Store(CONFIG, 'R', fetchImpl);

    const res = await store.stream(TRACK, new Request('https://x/'));
    expect(res.status).toBe(404);
  });

  it('写入时用房间路径作为远端名字，元数据里存原始文件名', async () => {
    const { fetchImpl, calls } = fakeB2({
      'https://pod-001.backblazeb2.com': () =>
        Response.json({ fileId: 'f', fileName: 'n', contentLength: 3 }),
      'https://api001.backblazeb2.com/b2api/v4/b2_get_upload_url': () =>
        Response.json({
          uploadUrl: 'https://pod-001.backblazeb2.com/b2api/v4/b2_upload_file?bucket=x',
          authorizationToken: 'up',
        }),
    });
    const store = b2Store(CONFIG, 'N9BWJN', fetchImpl);

    await store.put(
      TRACK,
      '01. 晴天 - 周杰伦.mp3',
      new Response(new Uint8Array([1, 2, 3])).body!,
      3,
    );

    const upload = calls.find((c) => c.url.startsWith('https://pod-001'))!;
    expect(upload.headers.get('X-Bz-File-Name')).toBe(`rooms/N9BWJN/tracks/${TRACK}`);
    expect(upload.headers.get('X-Bz-Info-name')).toBe(encodeURIComponent('01. 晴天 - 周杰伦.mp3'));
    expect(upload.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('非 UUID 的 trackId 不去碰 B2', async () => {
    const { fetchImpl, calls } = fakeB2();
    const store = b2Store(CONFIG, 'R', fetchImpl);

    const res = await store.stream('../../secret', new Request('https://x/'));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
