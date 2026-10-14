// The Playwright fixtures every browser spec that needs the network imports instead of
// `@playwright/test`. Each worker starts its own test server (D14) in its own process, so a spec
// scripts answers and reads recorded requests directly; tests in one worker run one after another and
// the server is reset after each. Plan section 15, step 1.3.
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { TestServer } from 'rubicon-analytics-testing/server';

export { expect } from '@playwright/test';
export { TEST_HOST_A, TEST_HOST_B, TEST_SITE } from 'rubicon-analytics-testing/server';

const pages = fileURLToPath(new URL('pages/', import.meta.url));

interface TestFixtures {
  /** Resets the worker's server after every test; automatic. */
  serverReset: undefined;
}

interface WorkerFixtures {
  /** The worker's test server; fixture pages are under `/pages/`, the API under `/v1/`. */
  server: TestServer;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
    async ({}, use) => {
      const server = await TestServer.start({ files: { '/pages/': pages } });
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  serverReset: [
    async ({ server }, use) => {
      await use(undefined);
      server.reset();
    },
    { auto: true },
  ],
  // WebKit has no host resolver setting, so it reaches the hostnames of D15 through the worker's
  // server acting as its proxy; Chromium and Firefox map them in playwright.config.ts.
  proxy: async ({ browserName, server, proxy }, use) => {
    await use(browserName === 'webkit' ? { server: server.origin() } : proxy);
  },
});
