// The built package in plain Node, without jsdom (Web Public API 7): runs after the build.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/ssr/**/*.test.ts'],
  },
});
