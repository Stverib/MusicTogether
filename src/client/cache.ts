const DB_NAME = 'musictogether';
const DB_VERSION = 1;
const STORE = 'tracks';

export type CachedEntry = { trackId: string; blob: Blob; size: number; at: number };

/**
 * 对象 URL 的创建与回收。
 *
 * 抽成独立函数是为了能在没有 DOM 的测试环境里验证生命周期 ——
 * 忘记 revoke 会一直占着内存，这类 bug 在浏览器里很难发现。
 */
export function createUrlPool(
  create: (blob: Blob) => string = (b) => URL.createObjectURL(b),
  revoke: (url: string) => void = (u) => URL.revokeObjectURL(u),
) {
  const urls = new Map<string, string>();

  return {
    acquire(trackId: string, blob: Blob): string {
      const existing = urls.get(trackId);
      if (existing) return existing;
      const url = create(blob);
      urls.set(trackId, url);
      return url;
    },
    release(trackId: string): void {
      const url = urls.get(trackId);
      if (!url) return;
      revoke(url);
      urls.delete(trackId);
    },
    releaseAll(): void {
      for (const url of urls.values()) revoke(url);
      urls.clear();
    },
  };
}

export const urlPool = createUrlPool();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'trackId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

let persistRequested = false;

async function ensurePersistent(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  try {
    // 不申请的话，系统存储吃紧时浏览器可能悄悄清掉缓存
    await navigator.storage?.persist?.();
  } catch {
    // 用户拒绝或不支持 —— 缓存降级为"尽力而为"
  }
}

export async function cacheTrack(trackId: string, url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`缓存失败 (${res.status})`);
  const blob = await res.blob();
  await ensurePersistent();
  await tx('readwrite', (s) =>
    s.put({ trackId, blob, size: blob.size, at: Date.now() } satisfies CachedEntry),
  );
}

export async function getCached(trackId: string): Promise<CachedEntry | null> {
  try {
    return (await tx<CachedEntry | undefined>('readonly', (s) => s.get(trackId))) ?? null;
  } catch {
    return null;
  }
}

/** 有缓存就返回可直接喂给 <audio> 的 blob URL，否则 null */
export async function getCachedUrl(trackId: string): Promise<string | null> {
  const entry = await getCached(trackId);
  if (!entry) return null;
  return urlPool.acquire(trackId, entry.blob);
}

export async function listCached(): Promise<CachedEntry[]> {
  try {
    const all = await tx<CachedEntry[]>('readonly', (s) => s.getAll() as IDBRequest<CachedEntry[]>);
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function deleteCached(trackId: string): Promise<void> {
  urlPool.release(trackId);
  await tx('readwrite', (s) => s.delete(trackId));
}

export async function clearCache(): Promise<void> {
  urlPool.releaseAll();
  await tx('readwrite', (s) => s.clear());
}

export async function estimateUsage(): Promise<{ usage: number; quota: number }> {
  try {
    const e = await navigator.storage?.estimate?.();
    return { usage: e?.usage ?? 0, quota: e?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
