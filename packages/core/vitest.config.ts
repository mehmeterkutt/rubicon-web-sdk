import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { sdkVersion } from '../../scripts/sdk-version.mjs';

export default defineConfig({
  define: { __VERSION__: JSON.stringify(sdkVersion()) },
  resolve: {
    // The fakes of rubicon-analytics-testing, read from its sources: testing depends on core, so a
    // package dependency back would make a workspace cycle (plan section 15, steps 2.1 and 2.2).
    alias: {
      'rubicon-analytics-testing': fileURLToPath(new URL('../testing/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: { lines: 90 },
    },
  },
});
