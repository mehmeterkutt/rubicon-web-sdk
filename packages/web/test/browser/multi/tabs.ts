// What the several-tab and several-host specs of step 8.1 share (plan section 5, "Several tabs and
// hosts"): a tab is a Playwright page of one context, so tabs share cookies and each origin's
// `localStorage`, on the hosts of D15; the SDK is the script build, created with a logger that
// keeps every line in the page. As in page-lifecycle.spec.ts (plan section 15, step 7.4), hiding is
// the engine's own `visibilitychange` with `document.visibilityState` replaced, and `pagehide` the
// engine's own `PageTransitionEvent`, since Playwright neither hides a page nor keeps one in the
// back/forward cache.
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { expect } from '../fixtures';

const scriptBuild = fileURLToPath(new URL('../../../dist/rubicon.min.js', import.meta.url));

/** One event as the server received it. */
export interface WireEvent {
  readonly type: string;
  readonly event?: string;
  readonly source?: string;
  readonly message_id: string;
  readonly user_id: string | null;
  readonly device_id: string;
  readonly properties?: Record<string, unknown>;
  readonly context: { readonly session?: { readonly id: string; readonly started_at: number } };
}

/** The verbs a test calls on `window.__analytics`. */
type Verb =
  'track' | 'identify' | 'reset' | 'register' | 'unregister' | 'flush' | 'optIn' | 'optOut' | 'clearLocalData';

/**
 * Opens a tab on `host` (a new page of `context`, or `page` when given), loads the script build and
 * creates the instance with `apiKey`, the server as its host and `config`; `window.__analytics` is
 * the instance and `window.__lines` every log line as `level message`.
 */
export async function openTab(
  context: BrowserContext,
  server: TestServer,
  options: {
    readonly host: string;
    readonly apiKey: string;
    readonly config?: Record<string, unknown>;
    readonly page?: Page;
    readonly path?: string;
  },
): Promise<Page> {
  const page = options.page ?? (await context.newPage());
  await page.goto(server.url(options.path ?? '/pages/blank.html', options.host));
  await page.addScriptTag({ path: scriptBuild });
  await page.evaluate(
    ({ apiKey, host, extra }) => {
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
          ...extra,
        }),
      );
    },
    { apiKey: options.apiKey, host: server.origin(), extra: options.config ?? {} },
  );
  return page;
}

/** Calls `verb` on the tab's instance with `args`. */
export async function call(page: Page, verb: Verb, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ({ name, values }) => {
      const analytics = Reflect.get(window, '__analytics') as Record<string, (...rest: unknown[]) => void>;
      analytics[name]?.(...values);
    },
    { name: verb, values: args },
  );
}

/** The tab's `deviceId`, read through the instance. */
export function deviceIdOf(page: Page): Promise<string> {
  return page.evaluate(() => (Reflect.get(window, '__analytics') as { deviceId: string }).deviceId);
}

/** The tab's `isOptedOut`, read through the instance. */
export function isOptedOut(page: Page): Promise<boolean> {
  return page.evaluate(() => (Reflect.get(window, '__analytics') as { isOptedOut: boolean }).isOptedOut);
}

/** Every log line the tab's instance wrote so far. */
export function lines(page: Page): Promise<string[]> {
  return page.evaluate(() => (Reflect.get(window, '__lines') as string[]).slice());
}

/** Waits until the tab logged a line matching `pattern`. */
export async function lineMatching(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(async () => (await lines(page)).some((line) => pattern.test(line))).toBe(true);
}

/** The batch uploads the server received, oldest first. */
export function batches(server: TestServer): RecordedRequest[] {
  return server.requests.filter((request) => request.method === 'POST' && request.path === '/v1/batch');
}

/** The events of one batch. */
export function eventsOf(request: RecordedRequest): WireEvent[] {
  return (JSON.parse(request.body) as { batch: WireEvent[] }).batch;
}

/** Every event the server received, in arrival order. */
export function sent(server: TestServer): WireEvent[] {
  return batches(server).flatMap(eventsOf);
}

/** The app's own track events the server received, by name. */
export function appEvent(server: TestServer, name: string): WireEvent[] {
  return sent(server).filter((event) => event.source === 'app' && event.event === name);
}

/** Flushes `page` until the server has received the app event `name`; that event. */
export async function flushUntilSent(page: Page, server: TestServer, name: string): Promise<WireEvent> {
  await expect
    .poll(async () => {
      await call(page, 'flush');
      return appEvent(server, name).length;
    })
    .toBeGreaterThan(0);
  return appEvent(server, name)[0] as WireEvent;
}

/** The SDK's `localStorage` keys of the tab's origin under `infix` (`.q1.` chunks, `.q1r.` markers). */
export function storedKeys(page: Page, infix: '.q1.' | '.q1r.'): Promise<string[]> {
  return page.evaluate((part) => Object.keys(localStorage).filter((key) => key.includes(part)), infix);
}

/** Waits until the tab's origin holds at least `count` chunks: the writer stored what was accepted. */
export async function chunksReach(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await storedKeys(page, '.q1.')).length).toBeGreaterThanOrEqual(count);
}

/** The engine's `pagehide`, as a page that is left receives it; the released marker is written then. */
export async function pagehide(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });
}

/** The engine's `visibilitychange` with `document.visibilityState` replaced on the document. */
export async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** The value of the SDK's cookie `name` (`rubicon_<keyHash>`, `_s`, `_c`) as the tab sees it. */
export function cookieValue(page: Page, suffix: '' | '_s' | '_c'): Promise<string | undefined> {
  return page.evaluate((end) => {
    const pattern = new RegExp(`(?:^|; )rubicon_[0-9a-f]{16}${end}=([^;]*)`);
    return pattern.exec(document.cookie)?.[1];
  }, suffix);
}

/**
 * Waits until the tab's `document.cookie` shows the SDK's cookie `suffix` matching `pattern`. A
 * cookie another tab wrote reaches this tab's `document.cookie` after a few milliseconds in WebKit
 * (measured on 2026-10-15, plan section 15, step 8.1), so a test lets it arrive before the tab's next
 * call, as a person switching tabs always does.
 */
export async function cookieReaches(page: Page, suffix: '' | '_s' | '_c', pattern: RegExp): Promise<void> {
  await expect.poll(async () => pattern.test((await cookieValue(page, suffix)) ?? '')).toBe(true);
}
