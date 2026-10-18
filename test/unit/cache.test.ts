import { describe, it, expect, vi } from 'vitest';
import { createUrlPool } from '../../src/client/cache';

describe('对象 URL 池', () => {
  it('同一个 key 只创建一次 URL', () => {
    const create = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const pool = createUrlPool(create);

    const a = pool.acquire('t1', new Blob([new Uint8Array(10)]));
    const b = pool.acquire('t1', new Blob([new Uint8Array(10)]));

    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('不同的 key 各自创建', () => {
    const pool = createUrlPool((b) => `blob:${b.size}`);
    expect(pool.acquire('t1', new Blob([new Uint8Array(1)]))).not.toBe(
      pool.acquire('t2', new Blob([new Uint8Array(2)])),
    );
  });

  it('释放后回收，再次获取会重新创建', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const pool = createUrlPool(
      () => {
        const u = `blob:${created.length}`;
        created.push(u);
        return u;
      },
      (u) => revoked.push(u),
    );

    const a = pool.acquire('t1', new Blob([]));
    pool.release('t1');
    expect(revoked).toEqual([a]);

    const b = pool.acquire('t1', new Blob([]));
    expect(b).not.toBe(a);
    expect(created).toHaveLength(2);
  });

  it('释放不存在的 key 不报错', () => {
    const pool = createUrlPool(() => 'blob:x', () => {});
    expect(() => pool.release('nope')).not.toThrow();
  });

  it('重复释放同一个 key 不会 revoke 两次', () => {
    const revoked: string[] = [];
    const pool = createUrlPool(() => 'blob:x', (u) => revoked.push(u));
    pool.acquire('t1', new Blob([]));
    pool.release('t1');
    pool.release('t1');
    expect(revoked).toEqual(['blob:x']);
  });

  it('releaseAll 清空全部', () => {
    const revoked: string[] = [];
    const pool = createUrlPool((b) => `blob:${b.size}`, (u) => revoked.push(u));
    pool.acquire('a', new Blob([new Uint8Array(1)]));
    pool.acquire('b', new Blob([new Uint8Array(2)]));
    pool.releaseAll();
    expect(revoked).toHaveLength(2);
  });

  it('releaseAll 之后可以重新获取', () => {
    const pool = createUrlPool((b) => `blob:${b.size}`, () => {});
    pool.acquire('a', new Blob([new Uint8Array(1)]));
    pool.releaseAll();
    expect(pool.acquire('a', new Blob([new Uint8Array(9)]))).toBe('blob:9');
  });
});
