// The consumer checks of step 8.2, in plain Node, over what `pnpm -r build` installed into temp/.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each compile of the TypeScript fixture takes about a second; six run here.
    testTimeout: 60_000,
  },
});
