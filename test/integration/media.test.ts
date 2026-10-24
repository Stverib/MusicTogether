import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  ORIGIN,
  SELF,
  fakeSong,
  joinRoom,
  newRoom,
  nextIp,
  roomWith,
  stateOf,
  uploadTrack,
} from './helpers';

// 本地测试环境一定绑了 R2；生产走 B2 的那条路见 b2store.test.ts
const bucket = env.BUCKET!;

async function register(
  code: string,
  cookie: string,
  name: string,
  size: number,
  mime = 'audio/mpeg',
  ip = nextIp(),
) {
  return SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ name, size, mime }),
  });
}

async function putBlob(url: string, cookie: string, body: BodyInit, ip = nextIp()) {
  return SELF.fetch(`${ORIGIN}${url}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'CF-Connecting-IP': ip },
    body,
  });
}

describe('上传', () => {
  it('登记元数据后拿到 trackId 与上传地址', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await register(code, cookie, '晴天.mp3', 2048);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { trackId: string; uploadUrl: string };
    expect(body.trackId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.uploadUrl).toBe(`/api/rooms/${code}/tracks/${body.trackId}/blob`);
  });

  it('PUT 字节后，对象真的落在 R2 里且内容一致', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const bytes = fakeSong(4096);

    const init = await register(code, cookie, '晴天.mp3', bytes.length);
    const { trackId, uploadUrl } = (await init.json()) as any;

    const put = await putBlob(uploadUrl, cookie, bytes);
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).size).toBe(bytes.length);

    const stored = await bucket.get(`rooms/${code}/tracks/${trackId}`);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  it('中文文件名能正确存进 R2 的元数据（HTTP 头是 Latin-1，必须编码）', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, '01. 晴天 - 周杰伦.mp3');

    const stored = await bucket.get(`rooms/${code}/tracks/${trackId}`);
    expect(decodeURIComponent(stored!.customMetadata!.name!)).toBe('01. 晴天 - 周杰伦.mp3');
  });

  it('上传后房间曲目表与队列都包含这首歌', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, '晴天.mp3', fakeSong(16));

    const state = await stateOf(code, cookie);
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0]).toMatchObject({ id: trackId, name: '晴天.mp3', size: 16 });
    expect(state.tracks[0].uploaderName).toBe('阿甲');
    expect(state.queue).toEqual([trackId]);
  });

  it('拒绝超过单文件上限的登记', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await register(code, cookie, '巨无霸.flac', 200 * 1024 * 1024);
    expect(res.status).toBe(413);
  });

  it('体积为 0 或非法时拒绝登记', async () => {
    const { code, cookie } = await roomWith('阿甲');
    expect((await register(code, cookie, 'a.mp3', 0)).status).toBe(400);
    expect((await register(code, cookie, 'a.mp3', -1)).status).toBe(400);
    expect((await register(code, cookie, 'a.mp3', Number.NaN)).status).toBe(400);
  });

  it('没有会话不能登记也不能上传', async () => {
    const code = await newRoom();
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ name: 'x.mp3', size: 16, mime: 'audio/mpeg' }),
    });
    expect(res.status).toBe(401);
  });

  it('实际字节数与登记体积不符时被拒，且不留下半截对象', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const init = await register(code, cookie, 'a.mp3', 1000);
    const { trackId, uploadUrl } = (await init.json()) as any;

    // 声明 1000，实际给 100 —— FixedLengthStream 会判定不符
    const put = await putBlob(uploadUrl, cookie, fakeSong(100));
    expect(put.status).not.toBe(200);
    expect(await bucket.get(`rooms/${code}/tracks/${trackId}`)).toBeNull();
  });

  it('上传不存在的曲目返回 404', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await putBlob(
      `/api/rooms/${code}/tracks/00000000-0000-0000-0000-000000000000/blob`,
      cookie,
      fakeSong(16),
    );
    expect(res.status).toBe(404);
  });
});

describe('上传的安全约束', () => {
  it('非 UUID 的 trackId 不能写入 R2（防路径穿越）', async () => {
    const { code, cookie } = await roomWith('阿甲');
    for (const bad of ['..%2F..%2Fsecret', 'not-a-uuid', 'a'.repeat(40)]) {
      const res = await putBlob(
        `/api/rooms/${code}/tracks/${encodeURIComponent(bad)}/blob`,
        cookie,
        fakeSong(16),
      );
      expect(res.status).toBe(400);
    }
    const listed = await bucket.list({ prefix: `rooms/${code}/` });
    expect(listed.objects).toHaveLength(0);
  });

  it('跨房间的 trackId 不能写入', async () => {
    const a = await roomWith('阿甲');
    const b = await roomWith('阿乙');

    const init = await register(a.code, a.cookie, 'x.mp3', 16);
    const { trackId } = (await init.json()) as any;

    const res = await putBlob(`/api/rooms/${b.code}/tracks/${trackId}/blob`, a.cookie, fakeSong(16));
    expect(res.status).toBe(401);
  });

  it('只有上传者能删云端文件', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, 'a.mp3', fakeSong(16));

    const other = await joinRoom(code, '阿乙');
    expect(other.status).toBe(200);

    const denied = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks/${trackId}`, {
      method: 'DELETE',
      headers: { Cookie: other.cookie, 'CF-Connecting-IP': nextIp() },
    });
    expect(denied.status).toBe(403);
    expect(await bucket.get(`rooms/${code}/tracks/${trackId}`)).not.toBeNull();

    const allowed = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks/${trackId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'CF-Connecting-IP': nextIp() },
    });
    expect(allowed.status).toBe(200);
    expect(await bucket.get(`rooms/${code}/tracks/${trackId}`)).toBeNull();
  });

  it('删除后曲目表与队列都不再包含它', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const trackId = await uploadTrack(code, cookie, 'a.mp3', fakeSong(16));

    await SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks/${trackId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'CF-Connecting-IP': nextIp() },
    });

    const state = await stateOf(code, cookie);
    expect(state.tracks).toHaveLength(0);
    expect(state.queue).toEqual([]);
  });

  it('超过房间曲目数配额时拒绝登记', async () => {
    const { code, cookie } = await roomWith('阿甲');

    // 每次换一个 IP：配额是按房间算的，不该被上传限速（60/分/IP）干扰
    for (let i = 0; i < 200; i++) {
      const res = await register(code, cookie, `t${i}.mp3`, 16);
      expect(res.status).toBe(200);
    }

    const overflow = await register(code, cookie, 'overflow.mp3', 16);
    expect(overflow.status).toBe(413);
  });

  it('超过房间总字节配额时拒绝登记', async () => {
    const { code, cookie } = await roomWith('阿甲');

    // 每首 100 MB，21 首就会越过 2 GB 的房间配额（曲目数上限 200 还没到）
    for (let i = 0; i < 20; i++) {
      const res = await register(code, cookie, `big${i}.flac`, 100 * 1024 * 1024, 'audio/flac');
      expect(res.status).toBe(200);
    }

    const overflow = await register(code, cookie, 'over.flac', 100 * 1024 * 1024, 'audio/flac');
    expect(overflow.status).toBe(413);
  });

  it('上传接口本身受限速保护', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const ip = nextIp();

    let sawTooMany = false;
    for (let i = 0; i < 80; i++) {
      const res = await register(code, cookie, `t${i}.mp3`, 16, 'audio/mpeg', ip);
      if (res.status === 429) {
        sawTooMany = true;
        break;
      }
    }
    expect(sawTooMany).toBe(true);
  });
});
