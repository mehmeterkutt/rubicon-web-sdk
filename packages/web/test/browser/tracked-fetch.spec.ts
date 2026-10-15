import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from './fixtures';

// `createTrackedFetch` of step 7.7 (Web Lifecycle 6, Web HTTP 3) in the engines, through the script
// build: the test list of Web Lifecycle 6 against each engine's own `fetch`, `Request`,
// `AbortController` and `Blob`, and axios with its fetch adapter (axios 1.12 or later, `env.fetch`),
// loaded from the package's browser build. The page is on `a.rubicon.test` and captures its own
// host; the SDK sends to `127.0.0.1`, so the server tells the tracked requests from the uploads by
// host. The rules themselves are unit-tested in jsdom (test/unit/tracked-fetch.test.ts).

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));
// The browser build next to the Node entry the `exports` map resolves (`dist/node/axios.cjs`).
const axiosBuild = join(dirname(createRequire(import.meta.url).resolve('axios')), '..', 'axios.min.js');
const API_KEY = 'rk_tracked_fetch';

interface WireEvent {
  readonly event?: string;
  readonly source?: string;
  readonly properties?: Record<string, unknown>;
}

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

/**
 * Loads the script build, creates the instance (`window.__analytics`) and the tracked function for
 * the page's own host (`window.__tracked`).
 */
async function start(page: Page, server: TestServer): Promise<void> {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    ({ apiKey, host }) => {
      const rubicon = Reflect.get(window, 'Rubicon') as {
        createAnalytics: (config: unknown) => unknown;
        createTrackedFetch: (analytics: unknown, options: unknown) => unknown;
      };
      const analytics = rubicon.createAnalytics({ apiKey, host, autocapture: { enabled: ['network_requests'] } });
      Reflect.set(window, '__analytics', analytics);
      Reflect.set(window, '__tracked', rubicon.createTrackedFetch(analytics, { hosts: [location.hostname] }));
    },
    { apiKey: API_KEY, host: server.origin() },
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

function captured(server: TestServer): WireEvent[] {
  return sent(server).filter((event) => event.event === 'Network Request');
}

/** Flushes until the server has seen `count` `Network Request` events; their properties, in order. */
async function capturedProperties(page: Page, server: TestServer, count: number): Promise<Record<string, unknown>[]> {
  await expect
    .poll(async () => {
      await flush(page);
      return captured(server).length;
    })
    .toBeGreaterThanOrEqual(count);
  return captured(server).map((event) => event.properties ?? {});
}

/** The tracked requests the server received, those to the page's own host. */
function trackedRequests(server: TestServer): RecordedRequest[] {
  return server.requests.filter((request) => request.host === TEST_HOST_A);
}

test('a 404 is returned untouched and a 200 keeps its body, both captured without query or fragment', async ({
  page,
  server,
}) => {
  // The test server streams its answers; `Content-Length` is given, as a server sending a whole body does.
  server.respond('/v1/orders/12345', { status: 200, headers: { 'Content-Length': '5' }, body: 'hello' });
  server.respond('/v1/missing', { status: 404, body: 'gone' });
  await start(page, server);

  const answers = await page.evaluate(async () => {
    const tracked = Reflect.get(window, '__tracked') as typeof fetch;
    const ok = await tracked('/v1/orders/12345?token=secret#frag');
    const missing = await tracked('/v1/missing');
    return [ok.status, await ok.text(), missing.ok, missing.status, await missing.text()];
  });

  expect(answers).toEqual([200, 'hello', false, 404, 'gone']);
  const [ok, missing] = await capturedProperties(page, server, 2);
  expect(ok).toEqual({
    method: 'GET',
    url: `${server.origin(TEST_HOST_A)}/v1/orders/:id`,
    host: TEST_HOST_A,
    path: '/v1/orders/:id',
    status_code: 200,
    duration_ms: expect.any(Number) as unknown,
    response_bytes: 5,
  });
  expect(missing).toMatchObject({ path: '/v1/missing', status_code: 404 });
  expect(JSON.stringify(sent(server))).not.toMatch(/secret|frag/);
});

test('an abort is rethrown as the same error, recorded as canceled', async ({ page, server }) => {
  server.respond('/v1/slow', { status: 200, delayMs: 5000 });
  await start(page, server);

  const same = await page.evaluate(async () => {
    // The engine's own `fetch`, wrapped only to keep the error it rejects with.
    let baseError: unknown;
    const base = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const answer = fetch(input, init);
      answer.catch((error: unknown) => {
        baseError = error;
      });
      return answer;
    };
    const rubicon = Reflect.get(window, 'Rubicon') as {
      createTrackedFetch: (analytics: unknown, options: unknown) => typeof fetch;
    };
    const tracked = rubicon.createTrackedFetch(Reflect.get(window, '__analytics'), {
      hosts: [location.hostname],
      fetch: base,
    });
    const controller = new AbortController();
    const pending = tracked('/v1/slow', { signal: controller.signal });
    controller.abort();
    const error: unknown = await pending.catch((reason: unknown) => reason);
    return [error === baseError, (error as Error).name];
  });

  expect(same).toEqual([true, 'AbortError']);
  const [aborted] = await capturedProperties(page, server, 1);
  expect(aborted).toMatchObject({ path: '/v1/slow', error: 'canceled' });
  expect(aborted).not.toHaveProperty('status_code');
});

test('a Request with an init.method override, a relative URL, and a body that is never read', async ({
  page,
  server,
}) => {
  await start(page, server);

  const reads = await page.evaluate(async () => {
    const tracked = Reflect.get(window, '__tracked') as typeof fetch;
    const reads: string[] = [];
    const body = new Blob(['abcd']);
    for (const name of ['text', 'arrayBuffer', 'stream', 'slice']) {
      Object.defineProperty(body, name, {
        value: () => {
          reads.push(name);
          throw new Error('read');
        },
      });
    }
    await tracked(new Request('/v1/items/987?x=1', { method: 'POST', body: 'text' }), { method: 'put' });
    history.pushState(null, '', '/pages/shop/');
    await tracked('items/42', { method: 'POST', body });
    return reads;
  });

  expect(reads).toEqual([]);
  const [request, relative] = await capturedProperties(page, server, 2);
  expect(request).toMatchObject({ method: 'PUT', path: '/v1/items/:id' });
  expect(request).not.toHaveProperty('request_bytes');
  expect(relative).toMatchObject({ method: 'POST', path: '/pages/shop/items/:id', request_bytes: 4 });
  expect(trackedRequests(server).map((r) => [r.method, r.path])).toEqual([['PUT', '/v1/items/987']]);
});

test('a remote switch-off arriving during a request sends nothing for it or after it', async ({ page, server }) => {
  // The configuration request starts with the instance, at the first tracked request, and arrives
  // while that request is still waiting for its answer (Web Lifecycle 8: at once).
  server.respond('/v1/config', { status: 200, delayMs: 300, body: '{"autocapture_off":["network_requests"]}' });
  server.respond('/v1/slow', { status: 200, delayMs: 1500 });
  server.respond('/v1/after', { status: 200 });
  server.respond('/v1/before', { status: 200 });
  await start(page, server);

  await page.evaluate(async () => {
    const tracked = Reflect.get(window, '__tracked') as typeof fetch;
    // Answered before the configuration arrives: captured, so capture was on when the next one started.
    await tracked('/v1/before');
    await tracked('/v1/slow');
    await tracked('/v1/after');
    (Reflect.get(window, '__analytics') as { track: (name: string) => void }).track('Done');
  });

  await expect
    .poll(async () => {
      await flush(page);
      return sent(server).some((event) => event.event === 'Done');
    })
    .toBe(true);
  expect(captured(server).map((event) => event.properties?.path)).toEqual(['/v1/before']);
  expect(trackedRequests(server).map((request) => request.path)).toEqual(['/v1/before', '/v1/slow', '/v1/after']);
});

test('axios with its fetch adapter: captured, the same answers and errors, its headers kept', async ({
  page,
  server,
}) => {
  server.respond('/v1/orders/4521', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: '{"id":4521}',
  });
  server.respond('/v1/orders', { status: 201, body: '' });
  server.respond('/v1/nothing', { status: 404, body: 'gone' });
  await start(page, server);
  await page.addScriptTag({ path: axiosBuild });

  const answers = await page.evaluate(async () => {
    interface AxiosLike {
      create(config: unknown): {
        get(url: string): Promise<{ status: number; data: unknown }>;
        post(url: string, data: unknown, config: unknown): Promise<{ status: number }>;
      };
    }
    const axios = Reflect.get(window, 'axios') as AxiosLike;
    const client = axios.create({ adapter: 'fetch', env: { fetch: Reflect.get(window, '__tracked') as unknown } });
    const order = await client.get('/v1/orders/4521?expand=items');
    const created = await client.post('/v1/orders', { sku: 'A1' }, { headers: { 'X-Csrf-Token': 'csrf-1' } });
    // axios rejects a 404 with its own error, which carries the same response.
    const missing = await client.get('/v1/nothing').then(
      () => undefined,
      (error: unknown) => (error as { response?: { status: number } }).response?.status,
    );
    return [order.status, order.data, created.status, missing];
  });

  expect(answers).toEqual([200, { id: 4521 }, 201, 404]);
  const properties = await capturedProperties(page, server, 3);
  expect(properties.map((p) => [p.method, p.path, p.status_code])).toEqual([
    ['GET', '/v1/orders/:id', 200],
    ['POST', '/v1/orders', 201],
    ['GET', '/v1/nothing', 404],
  ]);
  const post = trackedRequests(server).find((request) => request.method === 'POST');
  expect(post?.headers['x-csrf-token']).toBe('csrf-1');
  expect(post?.body).toBe('{"sku":"A1"}');
});
