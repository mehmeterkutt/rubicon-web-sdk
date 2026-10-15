import { TEST_HOST_A, TEST_HOST_B, expect, test } from '../fixtures';
import {
  appEvent,
  call,
  chunksReach,
  cookieReaches,
  deviceIdOf,
  flushUntilSent,
  lineMatching,
  openTab,
  sent,
  storedKeys,
} from './tabs';

// Web Privacy 3 across real tabs and subdomains (step 8.1): `clearLocalData()` deletes every chunk
// and marker of the key, other tabs' included, and renews the device id; an event that carries the
// old `device_id` is never written by any tab and never sent from any subdomain, whose chunks this
// page cannot reach; super properties stored under another subdomain never move to the new identity.

const API_KEY = 'rk_erasure_tabs';
const CONFIG = { autocapture: { enabled: ['sessions'] } };

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

test("an erasure deletes the other tab's stored chunks; nothing of the old device is sent", async ({
  context,
  server,
}) => {
  const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const second = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const oldId = await deviceIdOf(first);
  await context.setOffline(true);
  await call(first, 'track', 'Old First');
  await call(second, 'track', 'Old Second');
  await chunksReach(second, 2);

  await call(first, 'clearLocalData');

  expect(await storedKeys(second, '.q1.')).toEqual([]);
  const newId = await deviceIdOf(first);
  expect(newId).not.toBe(oldId);
  await cookieReaches(second, '', new RegExp(`^1\\.${newId}\\.`));
  await call(second, 'track', 'New Second');
  await context.setOffline(false);
  const fresh = await flushUntilSent(second, server, 'New Second');

  expect(fresh.device_id).toBe(newId);
  expect(sent(server).every((event) => event.device_id === newId)).toBe(true);
  expect([...appEvent(server, 'Old First'), ...appEvent(server, 'Old Second')]).toEqual([]);
});

test('an event another tab accepted but had not written is never written under the old device', async ({
  context,
  server,
}) => {
  const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const writer = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  await deviceIdOf(writer);
  // Playwright's clock is the context's: paused, no tab's writer slice runs until the test moves time
  // (Web Queue 1), so the accepted event is still in the writer's queue when the other tab clears.
  await context.clock.install();
  await context.clock.pauseAt(Date.now() + 1000);
  await call(writer, 'track', 'Accepted Before Clear');

  await call(first, 'clearLocalData');
  const newId = await deviceIdOf(first);
  await cookieReaches(writer, '', new RegExp(`^1\\.${newId}\\.`));
  await context.clock.runFor(100);

  await lineMatching(writer, /^debug Event [0-9a-f-]{36} belongs to a cleared device id; it was not stored$/);
  await call(first, 'track', 'After Clear');
  await expect
    .poll(async () => {
      await call(first, 'flush');
      await context.clock.runFor(100);
      return appEvent(server, 'After Clear').length;
    })
    .toBe(1);
  expect(appEvent(server, 'Accepted Before Clear')).toEqual([]);
});

test("another subdomain's chunks under the old device are dropped there, and its super properties stay behind", async ({
  context,
  server,
}) => {
  const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config: CONFIG });
  const www = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  await call(shop, 'register', 'cart', 'full');
  await context.setOffline(true);
  await call(shop, 'track', 'Old On Shop');
  await chunksReach(shop, 1);

  // Only this origin's storage is within reach; the shared identity cookie carries the new id.
  await call(www, 'clearLocalData');
  const newId = await deviceIdOf(www);
  expect(await storedKeys(shop, '.q1.')).toHaveLength(1);
  await cookieReaches(shop, '', new RegExp(`^1\\.${newId}\\.`));

  await context.setOffline(false);
  await call(shop, 'track', 'New On Shop');
  const fresh = await flushUntilSent(shop, server, 'New On Shop');
  await lineMatching(shop, /^debug \d+ stored events belong to a cleared device id; they are not sent$/);

  expect(fresh).toMatchObject({ device_id: newId, properties: {} });
  expect(appEvent(server, 'Old On Shop')).toEqual([]);
  await expect.poll(() => storedKeys(shop, '.q1.')).toEqual([]);
});
