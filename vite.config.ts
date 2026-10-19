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
        // 用 advancedChunks 而不是 manualChunks 的对象形式：Vite 8 走 rolldown，
        // 它只认函数形式的 manualChunks，对象形式直接报 "manualChunks is not a function"
        advancedChunks: {
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
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
