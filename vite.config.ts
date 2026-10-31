import { defineConfig } from 'vite';

// `npm run dev` serves the UI with hot reload and proxies the API + WebSocket to the live server (`npm run live`, port 8787).
export default defineConfig({
  root: 'src/web',
  base: './',
  build: { outDir: '../../dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
