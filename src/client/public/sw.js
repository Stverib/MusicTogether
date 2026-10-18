// 只缓存应用外壳。
//
// 绝不缓存 /api/ —— 音频缓存由 cache.ts 用 IndexedDB 负责，
// 两套缓存叠在一起会互相打架，而且 Service Worker 缓存不受
// navigator.storage.persist() 的保护。

const SHELL = 'mt-shell-v1';
const SHELL_FILES = ['/', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 网络优先，断网时回退到外壳
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r ?? caches.match('/'))),
  );
});
