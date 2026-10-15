import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from './fixtures';

// The context of step 7.5 in the three engines (Web Context 1 to 4): what each engine's own values
// give through the script build, the page values read inside each call across a `pushState`, the
// static values read once, and nothing of the query, the fragment or the raw user agent on the wire.
// The parse itself is tested over a fixed list of strings in test/unit/user-agent.test.ts; Playwright
// sets each project's user agent from its device descriptor, and its WebKit is not Safari (plan
// section 15, step 1.3), so the tablet rules are unit-tested only.

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));

test.use({
  locale: 'tr-TR',
  timezoneId: 'Europe/Istanbul',
  viewport: { width: 1000, height: 700 },
});

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

interface WireContext {
  readonly device?: { readonly type?: string };
  readonly os?: { readonly name?: string };
  readonly browser?: { readonly name?: string; readonly version?: string };
  readonly screen?: { readonly width?: number; readonly height?: number; readonly density?: number };
  readonly page?: Record<string, unknown>;
  readonly locale?: string;
  readonly timezone?: string;
}

interface WireEvent {
  readonly event?: string;
  readonly source?: string;
  readonly context: WireContext;
}

async function start(page: Page, server: TestServer, config: Record<string, unknown>): Promise<void> {
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    ({ host, extra }) => {
      const rubicon = Reflect.get(window, 'Rubicon') as { createAnalytics: (config: unknown) => unknown };
      Reflect.set(window, '__analytics', rubicon.createAnalytics({ apiKey: 'rk_context', host, ...extra }));
    },
    { host: server.origin(), extra: config },
  );
}

function track(page: Page, name: string): Promise<void> {
  return page.evaluate((event) => {
    (Reflect.get(window, '__analytics') as { track: (name: string) => void }).track(event);
  }, name);
}

async function appEvents(page: Page, server: TestServer): Promise<WireEvent[]> {
  await page.evaluate(() => {
    (Reflect.get(window, '__analytics') as { flush: () => void }).flush();
  });
  const batches = () => server.requests.filter((request) => request.method === 'POST' && request.path === '/v1/batch');
  await expect.poll(() => batches().length).toBeGreaterThan(0);
  return batches()
    .flatMap((request: RecordedRequest) => (JSON.parse(request.body) as { batch: WireEvent[] }).batch)
    .filter((event) => event.source === 'app');
}

test('each engine fills the groups from its own values, page values read in each call', async ({
  page,
  server,
  browserName,
}) => {
  const referrer = server.url('/pages/from/12345?secret=1', TEST_HOST_A);
  await page.goto(server.url('/pages/blank.html?page=2&sort=price&token=abc#top', TEST_HOST_A), { referer: referrer });
  await start(page, server, { context: { page: { queryParams: ['page', 'sort'], title: true } } });

  // The engine's own screen, before the viewport changes below: a headless page's screen follows its
  // viewport, and the static values of the first event must stay (Web Context 4).
  const [short, long] = await page.evaluate(() => [screen.width, screen.height].sort((a, b) => a - b));
  const density = await page.evaluate(() => devicePixelRatio);
  await track(page, 'First');
  await page.evaluate(() => {
    history.pushState(null, '', '/pages/orders/3f2a9c1e-0b1c-4d2e-8f3a-7b2d9c1e0b1c?page=3&token=xyz');
    document.title = 'Order';
  });
  await page.setViewportSize({ width: 800, height: 600 });
  await track(page, 'Second');

  const [first, second] = await appEvents(page, server);
  const origin = new URL(server.url('/', TEST_HOST_A)).origin;
  expect(first?.context.page).toEqual({
    url: `${origin}/pages/blank.html`,
    referrer: `${origin}/pages/from/:id`,
    viewport_width: 1000,
    viewport_height: 700,
    query: { page: '2', sort: 'price' },
    title: 'blank',
  });
  expect(second?.context.page).toEqual({
    url: `${origin}/pages/orders/:id`,
    referrer: `${origin}/pages/from/:id`,
    viewport_width: 800,
    viewport_height: 600,
    query: { page: '3' },
    title: 'Order',
  });

  for (const event of [first, second]) {
    expect(event?.context).toMatchObject({
      locale: 'tr-TR',
      timezone: 'Europe/Istanbul',
      screen: { width: short, height: long, density },
      device: { type: 'desktop' },
    });
    expect(event?.context.browser?.version).toMatch(/^\d+$/);
  }
  const expected: Record<string, { os: string; browser: string }> = {
    chromium: { os: 'Windows', browser: 'Chrome' },
    firefox: { os: 'Windows', browser: 'Firefox' },
    webkit: { os: 'macOS', browser: 'Safari' },
  };
  expect({ os: first?.context.os?.name, browser: first?.context.browser?.name }).toEqual(expected[browserName]);
  expect(second?.context.browser).toEqual(first?.context.browser);

  const body = server.requests.map((request) => request.body).join('\n');
  expect(body).not.toContain('token');
  expect(body).not.toContain('secret');
  expect(body).not.toContain('#top');
  expect(body).not.toContain(await page.evaluate(() => navigator.userAgent));
});

test('disabled fields stay out of every event', async ({ page, server }) => {
  await page.goto(server.url('/pages/blank.html?page=2', TEST_HOST_A));
  await start(page, server, {
    context: {
      disabledFields: ['page.url', 'page.query', 'browser.name', 'browser.version', 'screen.width', 'locale'],
      page: { queryParams: ['page'] },
    },
  });

  await track(page, 'Only');

  const [event] = await appEvents(page, server);
  expect(event?.context.page).toEqual({ viewport_width: 1000, viewport_height: 700 });
  expect(event?.context.browser).toBeUndefined();
  expect(event?.context.screen).not.toHaveProperty('width');
  expect(event?.context).not.toHaveProperty('locale');
  expect(event?.context.timezone).toBe('Europe/Istanbul');
});
