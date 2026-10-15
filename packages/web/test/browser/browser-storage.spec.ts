import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';
import { TEST_HOST_A, TEST_HOST_B, expect, test } from './fixtures';

// Browser storage, cookies and the domain (step 7.2; Web Disk 1, 4, Web Identity 1, 2, Web Logging 3)
// with the script build in the three engines: what jsdom cannot show, each engine's public suffix
// list, a sandboxed iframe and the cookie scope another subdomain reads.

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));

interface Started {
  readonly deviceId: string;
  readonly lines: string[];
  /** `document.cookie` after the calls; `""` where it throws. */
  readonly cookie: string;
  /** The `localStorage` keys after the calls; none where it throws. */
  readonly keys: string[];
}

interface StartOptions {
  readonly privacy?: Record<string, unknown>;
  /** A user id to `identify` before the `track`. */
  readonly identify?: string;
}

/**
 * Loads the script build, creates the instance with `identity` and a logger that keeps every line,
 * and starts it with a `track`, its first use (Web Identity 1).
 */
async function start(
  target: Page | Frame,
  identity: Record<string, unknown> = {},
  options: StartOptions = {},
): Promise<Started> {
  await target.addScriptTag({ path: scriptBuild });
  return target.evaluate(
    ({ identity: settings, privacy, identify }) => {
      const lines: string[] = [];
      const rubicon = Reflect.get(window, 'Rubicon') as {
        createAnalytics: (config: unknown) => {
          deviceId: string;
          track: (name: string) => void;
          identify: (userId: string) => void;
        };
      };
      const analytics = rubicon.createAnalytics({
        apiKey: 'rk_browser_storage',
        identity: settings,
        privacy,
        logging: { level: 'debug', logger: (level: string, message: string) => lines.push(`${level} ${message}`) },
      });
      if (identify !== undefined) analytics.identify(identify);
      analytics.track('Stored');
      const deviceId = analytics.deviceId;
      let cookie = '';
      let keys: string[] = [];
      try {
        cookie = document.cookie;
        keys = Object.keys(localStorage);
      } catch {
        // A sandboxed frame: neither can be read.
      }
      return { deviceId, lines, cookie, keys };
    },
    { identity, privacy: options.privacy, identify: options.identify },
  );
}

/** The domains of the SDK's identity and session cookies, each once. */
function sdkCookieDomains(cookies: readonly { name: string; domain: string }[]): string[] {
  const domains = cookies.filter((cookie) => cookie.name.startsWith('rubicon_')).map((cookie) => cookie.domain);
  expect(domains).toHaveLength(2);
  return Array.from(new Set(domains));
}

function warnings(started: Started): string[] {
  return started.lines.filter((line) => line.startsWith('warn ') || line.startsWith('error '));
}

test('the domain probe finds rubicon.test on a.rubicon.test, and b.rubicon.test shares the identity', async ({
  page,
  context,
  server,
}) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  const first = await start(page);

  const cookies = await context.cookies(server.url('/', TEST_HOST_A));
  const identity = cookies.filter((cookie) => /^rubicon_[0-9a-f]{16}$/.test(cookie.name));
  expect(identity.map((cookie) => [cookie.domain.replace(/^\./, ''), cookie.path, cookie.sameSite])).toEqual([
    ['rubicon.test', '/', 'Lax'],
  ]);
  expect(identity[0]?.domain.startsWith('.')).toBe(true);
  expect(cookies.filter((cookie) => cookie.name.startsWith('__rubicon_dmn_'))).toEqual([]);
  expect(warnings(first)).toEqual([]);

  const other = await context.newPage();
  await other.goto(server.url('/pages/blank.html', TEST_HOST_B));
  const second = await start(other);
  expect(second.deviceId).toBe(first.deviceId);
});

test('cookies are host-only on localhost, without a probe', async ({ page, context, server }) => {
  await page.goto(server.url('/pages/blank.html', 'localhost'));
  const started = await start(page);

  const cookies = await context.cookies(server.url('/', 'localhost'));
  expect(sdkCookieDomains(cookies)).toEqual(['localhost']);
  expect(warnings(started)).toEqual([]);
});

test('crossSubdomain false gives host-only cookies that b.rubicon.test does not read', async ({
  page,
  context,
  server,
}) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  const first = await start(page, { crossSubdomain: false });
  const cookies = await context.cookies(server.url('/', TEST_HOST_A));
  expect(sdkCookieDomains(cookies)).toEqual([TEST_HOST_A]);

  const other = await context.newPage();
  await other.goto(server.url('/pages/blank.html', TEST_HOST_B));
  const second = await start(other, { crossSubdomain: false });
  expect(second.deviceId).not.toBe(first.deviceId);
});

test('a cookieDomain the browser refuses gives host-only cookies and INVALID_COOKIE_DOMAIN', async ({
  page,
  context,
  server,
}) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  const started = await start(page, { cookieDomain: 'test' });

  expect(warnings(started)).toEqual([
    'warn INVALID_COOKIE_DOMAIN: identity.cookieDomain was refused by the browser; cookies are host-only',
  ]);
  const cookies = await context.cookies(server.url('/', TEST_HOST_A));
  expect(sdkCookieDomains(cookies)).toEqual([TEST_HOST_A]);
});

test('a cookieDomain the browser takes is used without discovery', async ({ page, context, server }) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  const started = await start(page, { cookieDomain: 'rubicon.test' });

  expect(warnings(started)).toEqual([]);
  const cookies = await context.cookies(server.url('/', TEST_HOST_A));
  expect(sdkCookieDomains(cookies)).toEqual(['.rubicon.test']);
});

test('a sandboxed iframe runs from memory with one STORAGE_UNAVAILABLE', async ({ page, server }) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('name', 'sandboxed');
    frame.srcdoc = '<!doctype html><title>sandboxed</title>';
    document.body.appendChild(frame);
  });
  await expect.poll(() => page.frame({ name: 'sandboxed' })?.url()).toBe('about:srcdoc');
  const frame = page.frame({ name: 'sandboxed' });
  if (frame === null) throw new Error('no sandboxed frame');
  await frame.waitForLoadState();

  const started = await start(frame);

  expect(started.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(warnings(started)).toEqual([
    'warn STORAGE_UNAVAILABLE: Storage cannot be used; the SDK runs from memory on this page',
  ]);
});

test.describe('one scope per cookie name (plan section 15, step 7.2, answer 2)', () => {
  const identityPairs = (cookie: string): string[] =>
    cookie.split('; ').filter((pair) => /^rubicon_[0-9a-f]{16}=/.test(pair));

  test('after a change from host-only to the site, an identify sticks and one scope is left', async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    const before = await start(page, { crossSubdomain: false });

    const later = await context.newPage();
    await later.goto(server.url('/pages/blank.html', TEST_HOST_A));
    const after = await start(later, {}, { identify: 'user-1' });

    expect(after.deviceId).toBe(before.deviceId);
    expect(identityPairs(after.cookie)).toEqual([expect.stringMatching(/\.user-1$/) as unknown]);
    const cookies = await context.cookies(server.url('/', TEST_HOST_A));
    expect(cookies.filter((cookie) => /^rubicon_[0-9a-f]{16}$/.test(cookie.name)).map((c) => c.domain)).toEqual([
      '.rubicon.test',
    ]);
  });

  test('at first use the current scope is kept and the other deleted', async ({ page, server }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    // Learn the cookie name from a first instance, then plant the name in two scopes.
    const first = await start(page);
    const name = identityPairs(first.cookie)[0]?.split('=')[0] ?? '';
    const hostOnlyId = '0192e4a1-7c3f-7000-8000-00000000000a';
    const domainId = '0192e4a1-7c3f-7000-8000-00000000000b';
    const other = await page.context().newPage();
    await other.goto(server.url('/pages/blank.html', TEST_HOST_A));
    await other.evaluate(
      ({ cookieName, hostOnly, domain }) => {
        document.cookie = `${cookieName}=; Path=/; Max-Age=0; Domain=rubicon.test`;
        document.cookie = `${cookieName}=1.${hostOnly}.0123456789abcdef.; Path=/; Max-Age=600; SameSite=Lax`;
        document.cookie = `${cookieName}=1.${domain}.fedcba9876543210.; Path=/; Max-Age=600; SameSite=Lax; Domain=rubicon.test`;
      },
      { cookieName: name, hostOnly: hostOnlyId, domain: domainId },
    );
    expect(identityPairs(await other.evaluate(() => document.cookie))).toHaveLength(2);

    const started = await start(other);

    expect(started.deviceId).toBe(domainId);
    expect(identityPairs(started.cookie)).toEqual([`${name}=1.${domainId}.fedcba9876543210.`]);
  });
});

test.describe('the write half of the start probe (plan section 15, step 7.2, answer 3)', () => {
  // A zero quota, as in Safari 10's private mode: every `setItem` throws a `QuotaExceededError`.
  const zeroQuota = (): void => {
    Storage.prototype.setItem = function setItem(): void {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  };

  test('a granted page with a zero quota runs from memory with one STORAGE_UNAVAILABLE', async ({ page, server }) => {
    await page.addInitScript(zeroQuota);
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    const started = await start(page);

    expect(warnings(started)).toEqual([
      'warn STORAGE_UNAVAILABLE: Storage cannot be used; the SDK runs from memory on this page',
    ]);
    expect(started.cookie).toBe('');
  });

  test('a pending page with a zero quota tries no write and logs nothing', async ({ page, server }) => {
    await page.addInitScript(zeroQuota);
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    const started = await start(page, {}, { privacy: { defaultConsent: 'pending' } });

    expect(warnings(started)).toEqual([]);
    expect(started.cookie).toBe('');
  });

  test('a granted page leaves no probe key behind', async ({ page, server }) => {
    await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
    const started = await start(page);

    expect(started.keys.filter((key) => key.endsWith('.probe'))).toEqual([]);
    expect(started.keys.some((key) => key.endsWith('.device'))).toBe(true);
  });
});
