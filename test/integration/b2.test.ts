import { describe, it, expect } from 'vitest';
import { B2Client, type FetchLike } from '../../src/server/b2';

const CONFIG = {
  keyId: 'key-id',
  applicationKey: 'application-key',
  bucketId: 'bucket-id',
  bucketName: 'my-bucket',
};

const API = 'https://api001.backblazeb2.com';
const DOWNLOAD = 'https://f001.backblazeb2.com';
const UPLOAD_URL = 'https://pod-001.backblazeb2.com/b2api/v4/b2_upload_file?bucket=bucket-id';

type Call = { url: string; method: string; headers: Headers; body: Uint8Array | null };

/**
 * 假 B2：按 URL 分派，记录每次请求。上传的流必须真的读完 ——
 * 否则 FixedLengthStream 会一直等，测试会挂住。
 */
function fakeB2(overrides: Record<string, (call: Call) => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body
      ? new Uint8Array(await new Response(init.body as ReadableStream).arrayBuffer())
      : null;
    const call: Call = { url, method, headers, body };
    calls.push(call);

    const key = Object.keys(overrides).find((k) => url.startsWith(k));
    if (key) return overrides[key]!(call);

    if (url === 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account') {
      return Response.json({
        apiUrl: API,
        downloadUrl: DOWNLOAD,
        authorizationToken: 'account-token',
        allowed: { bucketId: CONFIG.bucketId, capabilities: [] },
      });
    }
    if (url.startsWith(`${API}/b2api/v4/b2_get_upload_url`)) {
      return Response.json({ uploadUrl: UPLOAD_URL, authorizationToken: 'upload-token' });
    }
    if (url === UPLOAD_URL) {
      return Response.json({
        fileId: 'file-id',
        fileName: JSON.parse(JSON.stringify(call.headers.get('X-Bz-File-Name'))),
        contentLength: body?.length ?? 0,
        fileInfo: { name: call.headers.get('X-Bz-Info-name') },
      });
    }
    if (url.startsWith(`${DOWNLOAD}/file/${CONFIG.bucketName}/`)) {
      return new Response('abcdefghij', { status: 200 });
    }
    if (url.startsWith(`${API}/b2api/v4/b2_list_file_versions`)) {
      return Response.json({
        files: [
          { fileId: 'old-file', fileName: 'rooms/R/tracks/T', action: 'upload' },
          { fileId: 'new-file', fileName: 'rooms/R/tracks/T', action: 'upload' },
        ],
      });
    }
    if (url === `${API}/b2api/v4/b2_delete_file_version`) {
      return Response.json({ fileId: 'x', fileName: 'y' });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  return { fetchImpl, calls };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}

describe('B2 客户端', () => {
  it('用 Basic 认证换令牌，并在后续调用中复用', async () => {
    const { fetchImpl, calls } = fakeB2();
    const b2 = new B2Client(CONFIG, fetchImpl);

    await b2.putObject('rooms/R/tracks/T', streamOf(new Uint8Array([1, 2])), 2, 'audio/mpeg', 'a.mp3');
    await b2.putObject('rooms/R/tracks/U', streamOf(new Uint8Array([3, 4])), 2, 'audio/mpeg', 'b.mp3');

    const auth = calls.filter((c) => c.url.includes('b2_authorize_account'));
    expect(auth).toHaveLength(1);
    expect(auth[0]!.method).toBe('GET');
    // keyId:applicationKey 的 base64
    expect(auth[0]!.headers.get('Authorization')).toBe(
      `Basic ${btoa(`${CONFIG.keyId}:${CONFIG.applicationKey}`)}`,
    );

    // 上传地址也应当复用，不要每首歌都申请一次
    expect(calls.filter((c) => c.url.includes('b2_get_upload_url'))).toHaveLength(1);
  });

  it('上传时带上 B2 要求的头，并按原样搬字节', async () => {
    const { fetchImpl, calls } = fakeB2();
    const b2 = new B2Client(CONFIG, fetchImpl);
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);

    const written = await b2.putObject(
      'rooms/N9BWJN/tracks/abc',
      streamOf(bytes),
      bytes.length,
      'audio/flac',
      '01. 晴天 - 周杰伦.flac',
    );

    const upload = calls.find((c) => c.url === UPLOAD_URL)!;
    expect(upload.method).toBe('POST');
    expect(upload.headers.get('Authorization')).toBe('upload-token');
    expect(upload.headers.get('X-Bz-File-Name')).toBe('rooms/N9BWJN/tracks/abc');
    // 流式上传不可能预先算 SHA1，B2 明确允许这个字面值
    expect(upload.headers.get('X-Bz-Content-Sha1')).toBe('do_not_verify');
    expect(upload.headers.get('Content-Type')).toBe('audio/flac');
    // 中文文件名要编码后才进得了 HTTP 头
    expect(upload.headers.get('X-Bz-Info-name')).toBe(
      encodeURIComponent('01. 晴天 - 周杰伦.flac'),
    );
    expect(upload.body).toEqual(bytes);
    expect(written).toBe(bytes.length);
  });

  it('下载时把 Range 原样转给 B2，并保留 206 与 Content-Range', async () => {
    let seenRange: string | null = null;
    const { fetchImpl } = fakeB2({
      [`${DOWNLOAD}/file/${CONFIG.bucketName}/`]: (call) => {
        seenRange = call.headers.get('Range');
        return new Response('jkl', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 7-9/10',
            'Content-Length': '3',
            'X-Bz-Info-name': encodeURIComponent('a.mp3'),
          },
        });
      },
    });
    const b2 = new B2Client(CONFIG, fetchImpl);

    const res = await b2.getObject('rooms/R/tracks/T', 'bytes=7-9');

    expect(seenRange).toBe('bytes=7-9');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(await res.text()).toBe('jkl');
  });

  it('删除时先按名字找出所有版本，再逐个删掉', async () => {
    const { fetchImpl, calls } = fakeB2();
    const b2 = new B2Client(CONFIG, fetchImpl);

    await b2.deleteObject('rooms/R/tracks/T');

    const list = calls.find((c) => c.url.includes('b2_list_file_versions'))!;
    const qs = new URL(list.url).searchParams;
    expect(qs.get('bucketId')).toBe(CONFIG.bucketId);
    expect(qs.get('prefix')).toBe('rooms/R/tracks/T');

    const deletes = calls.filter((c) => c.url.endsWith('b2_delete_file_version'));
    expect(deletes.map((d) => JSON.parse(new TextDecoder().decode(d.body!)).fileId)).toEqual([
      'old-file',
      'new-file',
    ]);
  });

  it('下载遇到 401 时重新授权并重试一次', async () => {
    let gets = 0;
    const { fetchImpl, calls } = fakeB2({
      [`${DOWNLOAD}/file/${CONFIG.bucketName}/`]: () => {
        gets++;
        return gets === 1
          ? Response.json({ code: 'expired_auth_token', message: 'expired' }, { status: 401 })
          : new Response('ok', { status: 200 });
      },
    });
    const b2 = new B2Client(CONFIG, fetchImpl);

    const res = await b2.getObject('rooms/R/tracks/T', null);

    expect(res.status).toBe(200);
    expect(gets).toBe(2);
    expect(calls.filter((c) => c.url.includes('b2_authorize_account'))).toHaveLength(2);
  });

  it('B2 拒绝上传时把状态码带出来，不假装成功', async () => {
    const { fetchImpl } = fakeB2({
      [UPLOAD_URL]: () =>
        Response.json({ code: 'storage_cap_exceeded', message: 'cap' }, { status: 403 }),
    });
    const b2 = new B2Client(CONFIG, fetchImpl);

    await expect(
      b2.putObject('rooms/R/tracks/T', streamOf(new Uint8Array([1])), 1, 'audio/mpeg', 'a.mp3'),
    ).rejects.toThrow(/403/);
  });
});
