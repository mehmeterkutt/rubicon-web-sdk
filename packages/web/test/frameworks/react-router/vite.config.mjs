// Built into dist/ and served by the test server under /frameworks/react-router/ (step 8.1).
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/frameworks/react-router/',
  build: { outDir: 'dist', emptyOutDir: true },
});
