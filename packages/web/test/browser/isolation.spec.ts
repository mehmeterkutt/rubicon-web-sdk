import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import { TEST_HOST_A, expect, test } from './fixtures';

// The isolation of the worker's server between tests (test/browser/fixtures.ts): an upload one test
// leaves in flight never reaches the next test of the worker. The first test stands in for the
// storage-event test of page-lifecycle.spec.ts on a loaded machine: two tabs of its own context, one
// opts in, and the test ends while the upload of their accepted events waits for its preflight
// (`preflightDelayMs`, still running after the server's reset); the second waits longer for its own.
// Serial, so both run in one worker in this order. Without the context going offline after each
// test, Firefox records the first test's batches in the second (plan section 15, step 7.6).

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));
const LEFT_KEY = 'rk_isolation_left';
const NEXT_KEY = 'rk_isolation_next';

test.describe.configure({ mode: 'serial' });

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

async function openTab(context: BrowserContext, origin: string, url: string, config: Record<string, unknown>) {
  const tab = await context.newPage();
  await tab.goto(url);
  await tab.addScriptTag({ path: scriptBuild });
  await tab.evaluate(
    ({ host, extra }) => {
      const rubicon = Reflect.get(window, 'Rubicon') as { createAnalytics: (config: unknown) => unknown };
      Reflect.set(window, '__analytics', rubicon.createAnalytics({ host, ...extra }));
    },
    { host: origin, extra: config },
  );
  return tab;
}

test('a test whose tabs leave an upload in flight when it ends', async ({ context, server }) => {
  server.preflightDelayMs = 200;
  const config = { apiKey: LEFT_KEY, privacy: { defaultConsent: 'pending' } };
  const url = server.url('/pages/blank.html', TEST_HOST_A);
  const waiting = await openTab(context, server.origin(), url, config);
  const deciding = await openTab(context, server.origin(), url, config);
  for (const tab of [waiting, deciding]) {
    await tab.evaluate(() => (Reflect.get(window, '__analytics') as { isOptedOut: boolean }).isOptedOut);
  }

  await deciding.evaluate(() => {
    (Reflect.get(window, '__analytics') as { optIn: () => void }).optIn();
  });

  await expect.poll(() => server.preflights.length).toBeGreaterThan(0);
});

test('the next test of the worker receives only its own requests', async ({ page, server }) => {
  // Its own upload is answered after the earlier one would have been, so when it arrives anything the
  // earlier test left in flight has arrived too: no waiting for an absence.
  server.preflightDelayMs = 400;
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    ({ apiKey, host }) => {
      const rubicon = Reflect.get(window, 'Rubicon') as { createAnalytics: (config: unknown) => unknown };
      Reflect.set(window, '__analytics', rubicon.createAnalytics({ apiKey, host }));
    },
    { apiKey: NEXT_KEY, host: server.origin() },
  );
  const batches = () => server.requests.filter((request) => request.path === '/v1/batch');
  // The load's view waits in its window (plan section 15, step 8.1): flushed until it has gone.
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        (Reflect.get(window, '__analytics') as { flush: () => void }).flush();
      });
      return batches().some((request) => request.headers['authorization'] === `Bearer ${NEXT_KEY}`);
    })
    .toBe(true);

  expect(batches().map((request) => request.headers['authorization'])).toEqual(
    batches().map(() => `Bearer ${NEXT_KEY}`),
  );
});
