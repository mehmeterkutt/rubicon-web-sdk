import { createCore, shutdown, storeKey, keyHash } from 'rubicon-analytics-core';
import type { Analytics, Event, Platform } from 'rubicon-analytics-core';
import { RecordingSink, TestClock, TestPlatform } from 'rubicon-analytics-testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics } from '../../src';
import { historyRegistry, resetHistoryForTests } from '../../src/autocapture/history-registry';
import { attachPageViews, campaignOf, PAGE_VIEW_WINDOW_MS } from '../../src/autocapture/page-views';
import { createBrowserContext } from '../../src/platform/browser-context';
import { resetForTests } from '../../src/testing';

// Page views of step 7.6 (Web Lifecycle 1, 2, 5, 8) in jsdom: the core over the virtual-time
// `TestPlatform` with the browser's context provider, so `page.url` follows jsdom's `location`, and
// the real history registry wrapping jsdom's `history`. The visibility and the back/forward cache
// come from the fake lifecycle; time moves only when a test moves it. The three engines are
// test/browser/page-views.spec.ts.

interface Reconfigurable {
  reconfigure(options: { url: string }): void;
}

const API_KEY = 'rk_page_views';
const NOW = TestClock.DEFAULT_START;
const ORIGIN = 'https://shop.example.com';
const jsdomUrl = location.href;
const pages: Analytics[] = [];

afterEach(() => {
  for (const analytics of pages.splice(0)) shutdown(analytics);
  resetForTests();
  resetHistoryForTests();
  goTo(jsdomUrl);
});

function goTo(url: string): void {
  (Reflect.get(globalThis, 'jsdom') as Reconfigurable).reconfigure({ url });
}

interface Page {
  readonly test: TestPlatform;
  readonly analytics: Analytics;
  readonly sink: RecordingSink;
  /** Every event that reached the writer, in order. */
  readonly events: Event[];
  /** The `Page Viewed` events that reached the writer. */
  readonly views: () => Event[];
  /** Runs every slice and timer due now. */
  readonly run: () => void;
}

/** A page at `url` whose instance is created now; its remote configuration was fetched just now. */
function open(url: string, config: Record<string, unknown> = {}, test = new TestPlatform()): Page {
  goTo(url);
  const sink = new RecordingSink();
  const events: Event[] = [];
  const remote = storeKey(keyHash(API_KEY), 'remote');
  if (!test.storage.area.entries.has(remote)) {
    test.storage.area.entries.set(remote, JSON.stringify({ v: 1, values: {}, fetched_at: test.clock.now() }));
  }
  const platform: Platform = { ...test.platform, context: createBrowserContext() };
  const analytics = createCore(
    {
      apiKey: API_KEY,
      logging: { sendDiagnostics: false },
      beforeSend: [
        (event: Event) => {
          events.push(event);
          return event;
        },
      ],
      ...config,
    },
    platform,
    {
      sink,
      onCreated: (capture) => {
        attachPageViews(capture, platform);
      },
    },
  );
  pages.push(analytics);
  return {
    test,
    analytics,
    sink,
    events,
    views: () => events.filter((event) => event.type === 'track' && event.name === 'Page Viewed'),
    run: () => {
      test.scheduler.runUntilIdle();
    },
  };
}

/** The `history` method the page calls now, read without detaching it from `history`. */
function method(name: 'pushState' | 'replaceState'): unknown {
  return Reflect.get(history, name);
}

function urlOf(event: Event | undefined): unknown {
  return event?.context.page.url;
}

function propertiesOf(event: Event | undefined): unknown {
  return event?.type === 'identify' ? undefined : event?.properties;
}

describe('the load (Web Lifecycle 2)', () => {
  it('sends one Page Viewed with the values read when the instance was created', () => {
    const page = open(`${ORIGIN}/products/12345?utm_source=news&utm_medium=&gclid=abc#top`);
    page.test.clock.advanceBy(300);
    // A router that replaces the URL before the instance starts moves neither the time nor the URL.
    history.replaceState(null, '', '/login');

    page.run();

    const [view] = page.views();
    expect(page.views()).toHaveLength(1);
    expect(view).toMatchObject({ type: 'track', name: 'Page Viewed', source: 'auto', timestamp: NOW });
    expect(urlOf(view)).toBe(`${ORIGIN}/products/:id`);
    // Empty values and click ids are left out (Web Lifecycle 5).
    expect(propertiesOf(view)).toEqual({ utm_source: 'news' });
    expect(view?.context.session).toBeDefined();
  });

  it('comes before the first call of the page, which shares its session', () => {
    const page = open(`${ORIGIN}/`);

    page.analytics.track('Clicked');
    page.run();

    expect(page.events.map((event) => (event.type === 'identify' ? 'identify' : event.name))).toEqual([
      'Session Started',
      'Page Viewed',
      'Clicked',
    ]);
    expect(page.events[2]?.context.session?.id).toBe(page.events[1]?.context.session?.id);
  });

  it('a page loaded hidden sends it when first visible, with the time and URL of that moment', () => {
    const test = new TestPlatform({ visible: false });
    const page = open(`${ORIGIN}/background?utm_campaign=spring`, {}, test);
    page.run();
    expect(page.views()).toEqual([]);

    test.clock.advanceBy(5_000);
    history.pushState(null, '', '/shown?utm_campaign=summer');
    test.lifecycle.show();
    page.run();

    const [view] = page.views();
    expect(page.views()).toHaveLength(1);
    expect(view?.timestamp).toBe(NOW + 5_000);
    expect(urlOf(view)).toBe(`${ORIGIN}/shown`);
    expect(propertiesOf(view)).toEqual({ utm_campaign: 'summer' });
    // Becoming visible again later is not a page view.
    test.lifecycle.hide();
    test.lifecycle.show();
    page.run();
    expect(page.views()).toHaveLength(1);
  });

  it('a page never shown sends none', () => {
    const test = new TestPlatform({ visible: false });
    const page = open(`${ORIGIN}/prerendered`, {}, test);

    history.pushState(null, '', '/elsewhere');
    test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS * 2);
    test.lifecycle.pagehide();
    page.run();

    expect(page.views()).toEqual([]);
  });
});

describe('single-page navigations (Web Lifecycle 2)', () => {
  /** A visible page whose load view is sent, at `/`. */
  function loaded(config: Record<string, unknown> = {}): Page {
    const page = open(`${ORIGIN}/`, config);
    page.run();
    expect(page.views()).toHaveLength(1);
    return page;
  }

  function viewedUrls(page: Page): unknown[] {
    return page.views().map(urlOf);
  }

  it('a redirect inside the window gives one view, of the final URL, made when the window closes', () => {
    const page = loaded();

    history.pushState(null, '', '/orders');
    page.test.scheduler.advanceBy(100);
    history.replaceState(null, '', '/login');
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS - 101);
    page.run();
    expect(page.views()).toHaveLength(1);
    page.test.scheduler.advanceBy(1);
    page.run();

    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/login`]);
    expect(page.views()[1]?.timestamp).toBe(NOW + PAGE_VIEW_WINDOW_MS);
  });

  it('two pushes give two views, the first with its own URL', () => {
    const page = loaded();

    history.pushState(null, '', '/a?utm_source=ad');
    page.test.scheduler.advanceBy(100);
    history.pushState(null, '', '/b');
    page.run();
    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`]);
    expect(propertiesOf(page.views()[1])).toEqual({ utm_source: 'ad' });
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();

    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`, `${ORIGIN}/b`]);
    expect(propertiesOf(page.views()[2])).toEqual({});
  });

  it('a replaceState outside the window that changes the path gives its own view', () => {
    const page = loaded();

    history.replaceState(null, '', '/replaced');
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();

    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/replaced`]);
  });

  it('a popstate to another path gives one view', () => {
    const page = loaded();

    goTo(`${ORIGIN}/back`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();

    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/back`]);
  });

  it('a change of query or fragment is no navigation, and hash routes are not tracked', () => {
    const page = loaded();

    history.pushState(null, '', '/?page=2');
    history.replaceState(null, '', '/?page=2#reviews');
    history.pushState(null, '', '/#/orders');
    window.dispatchEvent(new PopStateEvent('popstate'));
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS * 2);
    page.run();

    expect(page.views()).toHaveLength(1);
  });

  it('a change of query alone keeps the pending view on its own URL and campaign', () => {
    const page = loaded();

    history.pushState(null, '', '/landing?utm_source=mail&utm_content=hero');
    // The application strips the campaign right away (Web Lifecycle 5).
    history.replaceState(null, '', '/landing');
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();

    expect(propertiesOf(page.views()[1])).toEqual({ utm_source: 'mail', utm_content: 'hero' });
  });

  it('hiding the page or pagehide sends the pending view at once', () => {
    const page = loaded();

    history.pushState(null, '', '/hidden');
    page.test.lifecycle.hide();
    history.pushState(null, '', '/closing');
    page.test.lifecycle.pagehide();
    page.run();

    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/hidden`, `${ORIGIN}/closing`]);
    expect(page.sink.messages.filter((message) => message.startsWith('PAGE_CLOSED'))).toEqual([]);
  });

  it('a restore from the back/forward cache is one view; becoming visible is none', () => {
    const page = loaded();

    page.test.lifecycle.pagehide();
    page.test.lifecycle.hide();
    page.test.lifecycle.pageshowPersisted();
    page.test.lifecycle.hide();
    page.test.lifecycle.show();
    page.run();

    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
  });

  it('a window whose timer came late is closed by the clock at the next navigation (timers are hints)', () => {
    const page = loaded();

    history.pushState(null, '', '/first');
    page.test.clock.advanceBy(PAGE_VIEW_WINDOW_MS + 100);
    history.replaceState(null, '', '/second');
    page.run();

    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/first`]);
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();
    expect(viewedUrls(page)).toEqual([`${ORIGIN}/`, `${ORIGIN}/first`, `${ORIGIN}/second`]);
  });

  it('the campaign is never carried to later events (Web Lifecycle 5)', () => {
    const page = open(`${ORIGIN}/?utm_source=news&utm_term=shoes`);

    page.analytics.track('Searched', { query: 'boots' });
    history.pushState(null, '', '/next');
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();

    expect(page.events.map(propertiesOf)).toEqual([
      {},
      { utm_source: 'news', utm_term: 'shoes' },
      { query: 'boots' },
      {},
    ]);
  });

  it('nothing is sent while opted out, and a shut down instance hears no navigation', () => {
    const page = loaded();

    page.analytics.optOut();
    history.pushState(null, '', '/private');
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.analytics.optIn();
    shutdown(page.analytics);
    history.pushState(null, '', '/after');
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();

    expect(page.views()).toHaveLength(1);
  });
});

describe('page_views off (Web Lifecycle 8)', () => {
  it('in the configuration: nothing is read, wrapped or listened to', () => {
    const pushState = method('pushState');
    const page = open(`${ORIGIN}/`, { autocapture: { enabled: ['sessions'] } });
    page.analytics.track('First');
    page.run();

    history.pushState(null, '', '/next');
    page.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    page.run();

    expect(method('pushState')).toBe(pushState);
    expect(Object.getOwnPropertySymbols(window)).not.toContain(Symbol.for('rubicon.history'));
    expect(page.views()).toEqual([]);
    expect(page.test.lifecycle.listenerCount).toBeGreaterThan(0);
  });

  it('switched off remotely by an earlier page load: nothing is wrapped at this load', () => {
    const test = new TestPlatform();
    test.storage.area.entries.set(
      storeKey(keyHash(API_KEY), 'remote'),
      JSON.stringify({ v: 1, values: { autocapture_off: ['page_views'] }, fetched_at: test.clock.now() }),
    );
    const replaceState = method('replaceState');
    const page = open(`${ORIGIN}/`, {}, test);

    page.run();

    expect(method('replaceState')).toBe(replaceState);
    expect(page.views()).toEqual([]);
  });

  it('with createAnalytics, history is left untouched', () => {
    const pushState = method('pushState');
    const replaceState = method('replaceState');
    const analytics = createAnalytics({
      apiKey: API_KEY,
      host: 'https://api.example.com',
      autocapture: { enabled: ['sessions', 'network_requests'] },
    });

    analytics.track('Started');

    expect(method('pushState')).toBe(pushState);
    expect(method('replaceState')).toBe(replaceState);
    expect(Reflect.has(window, Symbol.for('rubicon.history'))).toBe(false);
  });
});

describe('the history registry (Web Lifecycle 2)', () => {
  it('createAnalytics wraps pushState and replaceState when the instance starts', () => {
    const pushState = method('pushState');
    const analytics = createAnalytics({ apiKey: API_KEY, host: 'https://api.example.com' });
    expect(method('pushState')).toBe(pushState);

    analytics.track('Started');

    expect(method('pushState')).not.toBe(pushState);
    expect(Reflect.has(window, Symbol.for('rubicon.history'))).toBe(true);
    resetForTests();
    expect(method('pushState')).toBe(pushState);
    expect(Reflect.has(window, Symbol.for('rubicon.history'))).toBe(false);
  });

  it('two copies of the SDK wrap once and share one registry', async () => {
    const first = historyRegistry();
    const wrapped = method('pushState');
    vi.resetModules();
    const copy = await import('../../src/autocapture/history-registry');
    const calls: string[] = [];

    const second = copy.historyRegistry();
    if (second !== undefined) second.current = (method) => calls.push(method);
    history.pushState(null, '', '/one');

    expect(second).toBe(first);
    expect(method('pushState')).toBe(wrapped);
    expect(calls).toEqual(['pushState']);
  });

  it('a second instance on the page wraps nothing more and alone hears the navigations', () => {
    const first = open(`${ORIGIN}/`);
    first.run();
    const wrapped = method('pushState');
    shutdown(first.analytics);
    const second = open(`${ORIGIN}/`);
    second.run();

    history.pushState(null, '', '/next');
    second.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    first.test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    second.run();
    first.run();

    expect(method('pushState')).toBe(wrapped);
    expect(first.views().map(urlOf)).toEqual([`${ORIGIN}/`]);
    expect(second.views().map(urlOf)).toEqual([`${ORIGIN}/`, `${ORIGIN}/next`]);
  });

  it('the wrapper calls the original first and lets its error reach the caller', () => {
    const registry = historyRegistry();
    const seen: string[] = [];
    if (registry !== undefined) {
      registry.current = (method) => {
        seen.push(`${method} ${location.pathname}`);
      };
    }

    history.replaceState({ step: 1 }, '', '/replaced');
    expect(history.state).toEqual({ step: 1 });
    expect(seen).toEqual(['replaceState /replaced']);
    expect(() => {
      history.pushState(null, '', 'https://other.example.org/');
    }).toThrow(DOMException);
    expect(seen).toEqual(['replaceState /replaced']);
  });

  it('a listener that throws never reaches the page', () => {
    const registry = historyRegistry();
    if (registry !== undefined) {
      registry.current = () => {
        throw new Error('listener');
      };
    }

    expect(() => {
      history.pushState(null, '', '/safe');
    }).not.toThrow();
    expect(location.pathname).toBe('/safe');
  });

  it('a value under the key that is not a registry is left alone and nothing is wrapped', () => {
    const pushState = method('pushState');
    Reflect.defineProperty(window, Symbol.for('rubicon.history'), { value: 'taken', configurable: true });
    try {
      expect(historyRegistry()).toBeUndefined();
      expect(method('pushState')).toBe(pushState);
    } finally {
      Reflect.deleteProperty(window, Symbol.for('rubicon.history'));
    }
  });
});

describe('never crashes the host', () => {
  it('a context that cannot be read costs the views only; navigations still work', () => {
    const test = new TestPlatform();
    goTo(`${ORIGIN}/`);
    const sink = new RecordingSink();
    const platform: Platform = {
      ...test.platform,
      context: {
        staticValues: () => ({}),
        callTimeValues: () => {
          throw new Error('context');
        },
      },
    };
    const analytics = createCore({ apiKey: API_KEY }, platform, {
      sink,
      onCreated: (capture) => {
        attachPageViews(capture, platform);
      },
    });
    pages.push(analytics);
    test.scheduler.runUntilIdle();

    expect(() => {
      history.pushState(null, '', '/next');
      test.scheduler.advanceBy(PAGE_VIEW_WINDOW_MS);
    }).not.toThrow();
    expect(location.pathname).toBe('/next');
    expect(sink.messages).toContainEqual(expect.stringMatching(/^WORKER_FAILED: /));
  });
});

describe('the campaign parameters (Web Lifecycle 5)', () => {
  it('only the five utm_* with a value, the first of a repeated name, decoded', () => {
    expect(
      campaignOf(
        '?utm_source=a%20b&utm_source=second&utm_medium=cpc&utm_campaign=&utm_term=x+y&utm_content=c' +
          '&utm_id=1&gclid=2&fbclid=3',
      ),
    ).toEqual({ utm_source: 'a b', utm_medium: 'cpc', utm_term: 'x y', utm_content: 'c' });
    expect(campaignOf('')).toEqual({});
  });
});
