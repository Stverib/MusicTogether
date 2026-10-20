import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 把 three 单独拆出来。它只在进房间之后才被动态 import，
        // 拆出来才能让首屏不背这 150 KB（gzip 后），也才能让 E2E
        // 按文件名拦住它来模拟"拉不下来"这条降级路径。
        //
        // 用 codeSplitting 而不是 manualChunks 的对象形式：Vite 8 走 rolldown，
        // 它只认函数形式的 manualChunks（对象形式直接报 "manualChunks is not
        // a function"），而 advancedChunks 这个名字在 rolldown 里也已废弃
        codeSplitting: {
          groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
  plugins: [preact()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        // 保留浏览器的 Host，否则 Worker 看到的 request origin 是 8787，
        // 而 WS 的 Origin 仍是 5173，会被 originAllowed 拒成 403
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
