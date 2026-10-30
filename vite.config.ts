import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  base: './',
  build: { outDir: '../../dist', emptyOutDir: true, sourcemap: false },
  server: { port: 5173 },
});
