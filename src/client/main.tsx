import { render } from 'preact';
import { App } from './app';

// Service Worker 注册放在这里，而不是 index.html 里的内联 <script>。
// 内联脚本会被 CSP 的 script-src 'self' 挡掉（PWA 装不上、断网打不开），
// 而给 CSP 开 'unsafe-inline' 等于把 XSS 防线拆了。
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

const root = document.getElementById('app');
if (root) render(<App />, root);
