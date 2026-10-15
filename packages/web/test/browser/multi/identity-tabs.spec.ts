import { TEST_HOST_A, TEST_HOST_B, expect, test } from '../fixtures';
import type { WireEvent } from './tabs';
import { appEvent, call, cookieReaches, cookieValue, deviceIdOf, flushUntilSent, openTab, sent } from './tabs';

// Web Identity 2 and 3 and Web Session 2 and 5 across real tabs and subdomains (step 8.1): the
// identity cookie carries `device_id`, `user_id` and `person_epoch` for the whole site, super
// properties stay per host, every call reads the shared state, one session spans every tab and
// subdomain in its own cookie, and a person change in one tab ends that session once.

const API_KEY = 'rk_identity_tabs';
const CONFIG = { autocapture: { enabled: ['sessions'] } };

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

function sessionEvents(events: readonly WireEvent[], name: 'Session Started' | 'Session Ended'): WireEvent[] {
  return events.filter((event) => event.source === 'auto' && event.event === name);
}

test.describe('the identity across subdomains (Web Identity 2)', () => {
  test('one device and user on both hosts; super properties stay per host', async ({ context, server }) => {
    const www = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
    await call(www, 'identify', 'user-42');
    await call(www, 'register', 'plan', 'pro');
    await call(www, 'track', 'On Www');
    const onWww = await flushUntilSent(www, server, 'On Www');

    const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config: CONFIG });
    expect(await deviceIdOf(shop)).toBe(onWww.device_id);
    await call(shop, 'track', 'On Shop');
    const onShop = await flushUntilSent(shop, server, 'On Shop');

    expect(onShop).toMatchObject({ device_id: onWww.device_id, user_id: 'user-42' });
    expect(onWww.properties).toEqual({ plan: 'pro' });
    expect(onShop.properties).toEqual({});
  });

  test('with crossSubdomain off each host keeps its own device', async ({ context, server }) => {
    const config = { ...CONFIG, identity: { crossSubdomain: false } };
    const www = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config });
    const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config });

    const ids = [await deviceIdOf(www), await deviceIdOf(shop)];

    expect(ids[0]).not.toBe(ids[1]);
    const cookies = await context.cookies([server.url('/', TEST_HOST_A), server.url('/', TEST_HOST_B)]);
    expect(cookies.filter((cookie) => /^rubicon_[0-9a-f]{16}$/.test(cookie.name)).map((c) => c.domain)).toEqual(
      expect.arrayContaining([TEST_HOST_A, TEST_HOST_B]),
    );
  });
});

test.describe('the identity across tabs (Web Identity 3)', () => {
  test('two tabs that start at once agree on one device id by their next calls', async ({ context, server }) => {
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all(
      pages.map((page) => openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG, page })),
    );
    // Both generate at the same moment. In Firefox each tab's `document.cookie` may then keep its own
    // value; the next call of each, one after the other as a person makes them, confirms the id it
    // wrote: still there, it is written once more; another one there, it is taken (section 15, 8.1).
    await Promise.all(pages.map((page) => deviceIdOf(page)));
    await expect
      .poll(async () => {
        for (const page of pages) await deviceIdOf(page);
        const values = await Promise.all(pages.map((page) => cookieValue(page, '')));
        return values[0] !== undefined && values[0] === values[1];
      })
      .toBe(true);
    const stored = await cookieValue(pages[0], '');

    const ids = await Promise.all(pages.map((page) => deviceIdOf(page)));

    expect(ids).toEqual([stored?.split('.')[1], stored?.split('.')[1]]);
  });

  test('a tab that gave up its first-visit id sends its events under the stored one', async ({ context, server }) => {
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all(
      pages.map((page) => openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG, page })),
    );
    await Promise.all(pages.map((page) => call(page, 'track', 'First Event')));
    await expect
      .poll(async () => {
        for (const page of pages) await deviceIdOf(page);
        const values = await Promise.all(pages.map((page) => cookieValue(page, '')));
        return values[0] !== undefined && values[0] === values[1];
      })
      .toBe(true);
    const deviceId = await deviceIdOf(pages[0]);

    for (const page of pages) await call(page, 'flush');
    await expect.poll(() => appEvent(server, 'First Event').length).toBe(2);
    expect(appEvent(server, 'First Event').map((event) => event.device_id)).toEqual([deviceId, deviceId]);
  });

  test("an identify in one tab is carried by the other tab's next event, a reset likewise", async ({
    context,
    server,
  }) => {
    const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
    const second = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });

    await call(first, 'identify', 'user-7');
    await cookieReaches(second, '', /\.user-7$/);
    await call(second, 'track', 'After Identify');
    expect(await flushUntilSent(second, server, 'After Identify')).toMatchObject({ user_id: 'user-7' });

    await call(first, 'reset');
    await cookieReaches(second, '', /\.$/);
    await call(second, 'track', 'After Reset');
    expect(await flushUntilSent(second, server, 'After Reset')).toMatchObject({ user_id: null });
  });
});

test.describe('one session per site (Web Session 2 and 5)', () => {
  test('every tab and subdomain carries the same session', async ({ context, server }) => {
    const www = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
    const other = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
    const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config: CONFIG });

    await call(www, 'track', 'First');
    await cookieReaches(shop, '_s', /^1\./);
    await call(other, 'track', 'Second');
    await call(shop, 'track', 'Third');
    const events = [
      await flushUntilSent(www, server, 'First'),
      await flushUntilSent(other, server, 'Second'),
      await flushUntilSent(shop, server, 'Third'),
    ];

    const ids = new Set(events.map((event) => event.context.session?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeDefined();
    expect(sessionEvents(sent(server), 'Session Started')).toHaveLength(1);
  });

  test('a reset in one tab ends the session once; the other tab goes on in a new session', async ({
    context,
    server,
  }) => {
    const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
    const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config: CONFIG });
    await call(first, 'identify', 'user-9');
    await call(first, 'track', 'Before Reset');
    const before = await flushUntilSent(first, server, 'Before Reset');

    await call(first, 'reset');
    // The person change wrote the identity cookie with a new epoch and cleared the session cookie.
    await cookieReaches(shop, '', /\.$/);
    await call(shop, 'track', 'After Reset');
    const after = await flushUntilSent(shop, server, 'After Reset');
    await call(first, 'flush');
    await expect.poll(() => sessionEvents(sent(server), 'Session Ended').length).toBe(1);

    const [ended] = sessionEvents(sent(server), 'Session Ended');
    expect(ended).toMatchObject({ user_id: 'user-9', context: { session: before.context.session } });
    expect(after.user_id).toBeNull();
    expect(after.context.session?.id).toBeDefined();
    expect(after.context.session?.id).not.toBe(before.context.session?.id);
    // Only the tab that made the change produced the end (Web Identity 3, Web Session 5).
    await call(shop, 'flush');
    expect(sessionEvents(sent(server), 'Session Ended')).toHaveLength(1);
  });
});
