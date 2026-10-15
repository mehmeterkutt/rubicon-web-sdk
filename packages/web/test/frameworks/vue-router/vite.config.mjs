// Built into dist/ and served by the test server under /frameworks/vue-router/ (step 8.1).
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/frameworks/vue-router/',
  build: { outDir: 'dist', emptyOutDir: true },
});
