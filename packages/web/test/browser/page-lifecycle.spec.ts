import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { DROPPED } from 'rubicon-analytics-testing/server';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from './fixtures';

// The lifecycle and network signals of step 7.4 in the three engines (Web Session 1, Web Queue 1 to
// 3, Web Retry 2 and 3, Web Lifecycle 2, Web Disk 2, Web Privacy 2): the drain and the upload when a
// page hides or is left, the released marker and a restore from the back/forward cache, the `online`
// event's early attempt, the interval caught up when a page that was hidden too long is shown, and
// the `storage` event between two tabs.
//
// What Playwright lets a test do (plan section 15, step 7.4): a page of a headless browser never
// becomes hidden (another tab in front, a minimized window), so `hidden` and `visible` are the
// engine's own `visibilitychange` event with `document.visibilityState` replaced on the document; and
// Playwright keeps every engine from restoring a page from the back/forward cache, so a restore is the
// engine's own `PageTransitionEvent` with `persisted`. A page left by a same-site link click is real
// in all three engines (step 1.4).

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));
const API_KEY = 'rk_page_lifecycle';
/** The default `flush.intervalMs` on the web (Web Queue 4). */
const FLUSH_INTERVAL_MS = 5000;
/** The uploader's delay after `online` (`ONLINE_DELAY_MS`, plan section 15, step 6.4). */
const ONLINE_DELAY_MS = 1000;

interface FetchCall {
  readonly url: string;
  readonly keepalive: boolean;
  readonly encoding: string | undefined;
}

/**
 * Loads the script build into `page` and creates the instance with `config` and a logger that keeps
 * every line in `window.__lines`; the instance is `window.__analytics`. Every call of `window.fetch`
 * (which the transport reads at each request) is recorded in `window.__fetches` first, test code only.
 */
async function start(page: Page, server: TestServer, config: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(() => {
    const calls: FetchCall[] = [];
    Reflect.set(window, '__fetches', calls);
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        keepalive: init?.keepalive === true,
        encoding: headers['Content-Encoding'],
      });
      return original(input, init);
    };
  });
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    ({ apiKey, host, extra }) => {
      const lines: string[] = [];
      Reflect.set(window, '__lines', lines);
      const rubicon = Reflect.get(window, 'Rubicon') as { createAnalytics: (config: unknown) => unknown };
      const analytics = rubicon.createAnalytics({
        apiKey,
        host,
        logging: { level: 'debug', logger: (level: string, message: string) => lines.push(`${level} ${message}`) },
        ...extra,
      });
      Reflect.set(window, '__analytics', analytics);
    },
    { apiKey: API_KEY, host: server.origin(), extra: config },
  );
}

async function track(page: Page, ...names: string[]): Promise<void> {
  await page.evaluate((events) => {
    const analytics = Reflect.get(window, '__analytics') as { track: (name: string) => void };
    events.forEach((name) => {
      analytics.track(name);
    });
  }, names);
}

/**
 * The engine's `visibilitychange` with `document.visibilityState` replaced on the document. Returns
 * the batch uploads `window.fetch` saw while the event was dispatched, so a test can tell an upload
 * started inside the handler (Web HTTP 2) from one started later.
 */
function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<FetchCall[]> {
  return page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
    const calls = Reflect.get(window, '__fetches') as FetchCall[];
    const before = calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    return calls.slice(before).filter((call) => call.url.endsWith('/v1/batch'));
  }, state);
}

/** The engine's `pagehide` or `pageshow` event with `persisted`, as a page entering or leaving the cache gets. */
function pageTransition(page: Page, type: 'pagehide' | 'pageshow'): Promise<FetchCall[]> {
  return page.evaluate((name) => {
    const calls = Reflect.get(window, '__fetches') as FetchCall[];
    const before = calls.length;
    window.dispatchEvent(new PageTransitionEvent(name, { persisted: true }));
    return calls.slice(before).filter((call) => call.url.endsWith('/v1/batch'));
  }, type);
}

function lines(page: Page): Promise<string[]> {
  return page.evaluate(() => (Reflect.get(window, '__lines') as string[]).slice());
}

async function lineMatching(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(async () => (await lines(page)).some((line) => pattern.test(line))).toBe(true);
}

function batches(server: TestServer): RecordedRequest[] {
  return server.requests.filter((request) => request.method === 'POST' && request.path === '/v1/batch');
}

/** The names of the app's own events in a batch, without `Session Started` or `SDK Diagnostics`. */
function eventNames(request: RecordedRequest): string[] {
  const body = JSON.parse(request.body) as { batch: { event?: string; source?: string }[] };
  return body.batch.filter((event) => event.source === 'app').map((event) => event.event ?? '');
}

/** Installs Playwright's clock in the page, paused, so time moves only when the test moves it. */
async function pauseClock(page: Page): Promise<void> {
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1000);
}

/** Advances the page's clock a millisecond at a time until the server has seen `count` uploads. */
async function uploadsReach(page: Page, server: TestServer, count: number): Promise<void> {
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return batches(server).length;
    })
    .toBe(count);
}

/** The upload attempts the log shows with `result` (`io`, `200`, ...). */
async function attempts(page: Page, result: string): Promise<number> {
  const prefix = `debug POST /v1/batch: ${result} in `;
  return (await lines(page)).filter((line) => line.startsWith(prefix)).length;
}

/** Advances the page's clock a millisecond at a time until the log shows `count` attempts with `result`. */
async function attemptsReach(page: Page, count: number, result: string): Promise<void> {
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return attempts(page, result);
    })
    .toBe(count);
}

/** This key's released markers in the page's `localStorage` (Web Disk 2). */
function markers(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('.q1r.')));
}

test.beforeEach(({ server }) => {
  // No remote configuration: the configuration request answers 404 (step 5.3).
  server.respond('/v1/config', { status: 404 });
});

test.describe('hiding and leaving a page', () => {
  test('hiding a page sends its events at once, with keepalive and uncompressed', async ({ page, server }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await start(page, server);
    await track(page, 'First', 'Second');

    // The drain and the upload run inside the event (Web Queue 1, Web HTTP 2).
    const started = await setVisibility(page, 'hidden');
    expect(started).toEqual([{ url: `${server.origin()}/v1/batch`, keepalive: true, encoding: undefined }]);

    await expect.poll(() => batches(server).length).toBe(1);
    const batch = batches(server)[0] as RecordedRequest;
    expect(batch.gzip).toBe(false);
    expect(eventNames(batch)).toEqual(['First', 'Second']);
    await lineMatching(page, /^debug POST \/v1\/batch: 200 in /);
  });

  test('one hiding gives one upload, pagehide and visibilitychange together', async ({ page, server }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await start(page, server);
    await track(page, 'Only');

    // In every engine pagehide comes first, while the page is still visible (step 1.4).
    const fromPagehide = await page.evaluate(() => {
      const calls = Reflect.get(window, '__fetches') as FetchCall[];
      const before = calls.length;
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      return calls.slice(before).filter((call) => call.url.endsWith('/v1/batch')).length;
    });
    const fromHidden = await setVisibility(page, 'hidden');

    expect([fromPagehide, fromHidden.length]).toEqual([1, 0]);
    await expect.poll(() => batches(server).length).toBe(1);
  });

  test('a page left by a link sends what it accepted from its pagehide', async ({ page, server }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await start(page, server);
    // Accepted and not yet written: only the drain on leaving stores and sends them.
    await track(page, 'Before Leaving', 'Last');
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/pages/blank.html?next';
      link.id = 'next';
      link.textContent = 'next';
      document.body.appendChild(link);
    });
    await page.click('#next');
    await page.waitForURL(/\?next$/);

    await expect.poll(() => batches(server).length).toBe(1);
    const batch = batches(server)[0] as RecordedRequest;
    expect(batch.gzip).toBe(false);
    expect(eventNames(batch)).toEqual(['Before Leaving', 'Last']);
  });
});

test.describe('the back/forward cache', () => {
  test('a restore keeps the same instance, removes the released marker and sends again', async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await start(page, server);
    // Offline, so the chunk stays and its marker with it while the page is in the cache.
    await context.setOffline(true);
    await track(page, 'Before Cache');

    // Entering the cache: pagehide (the drain, the chunk, the marker), then hidden.
    await pageTransition(page, 'pagehide');
    await setVisibility(page, 'hidden');
    expect(await markers(page)).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.includes('.q1.')))).toBe(true);

    // The restore: visible again, then pageshow with persisted; the page's own marker goes.
    await setVisibility(page, 'visible');
    await pageTransition(page, 'pageshow');
    expect(await markers(page)).toEqual([]);

    // The same instance goes on: one device, no second instance, both events sent once online.
    const deviceId = await page.evaluate(() => {
      const analytics = Reflect.get(window, '__analytics') as {
        deviceId: string;
        track: (name: string) => void;
      };
      analytics.track('After Restore');
      return analytics.deviceId;
    });
    await context.setOffline(false);
    await expect.poll(() => batches(server).flatMap(eventNames)).toEqual(['Before Cache', 'After Restore']);
    const sent = batches(server).flatMap(
      (request) => (JSON.parse(request.body) as { batch: { device_id: string }[] }).batch,
    );
    expect(new Set(sent.map((event) => event.device_id))).toEqual(new Set([deviceId]));
    expect((await lines(page)).some((line) => line.includes('SECOND_INSTANCE'))).toBe(false);
  });
});

test.describe('the network signal', () => {
  test('offline nothing is sent, and the online event sends once after the short delay', async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await start(page, server);
    await context.setOffline(true);
    await page.evaluate(() => {
      const analytics = Reflect.get(window, '__analytics') as { track: (name: string) => void; flush: () => void };
      analytics.track('While Offline');
      analytics.flush();
    });
    await lineMatching(page, /^debug Offline; the upload waits for the network$/);
    expect(batches(server)).toEqual([]);

    await context.setOffline(false);

    await expect.poll(() => batches(server).length).toBe(1);
    expect(eventNames(batches(server)[0] as RecordedRequest)).toEqual(['While Offline']);
    await lineMatching(page, /^debug Uploaded \d+ events$/);
    expect((await lines(page)).filter((line) => line.startsWith('debug POST /v1/batch:'))).toHaveLength(1);
  });

  test('the online event makes one early attempt during a network wait', async ({ page, context, server }) => {
    // The page's clock and timers are Playwright's, so a wait passes only when the test moves time.
    await pauseClock(page);
    // An outage: every upload ends in a dropped connection, a keepalive request refused and its retry
    // without keepalive `io` (Web HTTP 3). Attempts are counted from the log, since Chromium and
    // Firefox send a POST again on their own when its connection was dropped.
    server.respond('/v1/batch', DROPPED);
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await start(page, server);
    await page.evaluate(() => {
      const analytics = Reflect.get(window, '__analytics') as { track: (name: string) => void; flush: () => void };
      analytics.track('Through The Outage');
      analytics.flush();
    });
    await attemptsReach(page, 1, 'io');
    // The first wait is 2 s with its jitter, at most 3 s; the second is 10 s, at least 5 s.
    await page.clock.runFor(3000);
    await attemptsReach(page, 2, 'io');

    server.respond('/v1/batch', { status: 200 });
    await context.setOffline(true);
    await context.setOffline(false);
    // The online delay, far below the shortest second wait: only the early attempt of Web Retry 2
    // can send now.
    await page.clock.runFor(ONLINE_DELAY_MS);
    await attemptsReach(page, 1, '200');
    expect(await attempts(page, 'io')).toBe(2);
    expect(eventNames(batches(server)[batches(server).length - 1] as RecordedRequest)).toEqual(['Through The Outage']);
  });
});

test.describe('timers are hints', () => {
  test('a page hidden for longer than the interval sends when it is shown', async ({ page, server }) => {
    await pauseClock(page);
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await start(page, server);
    await setVisibility(page, 'hidden');
    await track(page, 'While Hidden');
    // The writer's slice stores the event and arms the interval.
    await expect
      .poll(async () => {
        await page.clock.runFor(10);
        return page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('.q1.')).length);
      })
      .toBe(1);

    // The wall clock moves past the interval while the timer does not fire, as in a throttled or
    // frozen tab (Web Retry 3).
    const now = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(now + 6 * FLUSH_INTERVAL_MS);
    await page.clock.runFor(10);
    expect(batches(server)).toEqual([]);

    await setVisibility(page, 'visible');
    await uploadsReach(page, server, 1);
    expect(eventNames(batches(server)[0] as RecordedRequest)).toEqual(['While Hidden']);
  });
});

test.describe('the storage event', () => {
  test("a pending tab takes another tab's opt-in without a call of its own", async ({ context, server }) => {
    const waiting = await context.newPage();
    const deciding = await context.newPage();
    for (const page of [waiting, deciding]) {
      await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
      await start(page, server, { privacy: { defaultConsent: 'pending' } });
      // The first use starts the instance and its listeners.
      expect(
        await page.evaluate(() => (Reflect.get(window, '__analytics') as { isOptedOut: boolean }).isOptedOut),
      ).toBe(true);
    }

    await deciding.evaluate(() => {
      (Reflect.get(window, '__analytics') as { optIn: () => void }).optIn();
    });

    // Only the `storage` event of the consent mirror reaches the waiting tab (Web Privacy 2, point 3).
    await lineMatching(waiting, /^info The user opted in; collection resumes$/);
  });
});
