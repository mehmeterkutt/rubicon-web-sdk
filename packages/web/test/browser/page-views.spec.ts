import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from './fixtures';

// Page views of step 7.6 in the three engines (Web Lifecycle 1, 2, 5, 8), through the script build:
// the load's view, the history registry over each engine's own `history`, a real `popstate` from
// `history.back()`, the 500 ms window, hiding, a restore from the back/forward cache and a page loaded
// hidden. The rules themselves are unit-tested in jsdom on virtual time (test/unit/page-views.test.ts).
//
// As in page-lifecycle.spec.ts (plan section 15, step 7.4): a headless page never becomes hidden, so
// `hidden` and `visible` are the engine's own `visibilitychange` with `document.visibilityState`
// replaced on the document, and no engine restores from the back/forward cache under Playwright, so a
// restore is the engine's own `PageTransitionEvent` with `persisted`. The window's 500 ms pass in
// real time; the test waits on the server, never on a fixed sleep.

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));
const API_KEY = 'rk_page_views';

interface WireEvent {
  readonly event?: string;
  readonly source?: string;
  readonly timestamp?: number;
  readonly properties?: Record<string, unknown>;
  readonly context: { readonly page?: { readonly url?: string }; readonly session?: unknown };
}

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

/** Loads the script build and creates the instance, `window.__analytics`; nothing else is done. */
async function start(page: Page, server: TestServer, config: Record<string, unknown> = {}): Promise<void> {
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    ({ apiKey, host, extra }) => {
      const rubicon = Reflect.get(window, 'Rubicon') as { createAnalytics: (config: unknown) => unknown };
      Reflect.set(window, '__analytics', rubicon.createAnalytics({ apiKey, host, ...extra }));
    },
    { apiKey: API_KEY, host: server.origin(), extra: config },
  );
}

function flush(page: Page): Promise<void> {
  return page.evaluate(() => {
    (Reflect.get(window, '__analytics') as { flush: () => void }).flush();
  });
}

function sent(server: TestServer): WireEvent[] {
  return server.requests
    .filter((request) => request.method === 'POST' && request.path === '/v1/batch')
    .flatMap((request: RecordedRequest) => (JSON.parse(request.body) as { batch: WireEvent[] }).batch);
}

function views(server: TestServer): WireEvent[] {
  return sent(server).filter((event) => event.event === 'Page Viewed');
}

/** Flushes until the server has seen `count` page views; their paths, in order. */
async function viewedPaths(page: Page, server: TestServer, count: number): Promise<string[]> {
  await expect
    .poll(async () => {
      await flush(page);
      return views(server).length;
    })
    .toBeGreaterThanOrEqual(count);
  return views(server).map((event) => new URL(event.context.page?.url ?? 'about:blank').pathname);
}

/** The engine's `visibilitychange` with `document.visibilityState` replaced on the document. */
function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  return page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('the load sends one view with its own URL and campaign, never carried to later events', async ({
  page,
  server,
}) => {
  await page.goto(server.url('/pages/blank.html?utm_source=news&utm_medium=&gclid=abc#top', TEST_HOST_A));
  await start(page, server);
  await page.evaluate(() => {
    // An application that strips the campaign right after the load (Web Lifecycle 5).
    history.replaceState(null, '', location.pathname);
    (Reflect.get(window, '__analytics') as { track: (name: string) => void }).track('Searched');
  });

  expect(await viewedPaths(page, server, 1)).toEqual(['/pages/blank.html']);
  const [view] = views(server);
  expect(view).toMatchObject({ source: 'auto', properties: { utm_source: 'news' } });
  expect(view?.context.session).toBeDefined();
  const searched = sent(server).find((event) => event.event === 'Searched');
  expect(searched?.properties).toEqual({});
});

test('history: a redirect in the window is one view, two pushes two, popstate one, a hash none', async ({
  page,
  server,
}) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await start(page, server);
  expect(await viewedPaths(page, server, 1)).toEqual(['/pages/blank.html']);

  await page.evaluate(() => {
    history.pushState(null, '', '/pages/orders');
    history.replaceState(null, '', '/pages/login');
  });
  expect(await viewedPaths(page, server, 2)).toEqual(['/pages/blank.html', '/pages/login']);

  await page.evaluate(() => {
    history.pushState(null, '', '/pages/a');
    history.pushState(null, '', '/pages/b');
    history.pushState(null, '', '/pages/b#reviews');
  });
  expect(await viewedPaths(page, server, 4)).toEqual(['/pages/blank.html', '/pages/login', '/pages/a', '/pages/b']);

  // A real popstate from the engine: back from the fragment is no navigation, back again to /a is one.
  await page.evaluate(() => {
    history.back();
  });
  await page.waitForFunction(() => location.hash === '');
  await page.evaluate(() => {
    history.back();
  });
  await page.waitForFunction(() => location.pathname === '/pages/a');
  expect(await viewedPaths(page, server, 5)).toEqual([
    '/pages/blank.html',
    '/pages/login',
    '/pages/a',
    '/pages/b',
    '/pages/a',
  ]);
});

test('hiding sends the pending view at once; a restore from the cache is a view; showing is none', async ({
  page,
  server,
}) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await start(page, server);
  expect(await viewedPaths(page, server, 1)).toEqual(['/pages/blank.html']);

  await page.evaluate(() => {
    history.pushState(null, '', '/pages/hidden');
  });
  await setVisibility(page, 'hidden');
  // The hiding's own upload carries it: no flush asked for.
  await expect.poll(() => views(server).length).toBe(2);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await setVisibility(page, 'visible');
  expect(await viewedPaths(page, server, 3)).toEqual(['/pages/blank.html', '/pages/hidden', '/pages/hidden']);
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await flush(page);
  await expect.poll(() => server.requests.filter((request) => request.method === 'POST').length).toBeGreaterThan(0);
  expect(views(server)).toHaveLength(3);
});

test('a page loaded hidden sends its view when first visible, with that moment', async ({ page, server }) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await start(page, server);
  await page.evaluate(() => {
    history.pushState(null, '', '/pages/shown');
  });
  await flush(page);
  const before = await page.evaluate(() => Date.now());

  await setVisibility(page, 'visible');

  expect(await viewedPaths(page, server, 1)).toEqual(['/pages/shown']);
  expect(views(server)[0]?.timestamp).toBeGreaterThanOrEqual(before);
});

test('with page_views off nothing is wrapped and no view is sent', async ({ page, server }) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.evaluate(() => {
    Reflect.set(window, '__pushState', Reflect.get(history, 'pushState'));
  });
  await start(page, server, { autocapture: { enabled: ['sessions'] } });
  await page.evaluate(() => {
    const analytics = Reflect.get(window, '__analytics') as { track: (name: string) => void };
    analytics.track('Started');
    history.pushState(null, '', '/pages/next');
  });

  await expect
    .poll(async () => {
      await flush(page);
      return sent(server).some((event) => event.event === 'Started');
    })
    .toBe(true);
  expect(views(server)).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        Reflect.get(history, 'pushState') === Reflect.get(window, '__pushState') &&
        !Reflect.has(window, Symbol.for('rubicon.history')),
    ),
  ).toBe(true);
});
