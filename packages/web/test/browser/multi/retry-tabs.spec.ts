import { TEST_HOST_A, expect, test } from '../fixtures';
import { appEvent, batches, call, flushUntilSent, lineMatching, lines, openTab } from './tabs';

// Web Retry 1 across real tabs and page loads (step 8.1): the retry state is shared by every page of
// the origin. A server pause (429) seen by one tab holds every tab and the next page load, but not a
// page configured with another host; when a transient wait ends one page probes and the others wait
// for its result.

const API_KEY = 'rk_retry_tabs';
const CONFIG = { autocapture: { enabled: ['sessions'] } };

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

test('a 429 seen by one tab pauses the other tab and the next page load, not a page of another host', async ({
  context,
  server,
}) => {
  const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const second = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  server.respond('/v1/batch', { status: 429, headers: { 'Retry-After': '120' } });

  await call(first, 'track', 'Throttled');
  await call(first, 'flush');
  await lineMatching(first, /^debug The server asked to slow down; uploads pause for \d+ ms$/);
  expect(batches(server)).toHaveLength(1);
  server.respond('/v1/batch', { status: 200 });

  // The other tab reads `.pause` before its upload and sends nothing (Web Retry 1, point 1).
  await call(second, 'track', 'Held');
  await call(second, 'flush');
  await lineMatching(second, /^debug Uploads wait \(throttle\) for \d+ ms$/);

  // A new page load of the site is a restart that must not bypass the pause (Retry 5).
  await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG, page: second });
  await call(second, 'track', 'After Reload');
  await call(second, 'flush');
  await lineMatching(second, /^debug Uploads wait \(throttle\) for \d+ ms$/);
  expect(batches(server)).toHaveLength(1);

  // A page whose `host` names the same server another way is another configuration (Web Retry 4a).
  const elsewhere = await context.newPage();
  await openTab(context, server, {
    host: TEST_HOST_A,
    apiKey: API_KEY,
    page: elsewhere,
    config: { ...CONFIG, host: server.origin('localhost') },
  });
  await call(elsewhere, 'track', 'Other Host');
  await flushUntilSent(elsewhere, server, 'Other Host');
});

test('when a transient wait ends one tab probes and the other waits for its result', async ({ context, server }) => {
  const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const second = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  server.respond('/v1/batch', { status: 503 });

  await call(first, 'track', 'Probed');
  await call(first, 'flush');
  await lineMatching(first, /^debug Upload failed \(http_503\); waiting \d+ ms$/);
  // The probe, held in flight by the server: the first tab's timer sends it when the wait ends (at
  // most 3 s, the first step of the table with its jitter).
  server.respond('/v1/batch', { status: 200, delayMs: 3000 });
  await expect.poll(() => batches(server).length, { timeout: 10_000 }).toBe(2);

  // The other tab finds the probe of the last 30 s and waits for its result (Web Retry 1, point 5).
  await call(second, 'track', 'Waiting');
  await call(second, 'flush');
  await lineMatching(second, /^debug Uploads wait \(probe\) for \d+ ms$/);
  expect(batches(server)).toHaveLength(2);

  // The probe succeeds and resets the shared state, so the other tab sends at its next flush.
  await lineMatching(first, /^debug Uploaded \d+ events$/);
  await flushUntilSent(second, server, 'Waiting');
  expect(appEvent(server, 'Probed')).toHaveLength(2);
  expect((await lines(second)).some((line) => line.startsWith('debug Upload failed'))).toBe(false);
});
