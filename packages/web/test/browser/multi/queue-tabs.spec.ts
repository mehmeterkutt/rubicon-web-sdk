import type { BrowserContext } from '@playwright/test';
import type { TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from '../fixtures';
import {
  appEvent,
  batches,
  call,
  chunksReach,
  eventsOf,
  flushUntilSent,
  openTab,
  pagehide,
  sent,
  storedKeys,
} from './tabs';

// Web Queue 2 across real tabs (step 8.1): every page load writes only its own immutable chunks and
// sends its own first; another page sends a chunk only when it is released (the marker written on
// `pagehide`) or older than the adoption age, and deletes only that chunk after the acknowledgement.
// The tabs share the origin's `localStorage`; the context is offline while the chunks are written,
// so that nothing leaves before the test lets it.

const API_KEY = 'rk_queue_tabs';
/** No page views, so a tab writes only what the test tracks. */
const CONFIG = { autocapture: { enabled: ['sessions'] } };
/** The age after which another page's unreleased chunk may be sent (`ADOPT_AFTER_MS`, section 15, step 6.4). */
const ADOPT_AFTER_MS = 60 * 60 * 1000;

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

test('each tab sends its own chunks; a living tab’s unreleased chunk is not taken by another', async ({
  context,
  server,
}) => {
  const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const second = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  await context.setOffline(true);
  await call(first, 'track', 'From First');
  await chunksReach(first, 1);
  await call(second, 'track', 'From Second');
  await chunksReach(second, 2);

  await context.setOffline(false);
  await flushUntilSent(first, server, 'From First');
  await flushUntilSent(second, server, 'From Second');

  // Every batch holds one tab's events only, and no event went twice.
  for (const batch of batches(server)) {
    const names = new Set(
      eventsOf(batch)
        .filter((event) => event.source === 'app')
        .map((event) => event.event),
    );
    expect(names.size).toBeLessThanOrEqual(1);
  }
  const ids = sent(server).map((event) => event.message_id);
  expect(new Set(ids).size).toBe(ids.length);
  await expect.poll(() => storedKeys(second, '.q1.')).toEqual([]);
});

test('a released chunk is sent by another tab and only that chunk is deleted after the acknowledgement', async ({
  context,
  server,
}) => {
  const leaving = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const staying = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  await context.setOffline(true);
  await call(leaving, 'track', 'Before Leaving');
  await chunksReach(leaving, 1);
  // The page is left: its chunk stays and the released marker is written (Web Queue 2, point 4).
  await pagehide(leaving);
  expect(await storedKeys(leaving, '.q1r.')).toHaveLength(1);
  const released = await storedKeys(leaving, '.q1.');
  await leaving.close();

  await call(staying, 'track', 'Own Event');
  await chunksReach(staying, 2);
  await context.setOffline(false);

  await flushUntilSent(staying, server, 'Before Leaving');
  await flushUntilSent(staying, server, 'Own Event');
  expect(appEvent(server, 'Before Leaving')).toHaveLength(1);
  // The page's own chunk went first (Web Queue 3: own chunks, then released or aged ones).
  const names = sent(server)
    .filter((event) => event.source === 'app')
    .map((event) => event.event);
  expect(names).toEqual(['Own Event', 'Before Leaving']);
  await expect.poll(() => storedKeys(staying, '.q1.')).toEqual([]);
  expect(released.every((key) => key.includes('.q1.'))).toBe(true);
  // The marker of a page whose chunks are gone is removed by the walk.
  await expect.poll(() => storedKeys(staying, '.q1r.')).toEqual([]);
});

test.describe('a chunk of a tab that died without pagehide', () => {
  /**
   * A tab writes a chunk while offline and goes away leaving it unreleased, as a crashed tab would;
   * the context is online again afterwards.
   */
  async function deadTabChunk(context: BrowserContext, server: TestServer): Promise<void> {
    const dying = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
    const plain = await context.newPage();
    await plain.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await context.setOffline(true);
    await call(dying, 'track', 'From Dead Tab');
    await chunksReach(dying, 1);
    // Chromium and WebKit run `pagehide` on close (step 1.4); the marker it writes is removed, so
    // the chunk is what a tab that crashed leaves behind.
    await dying.close();
    await plain.evaluate(() => {
      Object.keys(localStorage)
        .filter((key) => key.includes('.q1r.'))
        .forEach((key) => {
          localStorage.removeItem(key);
        });
    });
    expect(await storedKeys(plain, '.q1.')).toHaveLength(1);
    await plain.close();
    await context.setOffline(false);
  }

  test('is not sent by another tab before the adoption age', async ({ context, server }) => {
    await deadTabChunk(context, server);
    const other = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
    await call(other, 'track', 'Own Event');

    await flushUntilSent(other, server, 'Own Event');
    await call(other, 'flush');
    await expect.poll(async () => (await storedKeys(other, '.q1.')).length).toBe(1);
    expect(appEvent(server, 'From Dead Tab')).toEqual([]);
  });

  test('is sent by another tab once it is older than the adoption age', async ({ context, server }) => {
    await deadTabChunk(context, server);
    // The clock (Playwright's is the context's) runs an hour and a minute ahead from now on, so the
    // dead tab's chunk is past the age for the tab opened next.
    await context.clock.install({ time: Date.now() + ADOPT_AFTER_MS + 60_000 });
    const later = await context.newPage();
    await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG, page: later });

    await flushUntilSent(later, server, 'From Dead Tab');
    expect(appEvent(server, 'From Dead Tab')).toHaveLength(1);
    await expect.poll(() => storedKeys(later, '.q1.')).toEqual([]);
  });
});
