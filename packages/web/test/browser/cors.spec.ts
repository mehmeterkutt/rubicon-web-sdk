import type { Page } from '@playwright/test';
import { TEST_HOST_A, expect, test } from './fixtures';

// Web HTTP 4: every SDK request is cross-origin with `Authorization` and a JSON body, so the browser
// preflights it, and the backend's CORS answer decides whether the page sees the response. The page
// is on a.rubicon.test, the API on 127.0.0.1: two origins served by the same test server.

interface FetchOutcome {
  readonly status?: number;
  readonly body?: string;
  readonly retryAfter?: string | null;
  readonly typeError?: boolean;
}

/**
 * Sends the SDK's request shape (Web HTTP 1) from the page, its body gzip-compressed in the page by
 * `CompressionStream`, and reports what the page saw.
 */
function sendBatch(page: Page, url: string, text: string): Promise<FetchOutcome> {
  return page.evaluate(
    async ([target, body]) => {
      const compressed = await new Response(
        new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer();
      try {
        const response = await fetch(target, {
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'manual',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          headers: {
            Authorization: 'Bearer test-key',
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'gzip',
          },
          body: compressed,
        });
        return {
          status: response.status,
          body: await response.text(),
          retryAfter: response.headers.get('Retry-After'),
        };
      } catch (error) {
        return { typeError: error instanceof TypeError };
      }
    },
    [url, text] as const,
  );
}

test.beforeEach(async ({ page, server }) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
});

test('a preflighted fetch from a page on another origin reaches the server', async ({ page, server }) => {
  server.enqueue({ status: 200, body: '{}' });
  const text = '{"sent_at":1,"batch":[]}';

  const outcome = await sendBatch(page, server.url('/v1/batch'), text);

  expect(outcome).toEqual({ status: 200, body: '{}', retryAfter: null });
  expect(server.preflights).toHaveLength(1);
  const preflight = server.preflights[0]!;
  expect(preflight.headers['access-control-request-method']).toBe('POST');
  expect(preflight.headers['access-control-request-headers']?.split(',').sort()).toEqual([
    'authorization',
    'content-encoding',
    'content-type',
  ]);
  const request = await server.takeRequest();
  expect(request.headers['origin']).toBe(server.origin(TEST_HOST_A));
  expect(request.headers['authorization']).toBe('Bearer test-key');
  expect(request.headers['cookie']).toBeUndefined();
  expect(request.gzip).toBe(true);
  expect(request.body).toBe(text);
});

test('an exposed Retry-After on an error answer is readable by the page', async ({ page, server }) => {
  server.enqueue({ status: 429, headers: { 'Retry-After': '120' } });

  const outcome = await sendBatch(page, server.url('/v1/batch'), '{}');

  expect(outcome).toEqual({ status: 429, body: '', retryAfter: '120' });
});

test('without the CORS headers the preflight fails and the page sees a TypeError', async ({ page, server }) => {
  server.cors = false;

  const outcome = await sendBatch(page, server.url('/v1/batch'), '{}');

  expect(outcome).toEqual({ typeError: true });
  expect(server.preflights).toHaveLength(1);
  expect(server.requests).toHaveLength(0);
});

test('an error answer without the CORS headers reaches the server but the page sees a TypeError', async ({
  page,
  server,
}) => {
  server.enqueue({ status: 429, headers: { 'Retry-After': '120' }, omitCors: true });

  const outcome = await sendBatch(page, server.url('/v1/batch'), '{}');

  expect(outcome).toEqual({ typeError: true });
  expect(server.requests).toHaveLength(1);
});
