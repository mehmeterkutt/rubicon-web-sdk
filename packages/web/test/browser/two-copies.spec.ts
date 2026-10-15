import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from './fixtures';

// Two copies of the SDK on one page, in the three engines (step 8.1; Web Configuration 3, Web
// Lifecycle 2): the script build and the ESM entry imported by the page, as a site whose tag
// manager loads the script build while its bundle carries the package. They share one instance
// through the page marker and wrap `history` once through the registry. What the second copy's
// `createTrackedFetch` does with the first copy's instance is pinned as built (section 15, step
// 7.7: it finds no capture and passes every request through), for the user's decision.

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));
const API_KEY = 'rk_two_copies';

interface WireEvent {
  readonly event?: string;
  readonly source?: string;
  readonly context: { readonly page?: { readonly url?: string } };
}

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

/**
 * The script build's copy creates the instance (`window.__analytics`); the ESM copy is imported and
 * its `createAnalytics` called with the same configuration (`window.__second`), its module kept as
 * `window.__esm`. Log lines of both calls go to `window.__lines`.
 */
async function twoCopies(page: Page, server: TestServer): Promise<void> {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    async ({ apiKey, host }) => {
      const lines: string[] = [];
      Reflect.set(window, '__lines', lines);
      const config = {
        apiKey,
        host,
        logging: { level: 'debug', logger: (level: string, message: string) => lines.push(`${level} ${message}`) },
      };
      const first = Reflect.get(window, 'Rubicon') as { createAnalytics: (c: unknown) => unknown };
      Reflect.set(window, '__analytics', first.createAnalytics(config));
      const entry = '/dist/index.mjs';
      const esm = (await import(entry)) as { createAnalytics: (c: unknown) => unknown };
      Reflect.set(window, '__esm', esm);
      Reflect.set(window, '__second', esm.createAnalytics(config));
    },
    { apiKey: API_KEY, host: server.origin() },
  );
}

function sent(server: TestServer): WireEvent[] {
  return server.requests
    .filter((request) => request.method === 'POST' && request.path === '/v1/batch')
    .flatMap((request: RecordedRequest) => (JSON.parse(request.body) as { batch: WireEvent[] }).batch);
}

async function flushUntil(page: Page, server: TestServer, done: (events: WireEvent[]) => boolean): Promise<void> {
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        (Reflect.get(window, '__analytics') as { flush: () => void }).flush();
      });
      return done(sent(server));
    })
    .toBe(true);
}

test('the second copy returns the first copy’s instance and history is wrapped once', async ({ page, server }) => {
  await twoCopies(page, server);

  expect(await page.evaluate(() => Reflect.get(window, '__second') === Reflect.get(window, '__analytics'))).toBe(true);
  const lines = await page.evaluate(() => (Reflect.get(window, '__lines') as string[]).slice());
  expect(lines.filter((line) => line.startsWith('error SECOND_INSTANCE:'))).toHaveLength(1);

  await page.evaluate(() => {
    history.pushState(null, '', '/pages/next');
    history.pushState(null, '', '/pages/after');
  });
  const views = () =>
    sent(server)
      .filter((event) => event.event === 'Page Viewed')
      .map((event) => new URL(event.context.page?.url ?? 'about:blank').pathname);
  await flushUntil(page, server, () => views().length >= 3);
  expect(views()).toEqual(['/pages/blank.html', '/pages/next', '/pages/after']);
});

test('createTrackedFetch of each copy given the shared instance: the first captures, the second passes through', async ({
  page,
  server,
}) => {
  await twoCopies(page, server);

  const statuses = await page.evaluate(async () => {
    type Factory = (analytics: unknown, options: unknown) => (input: string) => Promise<Response>;
    const analytics = Reflect.get(window, '__analytics') as unknown;
    const first = (Reflect.get(window, 'Rubicon') as { createTrackedFetch: Factory }).createTrackedFetch;
    const second = (Reflect.get(window, '__esm') as { createTrackedFetch: Factory }).createTrackedFetch;
    const options = { hosts: [location.hostname] };
    return [
      (await first(analytics, options)('/pages/blank.html?copy=first')).status,
      (await second(analytics, options)('/pages/blank.html?copy=second')).status,
    ];
  });

  expect(statuses).toEqual([200, 200]);
  await flushUntil(page, server, (events) => events.some((event) => event.event === 'Network Request'));
  expect(sent(server).filter((event) => event.event === 'Network Request')).toHaveLength(1);
});
