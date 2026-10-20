import { describe, it, expect } from 'vitest';
import { ORIGIN, SELF, fakeSong, newRoom, nextIp, roomWith, uploadTrack } from './helpers';

function song(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}

async function fetchStream(
  code: string,
  trackId: string,
  opts: { cookie?: string; range?: string; ip?: string; origin?: string | null } = {},
) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? nextIp() };
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  if (opts.range) headers['Range'] = opts.range;
  if (opts.origin !== null) headers['Origin'] = opts.origin ?? ORIGIN;
  return SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks/${trackId}/stream`, { headers });
}

describe('流式播放', () => {
  it('无 Range 时返回 200 与完整内容', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const bytes = song(4096);
    const trackId = await uploadTrack(code, cookie, 's.mp3', bytes);

    const res = await fetchStream(code, trackId, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('4096');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('带 Range 时返回 206 与正确的 Content-Range', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const bytes = song(4096);
    const trackId = await uploadTrack(code, cookie, 's.mp3', bytes);

    const res = await fetchStream(code, trackId, { cookie, range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/4096');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(100, 200));
  });

  it('后缀 Range（最后 N 字节）正确', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const bytes = song(4096);
    const trackId = await uploadTrack(code, cookie, 's.mp3', bytes);

    const res = await fetchStream(code, trackId, { cookie, range: 'bytes=-256' });
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(-256));
  });

  it('开放区间 Range（从某点到结尾）正确', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const bytes = song(4096);
    const trackId = await uploadTrack(code, cookie, 's.mp3', bytes);

    const res = await fetchStream(code, trackId, { cookie, range: 'bytes=4000-' });
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(4000));
  });

  it('多次分段读取拼起来等于原文件（模拟浏览器拖动进度条）', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const bytes = song(3000);
    const trackId = await uploadTrack(code, cookie, 's.mp3', bytes);

    const parts: Uint8Array[] = [];
    for (const [start, end] of [
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ] as const) {
      const res = await fetchStream(code, trackId, { cookie, range: `bytes=${start}-${end}` });
      expect(res.status).toBe(206);
      parts.push(new Uint8Array(await res.arrayBuffer()));
    }

    const joined = new Uint8Array(3000);
    parts.forEach((p, i) => joined.set(p, i * 1000));
    expect(joined).toEqual(bytes);
  });

  it('没有会话不能读流', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, 's.mp3', song(64));

    const res = await fetchStream(code, trackId);
    expect(res.status).toBe(401);
  });

  it('别的房间的令牌读不到这个房间的歌', async () => {
    const a = await roomWith('阿甲');
    const b = await roomWith('阿乙');
    const trackId = await uploadTrack(a.code, a.cookie, 's.mp3', song(64));

    const res = await fetchStream(a.code, trackId, { cookie: b.cookie });
    expect(res.status).toBe(401);
  });

  it('不存在的曲目返回 404', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await fetchStream(code, '00000000-0000-0000-0000-000000000000', { cookie });
    expect(res.status).toBe(404);
  });

  it('同时上传两首歌，字节流不会串台', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const one = song(1000);
    const two = new Uint8Array(1000).fill(0xab);

    const idOne = await uploadTrack(code, cookie, 'one.mp3', one);
    const idTwo = await uploadTrack(code, cookie, 'two.mp3', two);

    const a = new Uint8Array(await (await fetchStream(code, idOne, { cookie })).arrayBuffer());
    const b = new Uint8Array(await (await fetchStream(code, idTwo, { cookie })).arrayBuffer());
    expect(a).toEqual(one);
    expect(b).toEqual(two);
  });
});

describe('流式端点的安全约束', () => {
  it('非 UUID 的 trackId 返回 400，而不是去拼 key', async () => {
    const { code, cookie } = await roomWith('阿甲');
    for (const bad of ['..%2F..%2Fsecret', 'not-a-uuid', 'a'.repeat(40)]) {
      const res = await SELF.fetch(
        `${ORIGIN}/api/rooms/${code}/tracks/${encodeURIComponent(bad)}/stream`,
        { headers: { Cookie: cookie, 'CF-Connecting-IP': nextIp() } },
      );
      expect(res.status).toBe(400);
    }
  });

  it('响应头强制 nosniff，Content-Type 只可能是白名单值', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, 's.mp3', song(256));

    const res = await fetchStream(code, trackId, { cookie });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('上传 HTML 也拿不到 text/html 的响应类型（存储型 XSS 的核心防线）', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const payload = new TextEncoder().encode('<script>alert(1)</script>');
    const trackId = await uploadTrack(code, cookie, 'evil.html', payload);

    const res = await fetchStream(code, trackId, { cookie });
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Type')).not.toContain('html');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('中文文件名推导出的类型正确（URI 编码往返无损）', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, '01. 晴天.flac', song(64));

    const res = await fetchStream(code, trackId, { cookie });
    expect(res.headers.get('Content-Type')).toBe('audio/flac');
  });

  it('不发 CORS 头（浏览器端只能同源读）', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, 's.mp3', song(64));

    const res = await fetchStream(code, trackId, { cookie, origin: 'https://evil.com' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('不存在的房间码在读流之前就被挡下', async () => {
    const code = await newRoom();
    const res = await fetchStream(code, crypto.randomUUID(), {});
    expect(res.status).toBe(401);
  });
});
