import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/files': { target: api, changeOrigin: false },
    },
  },
  optimizeDeps: {
    exclude: ['@sparkjsdev/spark'],
  },
});
