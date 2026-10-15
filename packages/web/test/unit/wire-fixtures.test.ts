import { createCore, keyHash, parseQueueKey, shutdown, storeKey } from 'rubicon-analytics-core';
import type { Analytics, Platform } from 'rubicon-analytics-core';
import {
  parseWithPython,
  RecordingSink,
  TestClock,
  TestPlatform,
  webFixture,
  webFixtureNames,
  withStableValuesOf,
} from 'rubicon-analytics-testing';
import type { JsonObject } from 'rubicon-analytics-testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { attachPageViews, PAGE_VIEW_WINDOW_MS } from '../../src/autocapture/page-views';
import { resetHistoryForTests } from '../../src/autocapture/history-registry';
import { createBrowserContext } from '../../src/platform/browser-context';
import { resetForTests } from '../../src/testing';

// The web-only fixtures of step 8.4 (Web Event Model 4, Web Context 5, Web Lifecycle 1): what the
// Android golden files cannot hold, pinned as regression snapshots in
// `packages/core/test/fixtures/web/`. `page-viewed.json` is a whole `Page Viewed` of a desktop Chrome
// page, stored by the real core with the browser's context provider and page views over a stubbed
// jsdom page: the `browser` and `page` groups, `device.type` `desktop`, the campaign of its URL and
// no `network` group. It is compared as the golden files are (ids, the session id and `library`
// checked and taken from the file); every stored line is parsed by Python (Web Serialization 3).
// `context.json` (step 7.5) is compared in browser-context.test.ts.

interface Reconfigurable {
  reconfigure(options: { url: string }): void;
}

const API_KEY = 'rk_wire_fixtures';
const KEY_HASH = keyHash(API_KEY);
const T0 = TestClock.DEFAULT_START;
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const jsdomUrl = location.href;
const restores: (() => void)[] = [];
const pages: Analytics[] = [];
const written: string[] = [];

afterEach(() => {
  for (const analytics of pages.splice(0)) shutdown(analytics);
  resetForTests();
  resetHistoryForTests();
  for (const restore of restores.splice(0).reverse()) restore();
  goTo(jsdomUrl);
});

afterAll(() => {
  parseWithPython(written).forEach((answer, i) => {
    const text = written[i] ?? '';
    expect(answer, text).toEqual({ ok: true, value: JSON.parse(text) as unknown });
  });
});

function goTo(url: string): void {
  (Reflect.get(globalThis, 'jsdom') as Reconfigurable).reconfigure({ url });
}

/** Replaces `name` on `target` with a fixed value until the end of the test. */
function stub(target: object, name: PropertyKey, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, get: () => value });
  restores.push(() => {
    if (own) Object.defineProperty(target, name, own);
    else Reflect.deleteProperty(target, name);
  });
}

/** A desktop Chrome on Windows with the viewport and referrer of the example of Web Context 2. */
function stubDesktopChrome(): void {
  stub(navigator, 'userAgent', CHROME_WINDOWS);
  stub(navigator, 'userAgentData', undefined);
  stub(navigator, 'maxTouchPoints', 0);
  stub(navigator, 'language', 'tr-TR');
  stub(screen, 'width', 1920);
  stub(screen, 'height', 1080);
  stub(window, 'devicePixelRatio', 1.25);
  stub(window, 'innerWidth', 1280);
  stub(window, 'innerHeight', 720);
  stub(document, 'referrer', 'https://www.example.com/');
  // The machine's zone would make the fixture depend on where the test runs.
  class FixedZone {
    resolvedOptions(): { timeZone: string } {
      return { timeZone: 'Europe/Istanbul' };
    }
  }
  stub(globalThis, 'Intl', { DateTimeFormat: FixedZone });
}

/** Every event line of this key's chunks in `localStorage`, parsed; each line is kept for Python. */
function stored(test: TestPlatform): JsonObject[] {
  const events: JsonObject[] = [];
  for (const [key, value] of test.storage.area.entries) {
    const parsed = parseQueueKey(key);
    if (parsed?.kind !== 'chunk' || parsed.name.keyHash !== KEY_HASH) continue;
    for (const text of value.split('\n')) {
      if (text === '') continue;
      written.push(text);
      events.push(JSON.parse(text) as JsonObject);
    }
  }
  return events;
}

describe('the web fixtures (Web Event Model 4)', () => {
  it('are the two pinned shapes', () => {
    expect(webFixtureNames()).toEqual(['context', 'page-viewed']);
  });

  it('Page Viewed of a desktop Chrome page matches page-viewed.json (Web Lifecycle 1, Web Context 1 to 3)', () => {
    stubDesktopChrome();
    goTo('https://shop.example.com/products/12345?utm_source=google&utm_medium=cpc&token=abc#top');
    // Offline, so the chunks stay in storage; the remote configuration fetched just now.
    const test = new TestPlatform({ online: false });
    test.storage.area.entries.set(
      storeKey(KEY_HASH, 'remote'),
      JSON.stringify({ v: 1, values: {}, fetched_at: test.clock.now() }),
    );
    const platform: Platform = { ...test.platform, context: createBrowserContext() };
    const analytics = createCore(
      {
        apiKey: API_KEY,
        logging: { sendDiagnostics: false },
        context: { app: { name: 'Rubicon', version: '1.4.0', namespace: 'com.rubicon.demo' } },
      },
      platform,
      {
        sink: new RecordingSink(),
        onCreated: (capture) => {
          attachPageViews(capture, platform);
        },
      },
    );
    pages.push(analytics);
    test.scheduler.runUntilIdle();
    test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    test.scheduler.runUntilIdle();

    const events = stored(test);
    expect(events.map((event) => event.event)).toEqual(['Session Started', 'Page Viewed']);
    const view = events[1] ?? {};
    const file = webFixture('page-viewed');
    expect(view.timestamp).toBe(T0);
    expect(withStableValuesOf(file, view, { keepWebGroups: true })).toEqual(file);
    expect(JSON.stringify(view)).not.toMatch(/token|#top|12345/);
  });
});
