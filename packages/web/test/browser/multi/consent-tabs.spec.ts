import { TEST_HOST_A, TEST_HOST_B, TEST_SITE, expect, test } from '../fixtures';
import {
  appEvent,
  call,
  chunksReach,
  cookieReaches,
  cookieValue,
  flushUntilSent,
  isOptedOut,
  lineMatching,
  openTab,
  setVisibility,
} from './tabs';

// Web Privacy 2 across real tabs and subdomains (step 8.1): the decision lives in its own cookie on
// the identity cookie's domain, with `.consent` as its mirror, and is read on every call and before
// every upload; the later decision wins; a pending tab picks up another tab's decision. The
// `storage` event between two tabs of one origin is in page-lifecycle.spec.ts (step 7.4).

const API_KEY = 'rk_consent_tabs';
const CONFIG = { autocapture: { enabled: ['sessions'] } };

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

test('an opt-out on one subdomain holds on the other, in a cookie of the site', async ({ context, server }) => {
  const www = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  await call(www, 'optOut');
  expect(await cookieValue(www, '_c')).toMatch(/^1\.denied\.\d+$/);

  const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config: CONFIG });
  expect(await isOptedOut(shop)).toBe(true);
  await call(shop, 'track', 'Not Collected');
  await call(shop, 'flush');
  expect(await shop.evaluate(() => Object.keys(localStorage).some((key) => key.includes('.q1.')))).toBe(false);

  // The cookie is on the site's registrable domain (Web Identity 2), not the host.
  const cookies = await context.cookies(server.url('/', TEST_HOST_B));
  expect(cookies.find((cookie) => cookie.name.endsWith('_c'))?.domain).toBe(`.${TEST_SITE}`);
});

test('the later decision wins across subdomains', async ({ context, server }) => {
  const www = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config: CONFIG });
  await call(www, 'optOut');
  await cookieReaches(shop, '_c', /^1\.denied\./);
  expect(await isOptedOut(shop)).toBe(true);

  await call(shop, 'optIn');
  await cookieReaches(www, '_c', /^1\.granted\./);

  // The other subdomain's mirror still says denied; the cookie's later decision wins.
  expect(
    await www.evaluate(() =>
      Object.keys(localStorage).some((key) => (localStorage.getItem(key) ?? '').includes('denied')),
    ),
  ).toBe(true);
  expect(await isOptedOut(www)).toBe(false);
  await call(www, 'track', 'Collected Again');
  await flushUntilSent(www, server, 'Collected Again');
});

test('an opt-out in one tab stops the other tab, whose queued events wait for an opt-in', async ({
  context,
  server,
}) => {
  const first = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  const second = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: CONFIG });
  await context.setOffline(true);
  await call(second, 'track', 'Queued Before');
  await chunksReach(second, 1);

  await call(first, 'optOut');
  await cookieReaches(second, '_c', /^1\.denied\./);
  // The other tab's next call reads the decision: nothing new is accepted (Web Privacy 2, point 2).
  await call(second, 'track', 'After Opt Out');
  await context.setOffline(false);
  await call(second, 'flush');
  await call(first, 'flush');
  await lineMatching(second, /^info The user opted out; nothing new is collected or sent$/);
  expect(appEvent(server, 'Queued Before')).toEqual([]);

  // While refused the queue stays (Web Logging 4); an opt-in sends it, never what came in between.
  await call(first, 'optIn');
  await cookieReaches(second, '_c', /^1\.granted\./);
  await flushUntilSent(second, server, 'Queued Before');
  expect(appEvent(server, 'After Opt Out')).toEqual([]);
});

test('a pending tab on another subdomain takes the decision when it becomes visible', async ({ context, server }) => {
  const pendingConfig = { ...CONFIG, privacy: { defaultConsent: 'pending' } };
  const shop = await openTab(context, server, { host: TEST_HOST_B, apiKey: API_KEY, config: pendingConfig });
  await call(shop, 'track', 'Waiting For Consent');
  expect(await isOptedOut(shop)).toBe(true);
  await setVisibility(shop, 'hidden');

  const www = await openTab(context, server, { host: TEST_HOST_A, apiKey: API_KEY, config: pendingConfig });
  await call(www, 'optIn');
  await cookieReaches(shop, '_c', /^1\.granted\./);

  // No `storage` event crosses origins; the return to the tab reads the cookie (point 3).
  await setVisibility(shop, 'visible');
  await lineMatching(shop, /^info The user opted in; collection resumes$/);
  await flushUntilSent(shop, server, 'Waiting For Consent');
});
