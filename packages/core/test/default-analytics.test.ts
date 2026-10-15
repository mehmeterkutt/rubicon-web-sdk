import { RecordingLogger, RecordingSink, responseOutcome, TestClock, TestPlatform } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import type { Analytics, AutomaticCapture, CreateCoreOptions, HttpRequest, Platform } from '../src';
import { coreOf, createCore, flushAndWait, keyHash, shutdown, storeKey } from '../src';

// `DefaultAnalytics` and the core factory (step 6.7), the port of the Android `DefaultAnalytics` and
// `RubiconCore` tests that run without a server, over the virtual-time `TestPlatform`. The tests
// through a real socket are in `integration/core-integration.test.ts`.

const API_KEY = 'test-api-key';
const KEY_HASH = keyHash(API_KEY);
const REMOTE_KEY = storeKey(KEY_HASH, 'remote');
const NOW = TestClock.DEFAULT_START;
const MINUTE = 60_000;

interface Page {
  readonly test: TestPlatform;
  readonly analytics: Analytics;
  readonly sink: RecordingSink;
  /** Every request the page made. */
  readonly requests: () => readonly HttpRequest[];
  /** The events of every upload, in order. */
  readonly sent: () => WireEvent[];
  /** Runs every slice and timer due now. */
  readonly run: () => void;
}

interface WireEvent {
  readonly type: string;
  readonly event?: string;
  readonly name?: string;
  readonly source: string;
  readonly device_id: string;
  readonly user_id: string | null;
  readonly properties?: Record<string, unknown>;
  readonly traits?: Record<string, unknown>;
}

/** Saves remote values fetched just now, so the page makes no configuration request of its own. */
function saveRemote(test: TestPlatform, values: Record<string, unknown> = {}, fetchedAt = test.clock.now()): void {
  test.storage.area.entries.set(REMOTE_KEY, JSON.stringify({ v: 1, values, fetched_at: fetchedAt }));
}

function open(
  config: Record<string, unknown> = {},
  options: CreateCoreOptions & { readonly test?: TestPlatform; readonly platform?: Platform } = {},
): Page {
  const test = options.test ?? new TestPlatform();
  const sink = new RecordingSink();
  const analytics = createCore(
    // No `SDK Diagnostics` unless a test asks: the issues a test provokes would add one at a flush.
    { apiKey: API_KEY, flush: { at: 100, intervalMs: 60_000 }, logging: { sendDiagnostics: false }, ...config },
    options.platform ?? test.platform,
    { sink, ...options },
  );
  const requests = (): readonly HttpRequest[] => test.transport.requests;
  return {
    test,
    analytics,
    sink,
    requests,
    sent: () =>
      requests()
        .filter((request) => request.method === 'POST')
        .flatMap((request) => (JSON.parse(request.body ?? '{}') as { batch: WireEvent[] }).batch),
    run: () => {
      test.scheduler.runUntilIdle();
    },
  };
}

/** A page whose remote configuration was fetched just now. */
function openFresh(config: Record<string, unknown> = {}, options: CreateCoreOptions = {}): Page {
  const test = new TestPlatform();
  saveRemote(test);
  return open(config, { ...options, test });
}

function names(events: readonly WireEvent[]): string[] {
  return events.map((event) => event.event ?? event.name ?? event.type);
}

function sendAll(page: Page): void {
  page.analytics.flush();
  page.run();
}

/** The `Analytics` members as plain properties, so a method can be read off it like a host does. */
type Members = { readonly [K in keyof Analytics]: Analytics[K] };

describe('the core factory', () => {
  it('reads no storage and no cookie while it creates the instance', () => {
    const test = new TestPlatform();
    const touched: string[] = [];
    const platform: Platform = {
      ...test.platform,
      storage: new Proxy(test.storage, {
        get(target, property, receiver) {
          touched.push(`storage.${String(property)}`);
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
      cookies: new Proxy(test.cookies, {
        get(target, property, receiver) {
          touched.push(`cookies.${String(property)}`);
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    };

    open({}, { test, platform });

    expect(touched).toEqual([]);
    expect(test.transport.requests).toEqual([]);
  });

  it('starts at the first task the scheduler runs when the page makes no call', () => {
    const page = open();

    page.run();

    expect(page.requests().map((request) => request.url)).toEqual(['https://api.rubicon.example/v1/config']);
    expect(page.test.cookies.store.cookies().map((cookie) => cookie.name)).toEqual([`rubicon_${KEY_HASH}`]);
  });

  it('starts at the first call when it comes before that task, and only once', () => {
    const page = open();

    expect(page.analytics.isOptedOut).toBe(false);
    page.analytics.track('First');
    page.run();

    expect(page.requests().filter((request) => request.method === 'GET')).toHaveLength(1);
    page.analytics.flush();
    page.run();
    expect(names(page.sent())).toEqual(['Session Started', 'First']);
  });

  it('an unusable configuration gives the no-op instance with its ERROR, and nothing throws in debug', () => {
    for (const debug of [false, true]) {
      const logger = new RecordingLogger();
      const test = new TestPlatform();
      let created = 0;

      const analytics = createCore({ apiKey: ' ', debug, logging: { logger: logger.logger } }, test.platform, {
        onCreated: () => {
          created += 1;
        },
      });

      expect(analytics.isOptedOut).toBe(true);
      expect(analytics.deviceId).toBe('');
      expect(coreOf(analytics)).toBeUndefined();
      expect(created).toBe(0);
      expect(logger.lines.filter((line) => line.level === 'error').map((line) => line.message)).toEqual([
        expect.stringMatching(/^INVALID_API_KEY: /) as unknown,
      ]);
      test.scheduler.runUntilIdle();
      expect(test.transport.requests).toEqual([]);
    }
  });

  it('logs the configuration issues and the host through the developer logger before anything else', () => {
    const logger = new RecordingLogger();
    const test = new TestPlatform();

    createCore(
      { apiKey: API_KEY, flush: { at: 1000 }, logging: { level: 'info', logger: logger.logger } },
      test.platform,
    );

    expect(logger.messages).toEqual([
      expect.stringMatching(/^SETTING_OUT_OF_BOUNDS: /) as unknown,
      'Sending to https://api.rubicon.example',
    ]);
  });

  it('a failure while building gives the no-op instance with WORKER_FAILED and never throws', () => {
    const logger = new RecordingLogger();
    const test = new TestPlatform();
    const platform: Platform = {
      ...test.platform,
      scheduler: {
        after: () => {
          throw new Error('broken scheduler');
        },
        yield: () => {
          throw new Error('broken scheduler');
        },
      },
    };

    const analytics = createCore({ apiKey: API_KEY, debug: true, logging: { logger: logger.logger } }, platform);

    expect(analytics.isOptedOut).toBe(true);
    expect(coreOf(analytics)).toBeUndefined();
    expect(logger.messages).toEqual([expect.stringMatching(/^WORKER_FAILED: /) as unknown]);
  });

  it('makes a new instance at every call: one per page is the web factory (step 7.1)', () => {
    const test = new TestPlatform();

    const first = createCore({ apiKey: API_KEY }, test.platform);
    const second = createCore({ apiKey: API_KEY }, test.platform);

    expect(first).not.toBe(second);
    expect(coreOf(first)).toBeDefined();
  });

  it('flushAndWait and shutdown do nothing for an instance the factory did not make', async () => {
    const page = open({ apiKey: '' });

    shutdown(page.analytics);
    await expect(flushAndWait(page.analytics, 10)).resolves.toBe(false);
  });
});

describe('the public object (Web Public API 3)', () => {
  it('has the members of Analytics as own properties that work when taken off the object', () => {
    const page = openFresh();
    const members: Members = page.analytics;
    const { track, flush } = members;

    track('Detached');
    flush();
    page.run();

    expect(Object.keys(page.analytics).sort()).toEqual(
      [
        'clearLocalData',
        'deviceId',
        'flush',
        'identify',
        'isOptedOut',
        'optIn',
        'optOut',
        'register',
        'reset',
        'screen',
        'track',
        'unregister',
      ].sort(),
    );
    expect(names(page.sent())).toEqual(['Session Started', 'Detached']);
  });

  it('reads isOptedOut and deviceId fresh at every access', () => {
    const page = openFresh();
    const first = page.analytics.deviceId;

    page.analytics.optOut();
    expect(page.analytics.isOptedOut).toBe(true);
    page.analytics.optIn();
    page.analytics.clearLocalData();

    expect(page.analytics.isOptedOut).toBe(false);
    expect(page.analytics.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.analytics.deviceId).not.toBe(first);
  });

  it('a spread of the instance keeps working methods, as a fake built from the no-op does', () => {
    const page = openFresh();
    const tracked: string[] = [];
    const wrapped: Analytics = {
      ...page.analytics,
      screen: (name) => {
        tracked.push(name);
      },
    };

    wrapped.track('Spread');
    wrapped.screen('checkout');
    wrapped.flush();
    page.run();

    expect(tracked).toEqual(['checkout']);
    expect(names(page.sent())).toEqual(['Session Started', 'Spread']);
  });
});

describe('the calls', () => {
  it('track, screen and identify reach the server in call order with both ids', () => {
    const page = openFresh();

    page.analytics.identify('user-42', { plan: 'pro' });
    page.analytics.track('Signed Up', { method: 'email' });
    page.analytics.screen('checkout');
    sendAll(page);

    const events = page.sent();
    // The identify event is the first of a visible page: its session starts right before it.
    expect(names(events)).toEqual(['Session Started', 'identify', 'Signed Up', 'checkout']);
    expect(events.every((event) => event.user_id === 'user-42')).toBe(true);
    expect(events.every((event) => event.device_id === page.analytics.deviceId)).toBe(true);
    expect(events[1]?.traits).toEqual({ plan: 'pro' });
    expect(events[2]?.properties).toEqual({ method: 'email' });
    expect(events.map((event) => event.source)).toEqual(['auto', 'app', 'app', 'app']);
  });

  it('register adds super properties to later events and unregister removes them', () => {
    const page = openFresh();

    page.analytics.register('tenant', 'acme');
    page.analytics.track('With');
    page.analytics.unregister('tenant');
    page.analytics.track('Without');
    sendAll(page);

    const events = page.sent().filter((event) => event.source === 'app');
    expect(events.map((event) => event.properties)).toEqual([{ tenant: 'acme' }, {}]);
  });

  it('reset ends the session with the previous user and later events are anonymous', () => {
    const page = openFresh();

    page.analytics.identify('user-1');
    page.analytics.track('Before');
    page.analytics.reset();
    page.analytics.track('After');
    sendAll(page);

    const events = page.sent();
    expect(names(events)).toEqual([
      'Session Started',
      'identify',
      'Before',
      'Session Ended',
      'Session Started',
      'After',
    ]);
    expect(events.map((event) => event.user_id)).toEqual(['user-1', 'user-1', 'user-1', 'user-1', null, null]);
  });

  it('properties are copied during the call and never kept', () => {
    const page = openFresh();
    const properties: Record<string, unknown> = { step: 1 };

    page.analytics.track('Copied', properties);
    properties['step'] = 2;
    sendAll(page);

    expect(page.sent().find((event) => event.event === 'Copied')?.properties).toEqual({ step: 1 });
  });

  describe('an invalid event name (a developer error, Web Public API 4)', () => {
    it('is dropped with INVALID_EVENT_NAME and the next event goes on', () => {
      const page = openFresh();

      page.analytics.track(' ');
      page.analytics.screen('');
      page.analytics.track('Valid');
      sendAll(page);

      expect(names(page.sent())).toEqual(['Session Started', 'Valid']);
      expect(page.sink.lines.filter((line) => line.level === 'warn')).toEqual([
        {
          level: 'warn',
          message: expect.stringMatching(/^INVALID_EVENT_NAME: /) as unknown,
          developerErrorForm: false,
        },
      ]);
    });

    it('with debug the default sink writes it as an Error, and nothing throws', () => {
      const page = openFresh({ debug: true });

      expect(() => {
        page.analytics.track('');
      }).not.toThrow();

      expect(page.sink.lines).toEqual([
        {
          level: 'error',
          message: expect.stringMatching(/^INVALID_EVENT_NAME: /) as unknown,
          developerErrorForm: true,
        },
      ]);
    });

    it('logging.level "off" silences it, with or without debug', () => {
      for (const debug of [false, true]) {
        const page = openFresh({ debug, logging: { level: 'off' } });

        page.analytics.track('');

        expect(page.sink.lines).toEqual([]);
      }
    });
  });

  it('an unsupported property drops that key only, with a developer error under debug', () => {
    const page = openFresh({ debug: true });

    page.analytics.track('Mixed', { ok: 1, bad: () => 1 });
    sendAll(page);

    expect(page.sent().find((event) => event.event === 'Mixed')?.properties).toEqual({ ok: 1 });
    expect(page.sink.lines.map((line) => [line.message.slice(0, 16), line.developerErrorForm])).toEqual([
      ['PROPERTY_DROPPED', true],
    ]);
  });
});

describe('starting the page', () => {
  it('requests the remote configuration at page load when it is due, and not again', () => {
    const test = new TestPlatform();
    saveRemote(test, {}, NOW - 6 * MINUTE);
    const page = open({}, { test });

    page.analytics.track('One');
    page.run();
    page.analytics.track('Two');
    page.run();

    expect(page.requests().filter((request) => request.method === 'GET')).toHaveLength(1);
  });

  it('makes no remote configuration request while consent is pending, and one after optIn', () => {
    const page = open({ privacy: { defaultConsent: 'pending' } });

    page.analytics.track('Waiting');
    page.run();
    expect(page.requests()).toEqual([]);
    expect(page.test.storage.area.entries.size).toBe(0);

    page.analytics.optIn();
    page.run();

    expect(page.requests().filter((request) => request.method === 'GET')).toHaveLength(1);
    expect(names(page.sent())).toEqual(['Session Started', 'Waiting']);
  });

  it('a session that ended while no page was open ends at page load, backdated', () => {
    const test = new TestPlatform();
    saveRemote(test);
    const first = open({}, { test });
    first.analytics.track('Earlier');
    first.run();
    shutdown(first.analytics);
    test.clock.advanceBy(31 * MINUTE);
    saveRemote(test);

    const second = open({}, { test: test.otherPage() });
    second.run();
    second.analytics.flush();
    second.run();

    expect(names(second.sent())).toEqual(['Session Ended']);
  });

  it('a tab becoming visible after the timeout ends the session (Web Session 1)', () => {
    const page = openFresh();
    page.analytics.track('Earlier');
    page.test.lifecycle.hide();
    page.run();
    page.test.clock.advanceBy(31 * MINUTE);

    page.test.lifecycle.show();
    sendAll(page);

    expect(names(page.sent())).toEqual(['Session Started', 'Earlier', 'Session Ended']);
  });

  it('the remote kill switch saved by an earlier page load stops every new event', () => {
    const test = new TestPlatform();
    saveRemote(test, { enabled: false });
    const page = open({}, { test });

    page.analytics.track('Dropped');
    page.analytics.identify('user-1');
    sendAll(page);

    expect(page.sent()).toEqual([]);
  });

  it('a remote switch-off of sessions saved by an earlier page load applies to this page', () => {
    const test = new TestPlatform();
    saveRemote(test, { autocapture_off: ['sessions'] });
    const page = open({}, { test });

    page.analytics.track('Alone');
    sendAll(page);

    expect(names(page.sent())).toEqual(['Alone']);
  });

  describe('the memory-only mode (Web Disk 4)', () => {
    it('a failing start probe keeps everything in memory with one STORAGE_UNAVAILABLE', () => {
      const test = new TestPlatform();
      // No remote configuration answer to report: a 404 means none (step 5.3).
      test.transport.enqueue(responseOutcome(404));
      const page = open({}, { test, storageUsable: () => false });

      page.analytics.track('Memory');
      page.analytics.track('Memory again');
      sendAll(page);

      expect(page.test.storage.area.entries.size).toBe(0);
      expect(page.test.cookies.store.cookies()).toEqual([]);
      expect(page.sink.messages).toEqual([expect.stringMatching(/^STORAGE_UNAVAILABLE: /) as unknown]);
      expect(names(page.sent())).toEqual(['Session Started', 'Memory', 'Memory again']);
    });

    it('a probe that throws counts as storage that cannot be used', () => {
      const test = new TestPlatform();
      test.transport.enqueue(responseOutcome(404));
      const page = open(
        {},
        {
          test,
          storageUsable: () => {
            throw new Error('probe');
          },
        },
      );

      page.analytics.track('Memory');
      page.run();

      expect(page.test.storage.area.entries.size).toBe(0);
      expect(page.sink.messages).toEqual([expect.stringMatching(/^STORAGE_UNAVAILABLE: /) as unknown]);
    });

    it('a probe that passes changes nothing', () => {
      const page = openFresh({}, { storageUsable: () => true });

      page.analytics.track('Stored');
      page.run();

      expect(page.sink.messages).toEqual([]);
      expect(page.test.cookies.store.cookies().length).toBeGreaterThan(0);
    });
  });

  it('with nothing readable the page runs on a temporary id and the upload waits (step 6.4 answer 3)', () => {
    const page = openFresh();
    page.test.cookies.failAccess = true;
    page.test.storage.failAccess = true;

    page.analytics.track('Temporary');
    sendAll(page);

    expect(page.analytics.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.requests().filter((request) => request.method === 'POST')).toEqual([]);
  });
});

describe('the automatic capture (Android AutomaticCapture)', () => {
  function withCapture(
    config: Record<string, unknown> = {},
    test = new TestPlatform(),
  ): { readonly page: Page; readonly capture: AutomaticCapture; readonly attached: number } {
    let capture: AutomaticCapture | undefined;
    let attached = 0;
    const page = open(config, {
      test,
      onCreated: (given) => {
        capture = given;
        attached += 1;
      },
    });
    if (capture === undefined) throw new Error('not attached');
    return { page, capture, attached };
  }

  it('is attached once, to a new instance', () => {
    const { attached } = withCapture();

    expect(attached).toBe(1);
  });

  it('sends automatic events with source auto, only while their type is enabled', () => {
    const test = new TestPlatform();
    saveRemote(test);
    const { page, capture } = withCapture({ autocapture: { enabled: ['sessions', 'network_requests'] } }, test);

    capture.track('page_views', 'Page Viewed', { utm_source: 'mail' });
    capture.track('network_requests', 'Network Request', { status_code: 200 });
    sendAll(page);

    const events = page.sent().filter((event) => event.event !== 'Session Started');
    expect(names(events)).toEqual(['Network Request']);
    expect(events[0]?.source).toBe('auto');
  });

  it('a type switched off remotely by an earlier page load is not sent on this one', () => {
    const test = new TestPlatform();
    saveRemote(test, { autocapture_off: ['page_views'] });
    const { page, capture } = withCapture({}, test);

    capture.track('page_views', 'Page Viewed', {});
    sendAll(page);

    expect(names(page.sent())).toEqual([]);
  });

  it('a bad automatic name only warns, even in debug', () => {
    const { page, capture } = withCapture({ debug: true });

    capture.track('page_views', '', {});

    expect(page.sink.lines).toEqual([
      { level: 'warn', message: expect.stringMatching(/^INVALID_EVENT_NAME: /) as unknown, developerErrorForm: false },
    ]);
  });

  it('network capture follows the configuration and the consent, and knows the SDK host', () => {
    const { page, capture } = withCapture();

    expect(capture.capturesNetworkRequests).toBe(true);
    expect(capture.sdkHost).toBe('api.rubicon.example');
    expect(capture.log).toBeDefined();
    page.analytics.optOut();
    expect(capture.capturesNetworkRequests).toBe(false);

    const off = withCapture({ autocapture: { enabled: ['sessions'] } });
    expect(off.capture.capturesNetworkRequests).toBe(false);
  });

  it('nothing is sent while opted out', () => {
    const test = new TestPlatform();
    saveRemote(test);
    const { page, capture } = withCapture({}, test);

    page.analytics.optOut();
    capture.track('page_views', 'Page Viewed', {});
    sendAll(page);

    expect(page.sent()).toEqual([]);
  });

  it('a throwing onCreated costs the capture only, with WORKER_FAILED', () => {
    const test = new TestPlatform();
    const sink = new RecordingSink();

    const analytics = createCore({ apiKey: API_KEY }, test.platform, {
      sink,
      onCreated: () => {
        throw new Error('attach');
      },
    });

    expect(coreOf(analytics)).toBeDefined();
    expect(sink.messages).toEqual([expect.stringMatching(/^WORKER_FAILED: /) as unknown]);
  });
});

describe('never crash the host (root CLAUDE.md, non-negotiable 1)', () => {
  // Every verb, with arguments a JavaScript caller might pass.
  function callEverything(analytics: Analytics): unknown[] {
    const loose = analytics as unknown as Record<string, (...args: unknown[]) => unknown>;
    const results: unknown[] = [];
    const calls: [string, unknown[]][] = [
      ['track', ['Event', { a: 1 }]],
      ['screen', ['checkout']],
      ['identify', ['user-1', { plan: 'pro' }]],
      ['register', ['k', 'v']],
      ['unregister', ['k']],
      ['flush', []],
      ['reset', []],
      ['optOut', []],
      ['optIn', []],
      ['clearLocalData', []],
      ['track', [undefined, null]],
      ['identify', [42]],
    ];
    for (const [verb, args] of calls) results.push(loose[verb]?.(...args));
    results.push(analytics.isOptedOut, analytics.deviceId);
    return results;
  }

  const throwing = (): never => {
    throw new Error('injected');
  };

  function broken(test: TestPlatform, part: keyof Platform): Platform {
    const parts: Partial<Record<keyof Platform, unknown>> = {
      clock: { now: throwing },
      random: { nextUint32: throwing },
      storage: {
        get length(): number {
          return throwing();
        },
        key: throwing,
        getItem: throwing,
        setItem: throwing,
        removeItem: throwing,
      },
      storageEvents: { subscribe: throwing },
      cookies: { readAll: throwing, write: throwing },
      transport: { send: throwing },
      lifecycle: { isVisible: throwing, subscribe: throwing },
      network: { isOnline: throwing, subscribe: throwing },
      context: { staticValues: throwing, callTimeValues: throwing },
      scheduler: { after: throwing, yield: throwing },
      urls: { parse: throwing },
    };
    return { ...test.platform, [part]: parts[part] };
  }

  const PARTS: (keyof Platform)[] = [
    'clock',
    'random',
    'storage',
    'storageEvents',
    'cookies',
    'transport',
    'lifecycle',
    'network',
    'context',
    'scheduler',
    'urls',
  ];

  for (const part of PARTS) {
    for (const debug of [false, true]) {
      it(`every public call returns normally with a throwing ${part}${debug ? ', debug on' : ''}`, () => {
        const test = new TestPlatform();
        const sink = new RecordingSink();
        let analytics: Analytics | undefined;

        expect(() => {
          analytics = createCore({ apiKey: API_KEY, debug }, broken(test, part), { sink });
        }).not.toThrow();
        const created = analytics ?? createCore({ apiKey: '' }, test.platform);
        expect(() => callEverything(created)).not.toThrow();
        expect(() => {
          test.scheduler.runUntilIdle();
        }).not.toThrow();
        expect(typeof created.isOptedOut).toBe('boolean');
        expect(typeof created.deviceId).toBe('string');
      });
    }
  }

  it('a failure below a call is logged as WORKER_FAILED with the error for the logger only', () => {
    const test = new TestPlatform();
    const logger = new RecordingLogger();
    const error = new Error('context provider secret');
    const platform: Platform = {
      ...test.platform,
      context: {
        staticValues: () => {
          throw error;
        },
        callTimeValues: () => {
          throw error;
        },
      },
    };
    const analytics = createCore({ apiKey: API_KEY, logging: { logger: logger.logger } }, platform);

    analytics.track('Broken');

    const failed = logger.lines.find((line) => line.message.startsWith('WORKER_FAILED'));
    expect(failed?.error).toBe(error);
    expect(logger.messages.join('\n')).not.toContain('secret');
  });

  it('a throwing hook, logger and observer cost only their own work', () => {
    const page = openFresh({
      beforeSend: [throwing],
      logging: { logger: throwing, eventObserver: throwing, level: 'debug' },
    });

    expect(() => callEverything(page.analytics)).not.toThrow();
    expect(() => {
      page.run();
    }).not.toThrow();
  });
});
