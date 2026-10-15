import type { Page } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from '../fixtures';

// The framework fixtures of step 8.1 (D19): a React Router, a Vue Router and a Next.js app on the
// npm package (packages/web/test/frameworks, built by `pnpm -r build`), each with the redirects its
// developers write, against the 500 ms window of Web Lifecycle 2. Every history call the app makes
// is timed below the SDK's wrapper; a redirect after a navigation must land inside the window, so
// that the navigation and its redirect are one `Page Viewed`. The measured times are recorded in
// plan section 15 (step 8.1). The redirect right after the load (the step 7.6 question) is pinned
// as each framework produces it today.

const API_KEY = 'rk_frameworks';
/** The window of Web Lifecycle 2 (`PAGE_VIEW_WINDOW_MS`, internal, provisional until this step). */
const WINDOW_MS = 500;

interface HistoryCall {
  readonly kind: 'pushState' | 'replaceState';
  readonly path: string;
  readonly at: number;
}

interface WireEvent {
  readonly event?: string;
  readonly context: { readonly page?: { readonly url?: string } };
}

/**
 * The apps, and the views a redirect right after the load gives today. React Router and Next.js
 * redirect after the instance has started, so the load's view (the URL read at `createAnalytics`)
 * and the redirect's are two; Vue Router finishes its first navigation, redirect included, before
 * the instance starts, so its redirect makes no view and the load's view keeps the URL the visitor
 * never saw (measured 2026-10-15, plan section 15, step 8.1).
 */
const APPS = [
  { name: 'React Router', base: '/frameworks/react-router/', viewsAfterLoadRedirect: ['/', '/login'] },
  { name: 'Vue Router', base: '/frameworks/vue-router/', viewsAfterLoadRedirect: ['/'] },
  { name: 'Next.js', base: '/frameworks/next/', viewsAfterLoadRedirect: ['/', '/login'] },
] as const;

/**
 * Before the app's own scripts: the configuration the fixture reads (`window.__rubiconTest`) and a
 * recorder of every `pushState` and `replaceState`, with the path after the call and its time.
 */
async function prepare(page: Page, server: TestServer): Promise<void> {
  await page.addInitScript(
    ({ apiKey, host }) => {
      const calls: { kind: string; path: string; at: number }[] = [];
      Reflect.set(window, '__historyCalls', calls);
      for (const kind of ['pushState', 'replaceState'] as const) {
        const original = Reflect.get(history, kind) as History['pushState'];
        history[kind] = function (this: History, ...args: Parameters<History['pushState']>) {
          original.apply(this, args);
          calls.push({ kind, path: location.pathname, at: performance.now() });
        };
      }
      Reflect.set(window, '__rubiconTest', { apiKey, host });
    },
    { apiKey: API_KEY, host: server.origin() },
  );
}

function historyCalls(page: Page): Promise<HistoryCall[]> {
  return page.evaluate(() => (Reflect.get(window, '__historyCalls') as HistoryCall[]).slice());
}

function views(server: TestServer): string[] {
  return server.requests
    .filter((request: RecordedRequest) => request.method === 'POST' && request.path === '/v1/batch')
    .flatMap((request) => (JSON.parse(request.body) as { batch: WireEvent[] }).batch)
    .filter((event) => event.event === 'Page Viewed')
    .map((event) => new URL(event.context.page?.url ?? 'about:blank').pathname);
}

/** Flushes until the server has `count` page views, waiting out the window; their paths. */
async function viewedPaths(page: Page, server: TestServer, count: number): Promise<string[]> {
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        (Reflect.get(window, '__analytics') as { flush: () => void } | undefined)?.flush();
      });
      return views(server).length;
    })
    .toBeGreaterThanOrEqual(count);
  return views(server);
}

/** Paths relative to the app's base, `/` for the base itself. */
function routes(base: string, paths: readonly string[]): string[] {
  return paths.map((path) => `/${path.slice(base.length).replace(/^\//, '')}`);
}

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

for (const app of APPS) {
  test.describe(app.name, () => {
    test('a redirect after a navigation lands inside the window and is one view', async ({ page, server }) => {
      await prepare(page, server);
      await page.goto(server.url(app.base, TEST_HOST_A));
      expect(routes(app.base, await viewedPaths(page, server, 1))).toEqual(['/']);
      const before = (await historyCalls(page)).length;

      await page.click('#orders');
      await page.waitForSelector('#login');

      expect(routes(app.base, await viewedPaths(page, server, 2))).toEqual(['/', '/login']);
      const calls = (await historyCalls(page)).slice(before);
      const push = calls.find((call) => call.kind === 'pushState' && call.path.endsWith('/orders'));
      const redirect = calls.find((call) => call.kind === 'replaceState' && call.path.endsWith('/login'));
      expect(push).toBeDefined();
      expect(redirect).toBeDefined();
      const delay = (redirect?.at ?? Infinity) - (push?.at ?? 0);
      test.info().annotations.push({ type: 'redirect after push (ms)', description: delay.toFixed(1) });
      expect(delay).toBeLessThan(WINDOW_MS);
    });

    test('a redirect right after the load', async ({ page, server }) => {
      await prepare(page, server);
      await page.goto(server.url(`${app.base}?redirect`, TEST_HOST_A));
      await page.waitForSelector('#login');
      const calls = await historyCalls(page);
      const redirect = calls.find((call) => call.path.endsWith('/login'));
      test.info().annotations.push({
        type: 'redirect after navigation start (ms)',
        description: `${redirect?.kind ?? 'none'} at ${(redirect?.at ?? NaN).toFixed(1)}`,
      });

      // Pinned as built (section 15, step 7.6, the user's answer A): the load's view keeps the URL
      // read at `createAnalytics`, and a redirect after the instance started is a view of its own.
      // A flush after the window has passed collects every view there will be.
      await page.waitForFunction((at) => performance.now() > at, (redirect?.at ?? 0) + WINDOW_MS);
      const expected = app.viewsAfterLoadRedirect;
      expect(routes(app.base, await viewedPaths(page, server, expected.length))).toEqual(expected);
    });
  });
}

test('Vue Router: a guard redirect is a single push and one view', async ({ page, server }) => {
  const base = '/frameworks/vue-router/';
  await prepare(page, server);
  await page.goto(server.url(base, TEST_HOST_A));
  expect(routes(base, await viewedPaths(page, server, 1))).toEqual(['/']);
  const before = (await historyCalls(page)).length;

  await page.click('#account');
  await page.waitForSelector('#login');

  expect(routes(base, await viewedPaths(page, server, 2))).toEqual(['/', '/login']);
  // Vue Router stores the scroll position with a replaceState of the same path before it pushes.
  const changes = (await historyCalls(page)).slice(before).filter((call) => call.path !== base);
  expect(changes.map((call) => [call.kind, call.path.slice(base.length)])).toEqual([['pushState', 'login']]);
});
