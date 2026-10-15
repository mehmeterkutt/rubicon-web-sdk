import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { redirectTo } from 'rubicon-analytics-testing/server';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, TEST_HOST_B, expect, test } from './fixtures';

// The `fetch` transport of step 7.3 in the three engines against the test server (Web HTTP 1 to 3,
// Web Retry 4): the request and its preflight as the backend sees them, gzip, a redirect, the
// 45-second timeout, a Content Security Policy that blocks the host, mixed content and a response
// without its CORS headers. The page is on a.rubicon.test and the API on 127.0.0.1, two origins, as
// every SDK request is cross-origin in the field (Web HTTP 4).

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));
const API_KEY = 'rk_fetch_transport';
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Loads the script build into `page` and creates the instance with `config` and a logger that keeps
 * every line in `window.__lines`; the instance is `window.__analytics`.
 */
async function start(page: Page, server: TestServer, config: Record<string, unknown> = {}): Promise<void> {
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

/** A `track` and a `flush`, the upload a developer asks for. */
async function trackAndFlush(page: Page): Promise<void> {
  await page.evaluate(() => {
    const analytics = Reflect.get(window, '__analytics') as {
      track: (name: string, properties?: Record<string, unknown>) => void;
      flush: () => void;
    };
    analytics.track('Purchase Completed', { amount: 49.9, name: 'Çiğdem' });
    analytics.flush();
  });
}

function lines(page: Page): Promise<string[]> {
  return page.evaluate(() => (Reflect.get(window, '__lines') as string[]).slice());
}

function batches(server: TestServer): RecordedRequest[] {
  return server.requests.filter((request) => request.method === 'POST' && request.path === '/v1/batch');
}

async function firstBatch(server: TestServer): Promise<RecordedRequest> {
  await expect.poll(() => batches(server).length).toBeGreaterThan(0);
  return batches(server)[0] as RecordedRequest;
}

async function lineMatching(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(async () => (await lines(page)).some((line) => pattern.test(line))).toBe(true);
}

test.beforeEach(({ server }) => {
  // No remote configuration: the configuration request answers 404 (step 5.3).
  server.respond('/v1/config', { status: 404 });
});

test('the upload is a cors POST with the wire headers, preflighted, gzipped, without cookies or referrer', async ({
  page,
  server,
}) => {
  server.allowHeaders('X-Gateway-Token');
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.evaluate(() => {
    document.cookie = 'site_session=secret; Path=/';
  });
  await start(page, server, { network: { headers: { 'X-Gateway-Token': 'gw-1' } } });
  await trackAndFlush(page);

  const batch = await firstBatch(server);
  expect(batch.headers['authorization']).toBe(`Bearer ${API_KEY}`);
  expect(batch.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(batch.headers['content-encoding']).toBe('gzip');
  expect(batch.headers['x-gateway-token']).toBe('gw-1');
  expect(batch.headers['origin']).toBe(server.origin(TEST_HOST_A));
  expect(batch.headers['cookie']).toBeUndefined();
  expect(batch.headers['referer']).toBeUndefined();
  expect(Object.keys(batch.headers).filter((name) => name.startsWith('x-rubicon'))).toEqual([]);

  // gzip decompressed by the server, the body the wire format describes, UTF-8 intact.
  expect(batch.gzip).toBe(true);
  expect(batch.bodyDecoded).toBe(true);
  const body = JSON.parse(batch.body) as { sent_at: unknown; batch: { event?: string; properties?: unknown }[] };
  expect(typeof body.sent_at).toBe('number');
  const purchase = body.batch.find((event) => event.event === 'Purchase Completed');
  expect(purchase?.properties).toEqual({ amount: 49.9, name: 'Çiğdem' });
  expect(batch.body).not.toContain(API_KEY);

  // The preflight the browser sent first, for exactly the headers the request carries.
  const preflight = server.preflights.find((request) => request.path === '/v1/batch');
  expect(preflight?.headers['access-control-request-method']).toBe('POST');
  const requested = (preflight?.headers['access-control-request-headers'] ?? '').split(',').map((name) => name.trim());
  expect(requested.sort()).toEqual(['authorization', 'content-encoding', 'content-type', 'x-gateway-token']);

  // The configuration request is a GET with the key, sent once at start.
  const config = server.requests.filter((request) => request.path === '/v1/config');
  expect(config.map((request) => [request.method, request.headers['authorization']])).toEqual([
    ['GET', `Bearer ${API_KEY}`],
  ]);

  await lineMatching(page, /^debug POST \/v1\/batch: 200 in \d+ ms, \d+ bytes sent$/);
});

test('a 302 is HTTP_REDIRECT without the target, and the redirect is not followed', async ({ page, server }) => {
  server.enqueue(redirectTo('https://elsewhere.example/collect'));
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await start(page, server);
  await trackAndFlush(page);

  await lineMatching(page, /^error HTTP_REDIRECT: 127\.0\.0\.1 answered with a redirect/);
  const logged = await lines(page);
  expect(logged).toContain('error HTTP_REDIRECT: 127.0.0.1 answered with a redirect; set host to the final URL');
  expect(logged.some((line) => line.includes('elsewhere'))).toBe(false);
  expect(logged.some((line) => /^debug POST \/v1\/batch: redirect in/.test(line))).toBe(true);
  expect(batches(server)).toHaveLength(1);
});

test('a request without an answer in 45 seconds is a timeout, and the late answer is ignored', async ({
  page,
  server,
}) => {
  // The page's clock and timers are Playwright's, so the 45 seconds pass without waiting for them.
  await page.clock.install();
  server.enqueue({ status: 200, delayMs: 60_000 });
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await start(page, server);
  await trackAndFlush(page);
  // The writer's slices and the upload run on timers.
  await expect
    .poll(async () => {
      await page.clock.runFor(100);
      return batches(server).length;
    })
    .toBe(1);

  await page.clock.runFor(REQUEST_TIMEOUT_MS);

  await lineMatching(page, /^debug POST \/v1\/batch: timeout in 45\d{3} ms$/);
  const logged = await lines(page);
  expect(logged.filter((line) => line.startsWith('debug POST /v1/batch:'))).toHaveLength(1);
  expect(logged.some((line) => line.startsWith('warn UPLOAD_FAILED_OPAQUE'))).toBe(false);
});

test('a Content Security Policy without the host gives CSP_BLOCKED once, io and the opaque warning', async ({
  page,
  server,
}) => {
  await page.goto(server.url('/pages/csp-connect-self.html', TEST_HOST_A));
  await start(page, server);
  await trackAndFlush(page);

  await lineMatching(page, /^warn UPLOAD_FAILED_OPAQUE: /);
  await lineMatching(page, /^error CSP_BLOCKED: /);
  const logged = await lines(page);
  expect(logged.filter((line) => /^(warn|error) CSP_BLOCKED: /.test(line))).toEqual([
    "error CSP_BLOCKED: The page's Content Security Policy blocked a request to 127.0.0.1; " +
      'allow its origin in connect-src',
  ]);
  expect(logged.some((line) => /^debug POST \/v1\/batch: io in/.test(line))).toBe(true);
  expect(logged).toContain(
    'warn UPLOAD_FAILED_OPAQUE: An upload to 127.0.0.1 failed without a reason the browser reveals; ' +
      "check the host's CORS answer, the page's Content Security Policy, an ad blocker and the certificate",
  );
  // The browser sent nothing to the host.
  expect(server.requests).toEqual([]);
  expect(server.preflights).toEqual([]);
});

test('an http host from an https page sends nothing, with the CLEARTEXT_HOST error', async ({ page, server }) => {
  // Playwright answers the https page itself, so no certificate is needed; the host is http and not
  // the loopback, which every browser blocks as mixed content (Web HTTP 3, Web Retry 4).
  const pageUrl = `https://${TEST_HOST_A}/secure.html`;
  await page.route(pageUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>secure</title>' }),
  );
  await page.goto(pageUrl);
  await page.evaluate(() => {
    // Counts what reaches `fetch` (test code only; the SDK never replaces it).
    const original = window.fetch.bind(window);
    let calls = 0;
    Reflect.set(window, '__fetchCalls', () => calls);
    window.fetch = (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return original(...args);
    };
  });
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    ({ apiKey, host }) => {
      const lines: string[] = [];
      Reflect.set(window, '__lines', lines);
      const rubicon = Reflect.get(window, 'Rubicon') as { createAnalytics: (config: unknown) => unknown };
      Reflect.set(
        window,
        '__analytics',
        rubicon.createAnalytics({
          apiKey,
          host,
          logging: { level: 'debug', logger: (level: string, message: string) => lines.push(`${level} ${message}`) },
        }),
      );
    },
    { apiKey: API_KEY, host: server.origin(TEST_HOST_B) },
  );
  await trackAndFlush(page);

  await lineMatching(page, /^debug The host is blocked as mixed content; this page does not upload$/);
  const logged = await lines(page);
  expect(logged).toContain(
    'error CLEARTEXT_HOST: The host uses http://, which the browser blocks from an https page as mixed content; ' +
      'nothing is sent until host uses https://.',
  );
  expect(await page.evaluate(() => (Reflect.get(window, '__fetchCalls') as () => number)())).toBe(0);
  expect(server.requests).toEqual([]);
  expect(server.preflights).toEqual([]);
});

test('a response without its CORS headers is io with the opaque warning', async ({ page, server }) => {
  // A small upload goes with `keepalive`, so the browser's `TypeError` is first the keepalive refusal,
  // tried once more without it (Web HTTP 3, Web Queue 5); the second answer lacks the headers too.
  server.enqueue({ status: 200, omitCors: true }, { status: 200, omitCors: true });
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await start(page, server);
  await trackAndFlush(page);

  await lineMatching(page, /^warn UPLOAD_FAILED_OPAQUE: An upload to 127\.0\.0\.1 failed/);
  const logged = await lines(page);
  expect(
    logged.filter((line) => line.startsWith('debug POST /v1/batch:')).map((line) => line.split(' in ')[0]),
  ).toEqual(['debug POST /v1/batch: keepalive refused', 'debug POST /v1/batch: io']);
  expect(logged.some((line) => line.startsWith('error CSP_BLOCKED'))).toBe(false);
  // Both reached the server: only the answers were hidden from the page.
  expect(batches(server)).toHaveLength(2);
});
