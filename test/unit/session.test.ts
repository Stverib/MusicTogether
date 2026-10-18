import { describe, it, expect } from 'vitest';
import { signSession, verifySession, type SessionPayload } from '../../src/server/session';

const SECRET = 'test-secret-do-not-use-in-prod';
const NOW = 1_700_000_000_000;

function payload(over: Partial<SessionPayload> = {}): SessionPayload {
  return { room: 'K7M2QX', clientId: 'c1', name: '阿甲', exp: NOW + 60_000, ...over };
}

describe('会话令牌', () => {
  it('签发的令牌能被验证，载荷原样返回', async () => {
    const token = await signSession(payload(), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toEqual(payload());
  });

  it('换一个密钥验证失败', async () => {
    const token = await signSession(payload(), SECRET);
    expect(await verifySession(token, 'other-secret', NOW)).toBeNull();
  });

  it('篡改载荷导致签名校验失败', async () => {
    const token = await signSession(payload(), SECRET);
    const [, sig] = token.split('.');
    // 用 ASCII 构造伪造载荷：btoa 只吃 Latin-1，中文会让它抛异常
    const forged = btoa(JSON.stringify(payload({ name: 'attacker' })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifySession(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it('篡改签名导致校验失败', async () => {
    const token = await signSession(payload(), SECRET);
    const [body] = token.split('.');
    expect(await verifySession(`${body}.deadbeef`, SECRET, NOW)).toBeNull();
  });

  it('把签名换成另一个合法载荷的签名也不通过（防重放拼接）', async () => {
    const a = await signSession(payload({ name: '阿甲' }), SECRET);
    const b = await signSession(payload({ name: '阿乙' }), SECRET);
    const mixed = `${a.split('.')[0]}.${b.split('.')[1]}`;
    expect(await verifySession(mixed, SECRET, NOW)).toBeNull();
  });

  it('过期令牌被拒绝', async () => {
    const token = await signSession(payload({ exp: NOW - 1 }), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  it('结构不合法的令牌被拒绝而非抛异常', async () => {
    for (const bad of ['', '.', 'abc', 'a.b.c', '!!!.???', '.onlysig', 'onlybody.']) {
      expect(await verifySession(bad, SECRET, NOW)).toBeNull();
    }
  });

  it('名字含中文与 emoji 也能往返', async () => {
    const token = await signSession(payload({ name: '小明🎵' }), SECRET);
    expect((await verifySession(token, SECRET, NOW))?.name).toBe('小明🎵');
  });

  it('签名合法但载荷字段缺失时被拒绝', async () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    for (const bad of [
      { exp: NOW + 1000 }, // 缺 room 与 clientId
      { room: 'X', exp: NOW + 1000 }, // 缺 clientId
      { room: 'X', clientId: 'c' }, // 缺 exp
      { room: 'X', clientId: 'c', name: 'n', exp: 'soon' }, // exp 类型不对
    ]) {
      const body = b64url(bad);
      const sig = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      );
      let s = '';
      for (const byte of sig) s += String.fromCharCode(byte);
      const token = `${body}.${btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

      // 签名是对的 —— 拒绝的理由必须是"载荷不合法"，而不是"签名不对"
      expect(await verifySession(token, SECRET, NOW)).toBeNull();
    }
  });
});
