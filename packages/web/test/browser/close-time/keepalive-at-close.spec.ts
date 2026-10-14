import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, TEST_HOST_B, expect, test } from '../fixtures';

// Web Queue 3 and 5, Web HTTP 1, 2 and 5: the upload started while a page goes away is a `fetch`
// with `keepalive` and the wire headers (so the browser preflights it), with an uncompressed body
// within the 48 KiB budget, started synchronously inside the `visibilitychange` (hidden) or
// `pagehide` handler. These tests measure, in each engine, whether such a request reaches the server
// when the page then navigates away or is closed. The results, and what each engine and Playwright
// do, are recorded in plan section 15 (step 1.4); Web HTTP 5 reopens the key-in-body question only if
// an engine loses the request after its handler ran.
//
// Both answers are held back so that the preflight and the request are still in flight when the
// page is gone, as in the HTTP page's experiment of 2026-10-14. The request URL carries a unique
// query, so every preflight is cold. Besides the request, the handler leaves two traces that tell
// "the handler never ran" apart from "the request was lost": a key in the page's `localStorage`,
// read back from another tab, and a `sendBeacon` (no preflight, no `keepalive` budget) as a control.
// The SDK never uses `sendBeacon` (Web Queue 3); the control exists only in this test.

/** The body size of the step: 40 KiB of ASCII, below the 48 KiB budget of Web Queue 5. */
const BODY_BYTES = 40 * 1024;
const PREFLIGHT_DELAY_MS = 500;
const ANSWER_DELAY_MS = 1000;
/** How long the server waits for the request and the control after the page went away. */
const ARRIVAL_TIMEOUT_MS = 5000;
/** The test's own key in the page's `localStorage`: which handler ran. */
const FIRED_KEY = 'rubicon-test.close-time.fired';
const BATCH_PATH = '/v1/batch';
const BEACON_PATH = '/v1/beacon';

type Handler = 'visibilitychange' | 'pagehide';
type EngineName = 'chromium' | 'firefox' | 'webkit';

/**
 * How the page goes away. A navigation is a link click (started by the page) to the same site or
 * to another site, or `page.goto()` to another site (started by the browser, as a typed address).
 * `page.close()` is Playwright closing a tab the browser opened; `window.close()` closes a tab that
 * a script opened, the only kind a script may close.
 */
type Ending =
  'a same-site link click' | 'a cross-site link click' | 'a cross-site page.goto()' | 'page.close()' | 'window.close()';

/**
 * Where the page and the API live. `hosts`: the page on a.rubicon.test through the harness of step
 * 1.3 (in WebKit the test server is the proxy). `loopback`: the page on `localhost` and the API on
 * `127.0.0.1`, without a hostname mapping or a proxy in any engine, so that a result cannot be an
 * artifact of the proxy.
 */
type Origins = 'hosts' | 'loopback';

/**
 * What the engine does, measured on 2026-10-14 (plan section 15, step 1.4). `delivered`: the
 * handler ran and the request arrived whole. `no handler`: the handler never ran, so neither the
 * request nor the control nor the storage key was seen; no transport could have sent anything.
 */
type Outcome = 'delivered' | 'no handler';

function expected(engine: EngineName, ending: Ending): Outcome {
  // Playwright's Firefox closes a tab it opened without running the page's handlers; the same
  // engine runs them, and delivers, when a script-opened tab is closed with window.close().
  if (engine === 'firefox' && ending === 'page.close()') return 'no handler';
  if (engine === 'webkit') {
    // Playwright's WebKit runs neither handler when a navigation moves the tab to a new web process
    // (another site, or any page.goto()), nor when a script-opened tab calls window.close().
    if (ending === 'a cross-site link click' || ending === 'a cross-site page.goto()') return 'no handler';
    if (ending === 'window.close()') return 'no handler';
  }
  return 'delivered';
}

interface Placement {
  readonly pageOrigin: string;
  readonly sameSiteOrigin: string;
  readonly crossSiteOrigin: string;
}

function placement(server: TestServer, origins: Origins): Placement {
  return origins === 'hosts'
    ? {
        pageOrigin: server.origin(TEST_HOST_A),
        sameSiteOrigin: server.origin(TEST_HOST_B),
        crossSiteOrigin: server.origin('127.0.0.1'),
      }
    : {
        pageOrigin: server.origin('localhost'),
        sameSiteOrigin: server.origin('localhost'),
        crossSiteOrigin: server.origin('127.0.0.1'),
      };
}

/** The body: a JSON batch envelope padded to exactly {@link BODY_BYTES} bytes. */
function closeTimeBody(): string {
  const head = '{"sent_at":1759147260000,"batch":[{"type":"track","event":"Close Time","pad":"';
  const tail = '"}]}';
  return head + 'x'.repeat(BODY_BYTES - head.length - tail.length) + tail;
}

/**
 * Installs the handler in the live page: it records which handler ran, sends the control, and
 * starts the request synchronously in the shape of Web HTTP 1, with `keepalive` and without
 * compression (Web HTTP 2).
 */
async function installHandler(page: Page, handler: Handler, url: string, beaconUrl: string): Promise<void> {
  await page.evaluate(
    ([handlerName, target, beaconTarget, firedKey, body]) => {
      let sent = false;
      const send = (): void => {
        if (sent) return;
        sent = true;
        localStorage.setItem(firedKey, handlerName);
        navigator.sendBeacon(beaconTarget, 'control');
        fetch(target, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'manual',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          priority: 'low',
          keepalive: true,
          headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json; charset=utf-8' },
          body,
        }).catch(() => undefined);
      };
      if (handlerName === 'pagehide') {
        window.addEventListener('pagehide', send);
      } else {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') send();
        });
      }
    },
    [handler, url, beaconUrl, FIRED_KEY, closeTimeBody()] as const,
  );
}

/** Opens the page under test: by the browser, or by a script in `opener` for window.close(). */
async function openPage(context: BrowserContext, opener: Page, ending: Ending, url: string): Promise<Page> {
  if (ending !== 'window.close()') {
    const page = await context.newPage();
    await page.goto(url);
    return page;
  }
  const opened = context.waitForEvent('page');
  await opener.evaluate((href) => {
    window.open(href, '_blank');
  }, url);
  const page = await opened;
  await page.waitForLoadState();
  return page;
}

async function clickLink(page: Page, href: string): Promise<void> {
  await page.evaluate((target) => {
    const link = document.createElement('a');
    link.href = target;
    link.id = 'next';
    link.textContent = 'next';
    document.body.appendChild(link);
  }, href);
  await Promise.all([page.waitForURL(href), page.click('#next')]);
}

async function endPage(page: Page, ending: Ending, where: Placement): Promise<void> {
  switch (ending) {
    case 'a same-site link click':
      await clickLink(page, `${where.sameSiteOrigin}/pages/blank.html?next`);
      return;
    case 'a cross-site link click':
      await clickLink(page, `${where.crossSiteOrigin}/pages/blank.html?next`);
      return;
    case 'a cross-site page.goto()':
      await page.goto(`${where.crossSiteOrigin}/pages/blank.html?next`);
      return;
    case 'page.close()':
      await page.close();
      return;
    case 'window.close()': {
      const closed = page.waitForEvent('close');
      await page.evaluate(() => {
        setTimeout(() => {
          window.close();
        }, 0);
      });
      await closed;
      return;
    }
  }
}

async function waitFor(server: TestServer, path: string): Promise<RecordedRequest | undefined> {
  const find = (): RecordedRequest | undefined => server.requests.find((r) => r.path === path);
  await expect
    .poll(() => find() !== undefined, { timeout: ARRIVAL_TIMEOUT_MS })
    .toBe(true)
    .catch(() => undefined);
  return find();
}

async function contextFor(origins: Origins, browser: Browser, context: BrowserContext): Promise<BrowserContext> {
  // The default context carries the harness (the proxy in WebKit); the loopback placement needs
  // none, so it gets a plain context.
  return origins === 'hosts' ? context : browser.newContext();
}

const HANDLERS: readonly Handler[] = ['visibilitychange', 'pagehide'];
const ENDINGS: readonly Ending[] = [
  'a same-site link click',
  'a cross-site link click',
  'a cross-site page.goto()',
  'page.close()',
  'window.close()',
];
const ORIGINS: readonly Origins[] = ['hosts', 'loopback'];

for (const origins of ORIGINS) {
  test.describe(origins === 'hosts' ? 'the hosts of D15' : 'localhost and 127.0.0.1, no proxy', () => {
    for (const handler of HANDLERS) {
      for (const ending of ENDINGS) {
        test(`a preflighted keepalive POST of 40 KiB started in ${handler} after ${ending}`, async ({
          browser,
          browserName,
          context,
          server,
        }) => {
          const outcome = expected(browserName, ending);
          const where = placement(server, origins);
          const ownContext = await contextFor(origins, browser, context);
          try {
            server.preflightDelayMs = PREFLIGHT_DELAY_MS;
            server.respond(BATCH_PATH, { status: 200, body: '{}', delayMs: ANSWER_DELAY_MS });
            server.respond(BEACON_PATH, { status: 204 });
            const run = Math.random().toString(16).slice(2);
            // A second tab stays open, as in a browser where one of several tabs goes away; it opens
            // the script-opened tab and reads back which handler ran.
            const other = await ownContext.newPage();
            await other.goto(`${where.pageOrigin}/pages/blank.html?other`);
            const page = await openPage(ownContext, other, ending, `${where.pageOrigin}/pages/blank.html`);
            await installHandler(page, handler, `${server.url(BATCH_PATH)}?run=${run}`, server.url(BEACON_PATH));

            await endPage(page, ending, where);
            const arrived = await waitFor(server, BATCH_PATH);
            const control = await waitFor(server, BEACON_PATH);
            await other.goto(`${where.pageOrigin}/pages/blank.html?read`);
            const fired = await other.evaluate((key) => localStorage.getItem(key), FIRED_KEY);

            test.info().annotations.push({
              type: 'measurement',
              description: `outcome=${outcome} fired=${String(fired)} control=${String(control !== undefined)} preflights=${String(server.preflights.length)} arrived=${String(arrived !== undefined)} bytes=${String(arrived?.rawBody.length)}`,
            });
            if (outcome === 'no handler') {
              expect(fired).toBeNull();
              expect(server.requests).toEqual([]);
              expect(server.preflights).toEqual([]);
              return;
            }
            expect(fired).toBe(handler);
            expect(control).toBeDefined();
            expect(server.preflights.map((p) => [p.path, p.query])).toEqual([[BATCH_PATH, `?run=${run}`]]);
            expect(arrived).toBeDefined();
            expect(arrived?.method).toBe('POST');
            expect(arrived?.query).toBe(`?run=${run}`);
            expect(arrived?.headers['authorization']).toBe('Bearer test-key');
            expect(arrived?.headers['content-type']).toBe('application/json; charset=utf-8');
            expect(arrived?.headers['content-encoding']).toBeUndefined();
            expect(arrived?.rawBody.length).toBe(BODY_BYTES);
            expect(arrived?.body).toBe(closeTimeBody());
          } finally {
            if (ownContext !== context) await ownContext.close();
          }
        });
      }
    }
  });
}
