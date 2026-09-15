import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 하위 경로(/doc-scanner/)에서도 동작하도록 상대 경로
  base: './',
  server: { host: true },
  worker: { format: 'es' },
  build: { target: 'es2020' },
});
