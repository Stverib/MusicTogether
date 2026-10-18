import { describe, it, expect } from 'vitest';
import {
  CSP,
  audioMimeFor,
  isRoomCode,
  isUuid,
  originAllowed,
  withSecurity,
} from '../../src/server/security';

describe('isUuid', () => {
  it('接受规范 UUID', () => {
    expect(isUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isUuid(crypto.randomUUID())).toBe(true);
  });

  it('拒绝路径穿越与任何非 UUID 形态', () => {
    for (const bad of [
      '../../../etc/passwd',
      '..%2f..%2fsecret',
      'rooms/OTHER/tracks/x',
      '123e4567-e89b-12d3-a456-42661417400', // 少一位
      '123e4567-e89b-12d3-a456-4266141740000', // 多一位
      '123E4567-E89B-12D3-A456-426614174000', // 大写不接受
      '',
      '.',
      '..',
    ]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('audioMimeFor', () => {
  it('白名单内的扩展名映射到正确的音频类型', () => {
    expect(audioMimeFor('晴天.mp3')).toBe('audio/mpeg');
    expect(audioMimeFor('A.FLAC')).toBe('audio/flac');
    expect(audioMimeFor('b.m4a')).toBe('audio/mp4');
  });

  it('未知扩展名一律退回 octet-stream，绝不回显用户内容', () => {
    expect(audioMimeFor('evil.html')).toBe('application/octet-stream');
    expect(audioMimeFor('evil.svg')).toBe('application/octet-stream');
    expect(audioMimeFor('evil.js')).toBe('application/octet-stream');
    expect(audioMimeFor('noext')).toBe('application/octet-stream');
    expect(audioMimeFor('')).toBe('application/octet-stream');
  });

  it('只看最后一个点之后的扩展名', () => {
    expect(audioMimeFor('my.mp3.html')).toBe('application/octet-stream');
    expect(audioMimeFor('01. 晴天.mp3')).toBe('audio/mpeg');
  });

  it('输出永远不含 html / script 字样（存储型 XSS 的核心防线）', () => {
    for (const name of ['x.html', 'x.svg', 'x.xml', 'x.htaccess', '<script>.mp3.html']) {
      expect(audioMimeFor(name)).not.toContain('html');
      expect(audioMimeFor(name)).not.toContain('script');
    }
  });
});

describe('originAllowed', () => {
  const mk = (origin: string | null, url = 'https://app.example.com/api/rooms/X/ws') => {
    const headers = new Headers();
    if (origin !== null) headers.set('Origin', origin);
    return new Request(url, { headers });
  };

  it('同源放行', () => {
    expect(originAllowed(mk('https://app.example.com'))).toBe(true);
  });

  it('跨站拒绝（防 WebSocket CSRF）', () => {
    expect(originAllowed(mk('https://evil.com'))).toBe(false);
    expect(originAllowed(mk('http://app.example.com'))).toBe(false); // 协议不同
    expect(originAllowed(mk('https://app.example.com.evil.com'))).toBe(false);
    expect(originAllowed(mk('https://app.example.com:8443'))).toBe(false); // 端口不同
  });

  it('缺失或畸形的 Origin 一律拒绝', () => {
    expect(originAllowed(mk(null))).toBe(false);
    expect(originAllowed(mk('not a url'))).toBe(false);
    expect(originAllowed(mk(''))).toBe(false);
  });
});

describe('isRoomCode', () => {
  it('合法码通过，长度或字符不合法则失败', () => {
    expect(isRoomCode('K7M2QX')).toBe(true);
    expect(isRoomCode('K7M2Q')).toBe(false);
    expect(isRoomCode('K7M2Q!')).toBe(false);
  });
});

describe('withSecurity', () => {
  it('补上全部安全响应头', async () => {
    const out = withSecurity(new Response('hi'));
    expect(out.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(out.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(out.headers.get('X-Frame-Options')).toBe('DENY');
    expect(out.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(await out.text()).toBe('hi');
  });

  it('不覆盖已有响应头，也不改变状态码', () => {
    const out = withSecurity(new Response('x', { status: 404, headers: { 'X-Custom': 'kept' } }));
    expect(out.status).toBe(404);
    expect(out.headers.get('X-Custom')).toBe('kept');
  });

  it('CSP 不含 unsafe-eval，且禁止内联脚本', () => {
    expect(CSP).not.toContain('unsafe-eval');
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("object-src 'none'");
  });

  // 101 升级响应的放行由 test/integration/room.test.ts 的 WebSocket 用例覆盖 ——
  // node 的 Response 构造器不允许 status 101，这里造不出来
  it('204 这类无响应体状态不会因重新包装而抛异常', () => {
    expect(() => withSecurity(new Response(null, { status: 204 }))).not.toThrow();
    expect(withSecurity(new Response(null, { status: 204 })).status).toBe(204);
  });
});
