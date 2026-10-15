import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { CONTEXT_FIELDS, eventToWire, EventPipeline, Log, UuidV7Generator } from 'rubicon-analytics-core';
import type { CallTimeContextRequest, ContextField, ContextProvider, Event } from 'rubicon-analytics-core';
import { RecordingSink, SeededRandom, TestClock } from 'rubicon-analytics-testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanUrl, createBrowserContext, originAndPath } from '../../src/platform/browser-context';
import { resetForTests } from '../../src/testing';
import type * as Sdk from '../../src';

// The browser's context provider of step 7.5 (Web Context 1 to 5) in jsdom: what is read and when
// (nothing at import or in the factory, static values at the first event, page values in every call,
// a disabled field never), each value's source and rule, the tablet rules with a stubbed `navigator`,
// and the web fixture of Web Context 5 through the core pipeline. jsdom's page is replaced per test
// (`jsdom.reconfigure`, stubbed properties) and restored after it; the values in the three engines
// are test/browser/context.spec.ts.

interface Reconfigurable {
  reconfigure(options: { url: string }): void;
}

const restores: (() => void)[] = [];
const jsdomUrl = location.href;

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  resetForTests();
  (Reflect.get(globalThis, 'jsdom') as Reconfigurable).reconfigure({ url: jsdomUrl });
  history.replaceState(null, '', jsdomUrl);
});

/** Replaces `name` on `target` with `descriptor` until the end of the test. */
function replace(target: object, name: PropertyKey, descriptor: PropertyDescriptor): void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  restores.push(() => {
    if (own) Object.defineProperty(target, name, own);
    else Reflect.deleteProperty(target, name);
  });
}

function goTo(url: string): void {
  (Reflect.get(globalThis, 'jsdom') as Reconfigurable).reconfigure({ url });
}

/** What a page stub gives; a function throws when read. */
interface PageValues {
  userAgent?: unknown;
  userAgentData?: unknown;
  maxTouchPoints?: unknown;
  language?: unknown;
  screenWidth?: unknown;
  screenHeight?: unknown;
  devicePixelRatio?: unknown;
  innerWidth?: unknown;
  innerHeight?: unknown;
  referrer?: unknown;
  title?: unknown;
}

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const PAGE: Required<PageValues> = {
  userAgent: CHROME_WINDOWS,
  userAgentData: undefined,
  maxTouchPoints: 0,
  language: 'tr-TR',
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 1.25,
  innerWidth: 1280,
  innerHeight: 720,
  referrer: 'https://www.example.com/',
  title: 'Checkout',
};

/**
 * Stubs every browser value the provider reads with a getter that counts its reads (the property's
 * name to the count). `location` is jsdom's, moved with {@link goTo} and `history`; `Intl` is the
 * engine's unless replaced.
 */
function stubPage(values: PageValues = {}): Map<string, number> {
  const page = { ...PAGE, ...values };
  const reads = new Map<string, number>();
  const counted = (target: object, name: keyof PageValues, property: string = name) => {
    replace(target, property, {
      get: () => {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        const value = page[name];
        if (typeof value === 'function') throw new Error('unreadable');
        return value;
      },
    });
  };
  counted(navigator, 'userAgent');
  counted(navigator, 'userAgentData');
  counted(navigator, 'maxTouchPoints');
  counted(navigator, 'language');
  counted(screen, 'screenWidth', 'width');
  counted(screen, 'screenHeight', 'height');
  counted(window, 'devicePixelRatio');
  counted(window, 'innerWidth');
  counted(window, 'innerHeight');
  counted(document, 'referrer');
  counted(document, 'title');
  return reads;
}

function total(reads: Map<string, number>): number {
  let sum = 0;
  for (const count of reads.values()) sum += count;
  return sum;
}

function request(overrides: Partial<CallTimeContextRequest> = {}): CallTimeContextRequest {
  return { disabled: new Set(), queryParams: [], title: false, ...overrides };
}

describe('when values are read (Web Context 4)', () => {
  /** Imports a fresh copy of the package, counting the reads of `location`. */
  async function freshCopy(): Promise<{ sdk: typeof Sdk; locationReads: () => number }> {
    let locationReads = 0;
    const real = location;
    replace(globalThis, 'location', {
      get: () => {
        locationReads += 1;
        return real;
      },
    });
    vi.resetModules();
    const sdk = await import('../../src');
    // The fresh copy's own reset, so its instance is shut down with the test.
    const testing = await import('../../src/testing');
    restores.push(() => {
      testing.resetForTests();
    });
    return { sdk, locationReads: () => locationReads };
  }

  it('nothing is read at import or while createAnalytics runs', async () => {
    const reads = stubPage();
    const { sdk, locationReads } = await freshCopy();
    expect(total(reads)).toBe(0);
    const before = locationReads();

    sdk.createAnalytics({
      apiKey: 'rk_context',
      host: 'https://api.example.com',
      autocapture: { enabled: ['sessions', 'network_requests'] },
    });

    expect(total(reads)).toBe(0);
    // The platform reads `location.protocol` and `location.hostname` once (steps 3.1 and 7.2), the
    // context provider nothing.
    expect(locationReads() - before).toBe(2);
  });

  it('with page views on, createAnalytics reads the page values of the load, never a static value', async () => {
    const reads = stubPage();
    const { sdk, locationReads } = await freshCopy();
    const before = locationReads();

    sdk.createAnalytics({ apiKey: 'rk_context', host: 'https://api.example.com' });

    // The load's Page Viewed takes the values of this moment (Web Lifecycle 2, step 7.6): the
    // viewport and the locale of the call, and the URL's origin, path and query once each.
    expect(Object.fromEntries(reads)).toEqual({ innerWidth: 1, innerHeight: 1, language: 1 });
    expect(locationReads() - before).toBe(2 + 3);
  });

  it('static values are read by staticValues only, page values at every call', () => {
    const reads = stubPage();
    const provider = createBrowserContext();
    expect(total(reads)).toBe(0);

    provider.staticValues(new Set());
    const afterStatic = new Map(reads);
    expect(afterStatic.get('userAgent')).toBe(1);
    expect(afterStatic.get('referrer')).toBe(1);
    expect(afterStatic.get('innerWidth')).toBeUndefined();

    provider.callTimeValues(request());
    provider.callTimeValues(request());
    expect(reads.get('innerWidth')).toBe(2);
    expect(reads.get('language')).toBe(2);
    expect(reads.get('userAgent')).toBe(1);
    expect(reads.get('referrer')).toBe(1);
  });

  it('page values follow pushState, the referrer does not', () => {
    stubPage({ referrer: 'https://www.example.com/landing' });
    goTo('https://shop.example.com/');
    const provider = createBrowserContext();
    const ask = request({ queryParams: ['page'] });

    const first = provider.callTimeValues(ask);
    history.pushState(null, '', '/orders/12345?page=3#reviews');
    const second = provider.callTimeValues(ask);

    expect(first.pageUrl).toBe('https://shop.example.com/');
    expect(first.pageQuery).toBeUndefined();
    expect(second.pageUrl).toBe('https://shop.example.com/orders/:id');
    expect(second.pageQuery).toEqual({ page: '3' });
    expect(provider.staticValues(new Set()).pageReferrer).toBe('https://www.example.com/landing');
  });
});

describe('a disabled field is never read (Context 6, Web Context 5)', () => {
  it('with every field disabled and the title off, nothing is read and nothing given', () => {
    const reads = stubPage();
    let intlReads = 0;
    const realIntl = Intl;
    replace(globalThis, 'Intl', {
      get: () => {
        intlReads += 1;
        return realIntl;
      },
    });
    const provider = createBrowserContext();
    const disabled = new Set<ContextField>(CONTEXT_FIELDS);

    const values = {
      ...provider.staticValues(disabled),
      ...provider.callTimeValues(request({ disabled, queryParams: ['page'] })),
    };

    expect(total(reads)).toBe(0);
    expect(intlReads).toBe(0);
    expect(JSON.parse(JSON.stringify(values))).toEqual({});
  });

  it('a field reads only what it needs', () => {
    const reads = stubPage();
    const provider = createBrowserContext();
    const all = new Set<ContextField>(CONTEXT_FIELDS);
    const only = (field: ContextField) => new Set([...all].filter((other) => other !== field));

    expect(provider.staticValues(only('os.name'))).toMatchObject({ osName: 'Windows' });
    expect([...reads.keys()]).toEqual(['userAgent', 'userAgentData']);

    reads.clear();
    expect(provider.staticValues(only('screen.density'))).toMatchObject({ screenDensity: 1.25 });
    expect([...reads.keys()]).toEqual(['devicePixelRatio']);

    reads.clear();
    expect(provider.callTimeValues(request({ disabled: only('page.viewport_width') }))).toMatchObject({
      viewportWidth: 1280,
    });
    expect([...reads.keys()]).toEqual(['innerWidth']);
  });

  it('page.title is read only when switched on', () => {
    const reads = stubPage();
    const provider = createBrowserContext();

    expect(provider.callTimeValues(request()).pageTitle).toBeUndefined();
    expect(reads.get('title')).toBeUndefined();
    expect(provider.callTimeValues(request({ title: true })).pageTitle).toBe('Checkout');
  });
});

describe('the values (Web Context 1 to 3)', () => {
  it('page.url is the origin and the path with ids masked, never the query or the fragment', () => {
    stubPage();
    goTo('https://shop.example.com/orders/3f2a9c1e-0b1c-4d2e-8f3a-7b2d9c1e0b1c/items/12345?token=abc#top');

    expect(createBrowserContext().callTimeValues(request()).pageUrl).toBe(
      'https://shop.example.com/orders/:id/items/:id',
    );
  });

  it('page.referrer follows the same rule, and is absent when empty or not a URL', () => {
    stubPage({ referrer: 'https://www.example.com:8443/users/42/?q=secret#f' });
    expect(createBrowserContext().staticValues(new Set()).pageReferrer).toBe('https://www.example.com:8443/users/:id/');

    stubPage({ referrer: '' });
    expect(createBrowserContext().staticValues(new Set()).pageReferrer).toBeUndefined();
    stubPage({ referrer: 'not a url' });
    expect(createBrowserContext().staticValues(new Set()).pageReferrer).toBeUndefined();
  });

  it('an opaque origin gives no URL', () => {
    expect(originAndPath('null', '/blank')).toBeUndefined();
    expect(originAndPath('', '/')).toBeUndefined();
    expect(cleanUrl('about:blank')).toBeUndefined();
    expect(cleanUrl('android-app://com.example.app/')).toBeUndefined();
    expect(cleanUrl('http://localhost:3000/a/0123456789abcdef0')).toBe('http://localhost:3000/a/:id');
  });

  it('screen is in CSS pixels, the short side first, with devicePixelRatio as density', () => {
    stubPage({ screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 2.625 });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({
      screenWidth: 1080,
      screenHeight: 1920,
      screenDensity: 2.625,
    });

    stubPage({ screenWidth: 390, screenHeight: 844 });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({ screenWidth: 390, screenHeight: 844 });
  });

  it('a screen or density the browser does not give is absent', () => {
    stubPage({ screenWidth: 0, screenHeight: 0, devicePixelRatio: Number.NaN });
    const values = createBrowserContext().staticValues(new Set());
    expect(values.screenWidth).toBeUndefined();
    expect(values.screenHeight).toBeUndefined();
    expect(values.screenDensity).toBeUndefined();
  });

  it('the viewport is innerWidth and innerHeight', () => {
    stubPage({ innerWidth: 412, innerHeight: 915 });
    expect(createBrowserContext().callTimeValues(request())).toMatchObject({ viewportWidth: 412, viewportHeight: 915 });
  });

  it("a viewport the snippet recorded replaces the page's, which is then not read; a disabled one is absent", () => {
    const reads = stubPage({ innerWidth: 412, innerHeight: 915 });
    const provider = createBrowserContext();
    const viewport = { width: 1280, height: 720 };

    expect(provider.callTimeValues(request({ viewport }))).toMatchObject({ viewportWidth: 1280, viewportHeight: 720 });
    expect(reads.get('innerWidth')).toBeUndefined();
    const disabled = new Set<ContextField>(['page.viewport_width', 'page.viewport_height']);
    const values = provider.callTimeValues(request({ viewport, disabled }));
    expect(values.viewportWidth).toBeUndefined();
    expect(values.viewportHeight).toBeUndefined();
  });

  it('page.query holds only the named parameters', () => {
    stubPage();
    goTo('https://shop.example.com/search?page=2&sort=price&token=abc');
    const provider = createBrowserContext();

    expect(provider.callTimeValues(request({ queryParams: ['page', 'sort'] })).pageQuery).toEqual({
      page: '2',
      sort: 'price',
    });
    expect(provider.callTimeValues(request({ queryParams: ['missing'] })).pageQuery).toBeUndefined();
    expect(provider.callTimeValues(request()).pageQuery).toBeUndefined();
  });

  it('page.title: an empty title is absent, a lone surrogate becomes U+FFFD', () => {
    stubPage({ title: '' });
    expect(createBrowserContext().callTimeValues(request({ title: true })).pageTitle).toBeUndefined();
    stubPage({ title: 'Cart \ud800' });
    expect(createBrowserContext().callTimeValues(request({ title: true })).pageTitle).toBe('Cart �');
  });

  it('locale is navigator.language, absent when empty', () => {
    stubPage({ language: 'tr-TR' });
    expect(createBrowserContext().callTimeValues(request()).locale).toBe('tr-TR');
    stubPage({ language: '' });
    expect(createBrowserContext().callTimeValues(request()).locale).toBeUndefined();
  });

  it('timezone is the zone of Intl, absent without Intl or with an empty zone', () => {
    stubPage();
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(createBrowserContext().callTimeValues(request()).timezone).toBe(zone);

    replace(globalThis, 'Intl', { value: undefined, writable: true });
    expect(createBrowserContext().callTimeValues(request()).timezone).toBeUndefined();

    replace(globalThis, 'Intl', {
      value: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: '' }) }) },
      writable: true,
    });
    expect(createBrowserContext().callTimeValues(request()).timezone).toBeUndefined();
  });

  it('the user agent gives os.name, browser.name, the major browser.version and device.type', () => {
    stubPage();
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({
      osName: 'Windows',
      browserName: 'Chrome',
      browserVersion: '141',
      deviceType: 'desktop',
    });
  });

  it('Client Hints are preferred, and read only through their known fields', () => {
    stubPage({
      userAgentData: {
        brands: [
          { brand: 'Chromium', version: '141' },
          { brand: 'Microsoft Edge', version: '141' },
          'junk',
          null,
          { brand: 7 },
        ],
        mobile: 'no',
        platform: 'Windows',
      },
    });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({
      browserName: 'Edge',
      browserVersion: '141',
      osName: 'Windows',
    });

    stubPage({ userAgentData: { brands: 'not a list' } });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({ browserName: 'Chrome', osName: 'Windows' });
  });

  it('a read that throws leaves only its own fields out', () => {
    stubPage({
      userAgent: () => undefined,
      innerWidth: () => undefined,
      referrer: () => undefined,
    });
    const provider = createBrowserContext();
    const values = { ...provider.staticValues(new Set()), ...provider.callTimeValues(request()) };

    expect(values.osName).toBeUndefined();
    expect(values.browserName).toBeUndefined();
    expect(values.deviceType).toBeUndefined();
    expect(values.pageReferrer).toBeUndefined();
    expect(values.viewportWidth).toBeUndefined();
    expect(values).toMatchObject({ screenWidth: 1080, viewportHeight: 720, locale: 'tr-TR' });
  });
});

describe('the tablet rules with a stubbed navigator (Web Context 1)', () => {
  const ANDROID_DESKTOP_MODE =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const SAFARI_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  const androidHints = { brands: [{ brand: 'Google Chrome', version: '141' }], mobile: false, platform: 'Android' };

  it('an Android tablet asking for the desktop site is a tablet', () => {
    stubPage({
      userAgent: ANDROID_DESKTOP_MODE,
      userAgentData: androidHints,
      maxTouchPoints: 10,
      screenWidth: 1280,
      screenHeight: 800,
    });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({ osName: 'Android', deviceType: 'tablet' });
  });

  it('an Android phone asking for the desktop site is a phone', () => {
    stubPage({
      userAgent: ANDROID_DESKTOP_MODE,
      userAgentData: androidHints,
      maxTouchPoints: 5,
      screenWidth: 412,
      screenHeight: 915,
    });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({ osName: 'Android', deviceType: 'phone' });
  });

  it('an iPad in desktop mode is a tablet running iOS; a Mac is a desktop', () => {
    stubPage({ userAgent: SAFARI_MAC, maxTouchPoints: 5 });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({
      osName: 'iOS',
      deviceType: 'tablet',
      browserName: 'Safari',
    });

    stubPage({ userAgent: SAFARI_MAC, maxTouchPoints: 0 });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({ osName: 'macOS', deviceType: 'desktop' });

    stubPage({ userAgent: SAFARI_MAC, maxTouchPoints: undefined });
    expect(createBrowserContext().staticValues(new Set())).toMatchObject({ osName: 'macOS', deviceType: 'desktop' });
  });
});

describe('the web fixture of Web Context 5', () => {
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new NodeUrl('../../../core/test/fixtures/web/context.json', import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;

  function pipelineOver(context: ContextProvider): EventPipeline {
    return new EventPipeline({
      config: {
        beforeSend: [],
        disabledFields: new Set(),
        app: {},
        pageQueryParams: ['page', 'sort'],
        pageTitle: false,
      },
      context,
      sessions: { onEvent: () => ({ session: undefined, before: [] }) },
      ids: new UuidV7Generator(new TestClock(1_759_147_200_123), new SeededRandom(5)),
      log: new Log({ level: 'debug', debug: false, sink: new RecordingSink() }),
    });
  }

  function trackOn(pipeline: EventPipeline): Event {
    const prepared = pipeline.capture({
      type: 'track',
      name: 'Purchase Completed',
      properties: {},
      source: 'app',
      messageId: 'm-1',
      timestamp: 1_759_147_200_123,
      visible: true,
      identity: { deviceId: 'd', userId: null, personEpoch: '0123456789abcdef', superProperties: {} },
      callTime: pipeline.callTimeValues(),
    });
    const last = prepared[prepared.length - 1];
    if (last === undefined) throw new Error('no event');
    return last.event;
  }

  it('the page of the example of Web Context 2, read by the browser provider, gives the fixture', () => {
    stubPage({ userAgent: CHROME_WINDOWS, referrer: 'https://www.example.com/', innerWidth: 1280, innerHeight: 720 });
    goTo('https://shop.example.com/orders/8f1c0b1c-2d3e-4f5a-8b6c-7d8e9f0a1b2c/items?page=2&sort=price&token=abc#top');

    const wire = eventToWire(trackOn(pipelineOver(createBrowserContext())));
    const context = wire.context as Record<string, unknown>;

    expect({ browser: context.browser, page: context.page }).toEqual(fixture);
    expect(JSON.stringify(wire)).not.toContain('token');
    expect(JSON.stringify(wire)).not.toContain('#top');
  });
});
