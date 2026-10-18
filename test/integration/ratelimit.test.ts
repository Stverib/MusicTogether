import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ORIGIN, joinRoom, newRoom, nextIp } from './helpers';

describe('限速', () => {
  it('建房：同一个 IP 一分钟内第 11 次开始返回 429，并带 Retry-After', async () => {
    const ip = nextIp();
    const statuses: number[] = [];

    for (let i = 0; i < 14; i++) {
      const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip },
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      }
    }

    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('加入房间的探测次数有限，挡住房间码枚举', async () => {
    const ip = nextIp();
    let sawTooMany = false;
    let firstTooManyAt = -1;

    for (let i = 0; i < 30; i++) {
      const res = await SELF.fetch(`${ORIGIN}/api/rooms/ZZZZZZ/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ name: '攻击者' }),
      });
      if (res.status === 429 && !sawTooMany) {
        sawTooMany = true;
        firstTooManyAt = i;
      }
    }

    expect(sawTooMany).toBe(true);
    expect(firstTooManyAt).toBe(20); // 限额就是 20/分钟
  });

  it('限速按 IP 隔离：一个 IP 被挡不影响另一个', async () => {
    const noisy = nextIp();
    for (let i = 0; i < 12; i++) {
      await SELF.fetch(`${ORIGIN}/api/rooms`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': noisy },
      });
    }
    const blocked = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': noisy },
    });
    expect(blocked.status).toBe(429);

    const quiet = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': nextIp() },
    });
    expect(quiet.status).toBe(200);
  });

  it('被限速时不会顺带创建房间', async () => {
    const ip = nextIp();
    const codes: string[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await SELF.fetch(`${ORIGIN}/api/rooms`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip },
      });
      if (res.status === 200) codes.push(((await res.json()) as { code: string }).code);
    }
    // 429 的响应体里不该有房间码
    const overflow = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
    });
    expect(overflow.status).toBe(429);
    expect(JSON.stringify(await overflow.json())).not.toContain(codes[0]!);
  });

  it('上传也受限速保护', async () => {
    const ip = nextIp();
    const code = await newRoom({ ip });
    const m = await joinRoom(code, '阿甲', { ip });
    expect(m.status).toBe(200);

    let sawTooMany = false;
    for (let i = 0; i < 80; i++) {
      const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: m.cookie, 'CF-Connecting-IP': ip },
        body: JSON.stringify({ name: `t${i}.mp3`, size: 16, mime: 'audio/mpeg' }),
      });
      if (res.status === 429) {
        sawTooMany = true;
        break;
      }
    }
    expect(sawTooMany).toBe(true);
  });

  it('读取类请求不受写限速影响（同一 IP 连读 40 次都正常）', async () => {
    const ip = nextIp();
    const code = await newRoom({ ip });
    const m = await joinRoom(code, '阿甲', { ip });

    for (let i = 0; i < 40; i++) {
      const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/state`, {
        headers: { Cookie: m.cookie, 'CF-Connecting-IP': ip },
      });
      expect(res.status).toBe(200);
    }
  });
});
