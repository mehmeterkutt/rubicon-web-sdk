import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from './fixtures';

// The two-tag snippet of step 7.8 in the three engines (Web Public API 2 and its Changed on note,
// Web HTTP 6, Web Context 4, Web Lifecycle 2, Web Session 5): the stub as an inline script allowed
// by its published hash under a strict Content Security Policy, a second inline script with the
// site's `init`, and `<script async src integrity crossorigin>` for the script build, whose answer
// the test holds back so calls can be made before it arrives. The page is written to the worker's
// server and served on the page's host, the script build answered by `page.route`; the API is the
// same server on 127.0.0.1, another origin. The rules themselves are unit-tested in jsdom (test/unit/snippet.test.ts).

const dist = (name: string): string => fileURLToPath(new URL(`../../dist/${name}`, import.meta.url));
const API_KEY = 'rk_snippet';

interface Published {
  readonly stub: string;
  readonly stubHash: string;
  readonly integrity: string;
}

interface WireEvent {
  readonly type: string;
  readonly event?: string;
  readonly name?: string;
  readonly timestamp: number;
  readonly properties?: Record<string, unknown>;
  readonly context: { readonly page?: { readonly url?: string } };
}

function published(): Published {
  return JSON.parse(readFileSync(dist('snippet.json'), 'utf8')) as Published;
}

/** The CSP hash of an inline script the site writes itself. */
function cspHash(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

interface SnippetPage {
  /** Lets the held script build answer. */
  readonly release: () => void;
  /** The browser's console lines and the page's uncaught errors. */
  readonly console: string[];
  readonly errors: string[];
}

/**
 * Opens a page with the two-tag snippet. `init` is the site's own inline script, allowed by its own
 * hash; `stub` replaces the published stub text, which the policy still allows only by the published
 * hash. The script build is held until `release`, or never answered with `library: 'never'`.
 */
async function openSnippet(
  page: Page,
  server: TestServer,
  options: { readonly init: string; readonly stub?: string; readonly library?: 'held' | 'never' },
): Promise<SnippetPage> {
  const { stub, stubHash, integrity } = published();
  const pageUrl = server.url('/snippet/page.html?utm_source=news&token=secret#top', TEST_HOST_A);
  const policy = [
    "default-src 'none'",
    `script-src '${stubHash}' '${cspHash(options.init)}' 'self'`,
    `connect-src ${server.origin()}`,
  ].join('; ');
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<title>snippet</title>' +
    `<script>${options.stub ?? stub}</script>` +
    `<script>${options.init}</script>` +
    `<script async src="/snippet/rubicon.min.js" integrity="${integrity}" crossorigin="anonymous"></script>` +
    '</head><body></body></html>';
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Written to the server rather than answered by `page.route`: Chromium lets only a page of the
  // loopback address space call the API on 127.0.0.1 (Private Network Access).
  server.page('/snippet/page.html', { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html });
  await page.route('**/snippet/rubicon.min.js', async (route: Route) => {
    if (options.library === 'never') {
      await route.abort();
      return;
    }
    await held;
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(dist('rubicon.min.js')) });
  });
  const consoleLines: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  // The load event waits for the async script, which the test holds.
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  return { release, console: consoleLines, errors };
}

/** The site's inline `init`: the configuration, a logger into `window.__lines`, and queued calls. */
function initScript(server: TestServer, calls = ''): string {
  return (
    'window.__lines = [];' +
    'rubicon.init({' +
    `apiKey: "${API_KEY}", host: "${server.origin()}",` +
    'logging: { level: "debug", logger: function (level, message) { window.__lines.push(level + " " + message); } }' +
    '});' +
    calls
  );
}

async function loaded(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof (Reflect.get(window, 'rubicon') as { deviceId?: unknown }).deviceId))
    .toBe('string');
}

function sent(server: TestServer): WireEvent[] {
  return server.requests
    .filter((request) => request.method === 'POST' && request.path === '/v1/batch')
    .flatMap((request: RecordedRequest) => (JSON.parse(request.body) as { batch: WireEvent[] }).batch);
}

async function sentEvents(page: Page, server: TestServer, count: number): Promise<WireEvent[]> {
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        (Reflect.get(window, 'rubicon') as { flush: () => void }).flush();
      });
      return sent(server).length;
    })
    .toBeGreaterThanOrEqual(count);
  return sent(server);
}

function nameOf(event: WireEvent): string {
  return event.event ?? event.name ?? event.type;
}

function pathOf(event: WireEvent | undefined): string {
  return new URL(event?.context.page?.url ?? 'about:blank').pathname;
}

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

test('the two tags under a strict policy: the stub by its hash, the queue replayed in order with its moments', async ({
  page,
  server,
}) => {
  const snippet = await openSnippet(page, server, {
    init: initScript(
      server,
      'rubicon.track("Queued A", { n: 1 });' +
        'history.pushState(null, "", "/snippet/second");' +
        'rubicon.identify("user-1");' +
        'rubicon.track("Queued B");',
    ),
  });
  await page.evaluate(() => {
    (Reflect.get(window, 'rubicon') as { track: (name: string) => void }).track('While waiting');
  });
  const beforeLoad = await page.evaluate(() => Date.now());

  snippet.release();
  await loaded(page);
  await page.evaluate(() => {
    (Reflect.get(window, 'rubicon') as { track: (name: string) => void }).track('Live');
  });
  const events = await sentEvents(page, server, 7);

  expect(events.map(nameOf)).toEqual([
    'Session Started',
    'Page Viewed',
    'Queued A',
    'identify',
    'Queued B',
    'While waiting',
    'Live',
  ]);
  const byName = (name: string): WireEvent | undefined => events.find((event) => nameOf(event) === name);
  expect(byName('Page Viewed')?.properties).toEqual({ utm_source: 'news' });
  expect(pathOf(byName('Page Viewed'))).toBe('/snippet/page.html');
  expect(pathOf(byName('Queued A'))).toBe('/snippet/page.html');
  expect(pathOf(byName('Queued B'))).toBe('/snippet/second');
  for (const name of ['Page Viewed', 'Queued A', 'Queued B', 'While waiting']) {
    expect(byName(name)?.timestamp).toBeLessThanOrEqual(beforeLoad);
  }
  expect(byName('Live')?.timestamp).toBeGreaterThanOrEqual(beforeLoad);
  expect(JSON.stringify(events)).not.toContain('secret');
  expect(snippet.errors).toEqual([]);
  expect(snippet.console.filter((line) => line.includes('Content Security Policy'))).toEqual([]);
});

test('a stub that is not the published text is refused by the same policy (the control)', async ({ page, server }) => {
  const { stub } = published();
  const snippet = await openSnippet(page, server, { init: 'window.__init = 1;', stub: `${stub} ` });
  snippet.release();

  expect(await page.evaluate(() => Reflect.get(window, '__init') as unknown)).toBe(1);
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'Rubicon'))).toBe('object');
  expect(await page.evaluate(() => typeof Reflect.get(window, 'rubicon'))).toBe('undefined');
});

test('a verb the library does not know is skipped with a DEBUG line, the rest replayed', async ({ page, server }) => {
  const snippet = await openSnippet(page, server, {
    init: initScript(server, 'rubicon._q.push(["group", ["acme"], { t: Date.now() }]);rubicon.track("Kept");'),
  });

  snippet.release();
  await loaded(page);
  const events = await sentEvents(page, server, 3);

  expect(events.map(nameOf)).toEqual(['Session Started', 'Page Viewed', 'Kept']);
  const lines = await page.evaluate(() => Reflect.get(window, '__lines') as string[]);
  expect(lines).toContain('debug The snippet queued a call the library does not know; it was skipped');
  // The test host is http, which warns; nothing else is a WARN or an ERROR.
  expect(lines.filter((line) => /^(warn|error) /.test(line) && !line.includes('CLEARTEXT_HOST'))).toEqual([]);
});

test('a library that never arrives leaves the page working, with nothing stored or sent', async ({ page, server }) => {
  const snippet = await openSnippet(page, server, { init: initScript(server), library: 'never' });

  const result = await page.evaluate(() => {
    const rubicon = Reflect.get(window, 'rubicon') as Record<string, (...args: unknown[]) => unknown>;
    const returned = [
      rubicon['track']?.('Lost', { n: 1 }),
      rubicon['identify']?.('user-1'),
      rubicon['optOut']?.(),
      rubicon['flush']?.(),
    ];
    return {
      returned,
      queued: (Reflect.get(rubicon, '_q') as unknown as unknown[]).length,
      storage: localStorage.length,
      cookies: document.cookie,
    };
  });

  expect(result).toEqual({
    returned: [undefined, undefined, undefined, undefined],
    queued: 6,
    storage: 0,
    cookies: '',
  });
  expect(snippet.errors).toEqual([]);
  expect(server.requests).toEqual([]);
});

test('a second load of the library is refused with an error line and changes nothing', async ({ page, server }) => {
  const snippet = await openSnippet(page, server, { init: initScript(server) });
  snippet.release();
  await loaded(page);
  await page.evaluate(() => {
    Reflect.set(window, '__first', [Reflect.get(window, 'Rubicon'), Reflect.get(window, 'rubicon')]);
  });

  await page.addScriptTag({ url: '/snippet/rubicon.min.js' });

  await expect
    .poll(() => snippet.console.filter((line) => line.startsWith('[Rubicon] SECOND_INSTANCE: The script build')))
    .toHaveLength(1);
  const same = await page.evaluate(() => {
    const [first, stub] = Reflect.get(window, '__first') as unknown[];
    return Reflect.get(window, 'Rubicon') === first && Reflect.get(window, 'rubicon') === stub;
  });
  expect(same).toBe(true);
  const events = await sentEvents(page, server, 2);
  expect(events.filter((event) => nameOf(event) === 'Page Viewed')).toHaveLength(1);
  expect(snippet.errors).toEqual([]);
});
