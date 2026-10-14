import { defineConfig } from 'vitest/config';
import { sdkVersion } from '../../scripts/sdk-version.mjs';

export default defineConfig({
  define: { __VERSION__: JSON.stringify(sdkVersion()) },
  test: {
    environment: 'jsdom',
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: { lines: 80 },
    },
  },
});
