import { describe, it, expect } from 'vitest';
import { ORIGIN, SELF, joinRoom, newRoom, nextIp, roomWith, stateOf } from './helpers';

describe('HTTP 路由', () => {
  it('/api/health 返回 ok', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
  });

  it('创建房间返回合法房间码，且房间随即可以加入', async () => {
    const code = await newRoom();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);

    const member = await joinRoom(code, '阿甲');
    expect(member.status).toBe(200);
    expect(member.clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('连续创建的房间码不重复', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 8; i++) codes.add(await newRoom());
    expect(codes.size).toBe(8);
  });

  it('加入不存在的房间返回 404', async () => {
    const member = await joinRoom('ZZZZZZ', '阿甲');
    expect(member.status).toBe(404);
  });

  it('房间码大小写与易混字符都能正确解析', async () => {
    const code = await newRoom();
    // 模拟手抄：小写、加连字符分隔、把 0 看成 o、把 1 看成 l
    const sloppy = code
      .toLowerCase()
      .split('')
      .join('-')
      .replace(/0/g, 'o')
      .replace(/1/g, 'l');
    const member = await joinRoom(sloppy, '阿乙');
    expect(member.status).toBe(200);
  });

  it('非法房间码返回 400', async () => {
    const member = await joinRoom('ABC', '阿甲');
    expect(member.status).toBe(400);
  });

  it('加入后拿到会话 Cookie，/api/me 能读到身份', async () => {
    const { code } = await roomWith('阿甲');
    const member = await joinRoom(code, '阿甲');

    expect(member.cookie).toContain('mt_sess=');
    expect(member.status).toBe(200);

    const me = await SELF.fetch(`${ORIGIN}/api/me`, {
      headers: { Cookie: member.cookie, 'CF-Connecting-IP': nextIp() },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).session.name).toBe('阿甲');
  });

  it('会话 Cookie 带 HttpOnly 与 SameSite，但不带 Secure（本地 http 测试）', async () => {
    const code = await newRoom();
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ name: '阿甲' }),
    });
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('没有会话时访问房间内路由返回 401', async () => {
    const code = await newRoom();
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/state`, {
      headers: { 'CF-Connecting-IP': nextIp() },
    });
    expect(res.status).toBe(401);
  });

  it('伪造的会话令牌被拒绝', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/me`, {
      headers: { Cookie: 'mt_sess=forged.signature', 'CF-Connecting-IP': nextIp() },
    });
    expect(res.status).toBe(401);
  });

  it('拿 A 房间的令牌访问 B 房间返回 401（横向越权）', async () => {
    const a = await roomWith('阿甲');
    const b = await roomWith('阿乙');

    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${b.code}/state`, {
      headers: { Cookie: a.cookie, 'CF-Connecting-IP': nextIp() },
    });
    expect(res.status).toBe(401);
  });

  it('未知路由返回 404', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/nope`, { headers: { 'CF-Connecting-IP': nextIp() } });
    expect(res.status).toBe(404);
  });

  it('/state 返回房间快照', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const state = await stateOf(code, cookie);
    expect(state.code).toBe(code);
    expect(state.queue).toEqual([]);
    expect(state.tracks).toEqual([]);
    expect(state.playback.trackId).toBeNull();
    expect(typeof state.epoch).toBe('number');
  });
});

describe('安全响应头', () => {
  it('所有响应都带安全头', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/health`, { headers: { 'CF-Connecting-IP': nextIp() } });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('出错响应也带安全头', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/nope`, { headers: { 'CF-Connecting-IP': nextIp() } });
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('不发任何 CORS 头', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/health`, {
      headers: { Origin: 'https://evil.com', 'CF-Connecting-IP': nextIp() },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});

describe('WebSocket 升级的 Origin 校验', () => {
  it('同源 Origin 放行', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Cookie: cookie, Origin: ORIGIN, 'CF-Connecting-IP': nextIp() },
    });
    expect(res.status).toBe(101);
  });

  it('跨站 Origin 被拒（防 WebSocket CSRF）', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Cookie: cookie,
        Origin: 'https://evil.com',
        'CF-Connecting-IP': nextIp(),
      },
    });
    expect(res.status).toBe(403);
  });

  it('缺失 Origin 被拒', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Cookie: cookie, 'CF-Connecting-IP': nextIp() },
    });
    expect(res.status).toBe(403);
  });

  it('协议不同也算跨源', async () => {
    const { code, cookie } = await roomWith('阿甲');
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Cookie: cookie,
        Origin: ORIGIN.replace('https://', 'http://'),
        'CF-Connecting-IP': nextIp(),
      },
    });
    expect(res.status).toBe(403);
  });

  it('无会话的升级请求先撞 401，不泄露 Origin 校验逻辑', async () => {
    const code = await newRoom();
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN, 'CF-Connecting-IP': nextIp() },
    });
    expect(res.status).toBe(401);
  });
});
