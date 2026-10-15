import { RecordingLogger, RecordingSink, responseOutcome, TestClock, TestPlatform } from 'rubicon-analytics-testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Analytics, AutomaticCapture, CreateCoreOptions, HttpRequest, Platform, ReplayedVerb } from '../src';
import {
  REPLAYED_VERBS,
  captureOf,
  coreOf,
  createCore,
  createNoOpAnalytics,
  flushAndWait,
  keyHash,
  probeKey,
  shutdown,
  storageWritable,
  storeKey,
} from '../src';

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

    describe('the write half, only for a page that starts with consent granted (step 7.2, answer 3)', () => {
      const PROBE = probeKey(KEY_HASH);

      it('a write that fails selects the memory-only mode with one STORAGE_UNAVAILABLE', () => {
        const test = new TestPlatform();
        test.transport.enqueue(responseOutcome(404));
        const asked: string[] = [];
        const page = open(
          {},
          {
            test,
            storageUsable: () => true,
            storageWritable: (key) => {
              asked.push(key);
              return false;
            },
          },
        );

        page.analytics.track('Memory');
        sendAll(page);

        expect(asked).toEqual([PROBE]);
        expect(page.sink.messages).toEqual([expect.stringMatching(/^STORAGE_UNAVAILABLE: /) as unknown]);
        expect(page.test.cookies.store.cookies()).toEqual([]);
        expect([...page.test.storage.area.entries.keys()]).toEqual([]);
        expect(names(page.sent())).toEqual(['Session Started', 'Memory']);
      });

      it('a write probe that throws counts as storage that cannot be written', () => {
        const test = new TestPlatform();
        test.transport.enqueue(responseOutcome(404));
        const page = open(
          {},
          {
            test,
            storageWritable: () => {
              throw new Error('probe');
            },
          },
        );
        page.analytics.track('Memory');
        page.run();
        expect(page.sink.messages).toEqual([expect.stringMatching(/^STORAGE_UNAVAILABLE: /) as unknown]);
      });

      it('is asked over the real storage: a zero quota for the probe key gives the memory-only mode', () => {
        const test = new TestPlatform();
        test.transport.enqueue(responseOutcome(404));
        test.storage.failWritesWhere = (key) => key === PROBE;
        const page = open({}, { test, storageWritable: (key) => storageWritable(test.storage, key) });
        page.analytics.track('Memory');
        page.run();
        expect(page.sink.messages).toEqual([expect.stringMatching(/^STORAGE_UNAVAILABLE: /) as unknown]);
        expect(test.storage.area.entries.has(PROBE)).toBe(false);
      });

      it('is not asked while consent is pending, which writes nothing', () => {
        const test = new TestPlatform();
        let asked = 0;
        const page = open(
          { privacy: { defaultConsent: 'pending' } },
          {
            test,
            storageWritable: () => {
              asked += 1;
              return false;
            },
          },
        );
        page.analytics.track('Waiting');
        page.run();
        expect(asked).toBe(0);
        expect(page.sink.messages).toEqual([]);
      });

      it('is not asked while a stored refusal holds', () => {
        const test = new TestPlatform();
        saveRemote(test);
        test.storage.area.entries.set(
          storeKey(KEY_HASH, 'consent'),
          JSON.stringify({ v: 1, state: 'denied', decided_at: NOW - MINUTE }),
        );
        let asked = 0;
        const page = open(
          {},
          {
            test,
            storageWritable: () => {
              asked += 1;
              return false;
            },
          },
        );
        expect(page.analytics.isOptedOut).toBe(true);
        expect(asked).toBe(0);
      });

      it('is not asked when the read half already failed', () => {
        const test = new TestPlatform();
        test.transport.enqueue(responseOutcome(404));
        let asked = 0;
        const page = open(
          {},
          {
            test,
            storageUsable: () => false,
            storageWritable: () => {
              asked += 1;
              return true;
            },
          },
        );
        page.analytics.track('Memory');
        page.run();
        expect(asked).toBe(0);
        expect(page.sink.messages).toHaveLength(1);
      });

      it('a write that passes leaves no key and changes nothing', () => {
        const test = new TestPlatform();
        saveRemote(test);
        const page = open({}, { test, storageWritable: (key) => storageWritable(test.storage, key) });
        page.analytics.track('Stored');
        page.run();
        expect(page.sink.messages).toEqual([]);
        expect(test.storage.area.entries.has(PROBE)).toBe(false);
        expect(test.storage.area.entries.has(storeKey(KEY_HASH, 'device'))).toBe(true);
      });
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

describe('the cookie domain (Web Identity 2; plan section 15, step 7.2)', () => {
  /** Every `Domain` the page's cookies were written with, probes apart, by cookie name. */
  function recordWrites(test: TestPlatform): { platform: Platform; writes: { name: string; domain?: string }[] } {
    const writes: { name: string; domain?: string }[] = [];
    const platform: Platform = {
      ...test.platform,
      cookies: {
        readAll: () => test.cookies.readAll(),
        write: (cookie) => {
          writes.push({ name: cookie.name, domain: cookie.domain });
          test.cookies.write(cookie);
        },
      },
    };
    return { platform, writes };
  }

  const IDENTITY = `rubicon_${KEY_HASH}`;

  it('writes the identity and session cookies for the registrable domain, so another subdomain shares them', () => {
    const test = new TestPlatform();
    saveRemote(test);
    const page = open({}, { test });
    page.analytics.track('First');
    page.run();

    const stored = test.cookies.store.cookies().filter((cookie) => cookie.name.startsWith('rubicon_'));
    expect(stored.map((cookie) => [cookie.name, cookie.domain, cookie.hostOnly])).toEqual([
      [IDENTITY, 'rubicon.test', false],
      [`${IDENTITY}_s`, 'rubicon.test', false],
    ]);
    const other = test.otherPage({ page: { host: 'b.rubicon.test' } });
    saveRemote(other);
    const second = open({}, { test: other });
    expect(second.analytics.deviceId).toBe(page.analytics.deviceId);
  });

  it('probes once per page, at the first cookie it writes', () => {
    const test = new TestPlatform();
    saveRemote(test);
    const { platform, writes } = recordWrites(test);
    const page = open({}, { test, platform });
    page.analytics.track('First');
    page.analytics.identify('user-1');
    page.analytics.track('Second');
    page.run();

    const probes = writes.filter((write) => write.name.startsWith('__rubicon_dmn_'));
    expect(probes.map((write) => write.domain)).toEqual(['test', 'rubicon.test', 'rubicon.test']);
    expect(writes.indexOf(probes[0]!)).toBe(0);
    expect(new Set(writes.filter((write) => write.name.startsWith('rubicon_')).map((w) => w.domain))).toEqual(
      new Set(['rubicon.test']),
    );
  });

  it('gives host-only cookies with crossSubdomain false', () => {
    const test = new TestPlatform();
    saveRemote(test);
    const page = open({ identity: { crossSubdomain: false } }, { test });
    page.analytics.track('First');
    page.run();

    expect(test.cookies.store.cookies().every((cookie) => cookie.hostOnly)).toBe(true);
    expect(page.sink.messages).toEqual([]);
  });

  it('an invalid cookieDomain gives host-only cookies and one INVALID_COOKIE_DOMAIN', () => {
    const test = new TestPlatform();
    saveRemote(test);
    const page = open({ identity: { cookieDomain: 'example.com' } }, { test });
    page.analytics.track('First');
    page.analytics.track('Second');
    page.run();

    expect(test.cookies.store.cookies().every((cookie) => cookie.hostOnly)).toBe(true);
    expect(page.sink.messages).toEqual([
      'INVALID_COOKIE_DOMAIN: identity.cookieDomain is not a suffix of this host; cookies are host-only',
    ]);
  });

  describe('one scope per cookie name (step 7.2, answer 2)', () => {
    /** The identity cookie written in two scopes: host-only first, so the browser lists it first. */
    function plantTwoScopes(test: TestPlatform, hostOnly: string, domain: string): void {
      const base = { name: IDENTITY, path: '/', maxAgeSeconds: 3600, sameSite: 'Lax', secure: true } as const;
      test.cookies.write({ ...base, value: `1.${hostOnly}.0123456789abcdef.` });
      test.cookies.write({ ...base, value: `1.${domain}.fedcba9876543210.`, domain: 'rubicon.test' });
    }
    const HOST_ONLY_ID = '0192e4a1-7c3f-7000-8000-00000000000a';
    const DOMAIN_ID = '0192e4a1-7c3f-7000-8000-00000000000b';

    it('after a change from host-only to the site, an identify is read by the next call', () => {
      const test = new TestPlatform();
      saveRemote(test);
      const first = open({ identity: { crossSubdomain: false } }, { test });
      first.analytics.track('Host only');
      const deviceId = first.analytics.deviceId;
      shutdown(first.analytics);

      const later = test.otherPage();
      const page = open({}, { test: later });
      page.analytics.identify('user-1');
      page.analytics.track('After');
      page.run();

      expect(coreOf(page.analytics)?.identity.snapshot()).toMatchObject({ deviceId, userId: 'user-1' });
      const identity = test.cookies.store.cookies().filter((cookie) => cookie.name === IDENTITY);
      expect(identity.map((cookie) => [cookie.domain, cookie.hostOnly])).toEqual([['rubicon.test', false]]);
    });

    it('at first use the page keeps the current scope and deletes the other', () => {
      const test = new TestPlatform();
      saveRemote(test);
      plantTwoScopes(test, HOST_ONLY_ID, DOMAIN_ID);

      const page = open({}, { test });

      expect(page.analytics.deviceId).toBe(DOMAIN_ID);
      const identity = test.cookies.store.cookies().filter((cookie) => cookie.name === IDENTITY);
      expect(identity.map((cookie) => [cookie.domain, cookie.hostOnly])).toEqual([['rubicon.test', false]]);
    });

    it('with crossSubdomain false the host-only scope is kept', () => {
      const test = new TestPlatform();
      saveRemote(test);
      plantTwoScopes(test, HOST_ONLY_ID, DOMAIN_ID);

      const page = open({ identity: { crossSubdomain: false } }, { test });

      expect(page.analytics.deviceId).toBe(HOST_ONLY_ID);
      const identity = test.cookies.store.cookies().filter((cookie) => cookie.name === IDENTITY);
      expect(identity.map((cookie) => cookie.hostOnly)).toEqual([true]);
    });

    it('while consent is pending nothing is deleted', () => {
      const test = new TestPlatform();
      plantTwoScopes(test, HOST_ONLY_ID, DOMAIN_ID);

      const page = open({ privacy: { defaultConsent: 'pending' } }, { test });
      page.analytics.track('Waiting');
      page.run();

      expect(test.cookies.store.cookies().filter((cookie) => cookie.name === IDENTITY)).toHaveLength(2);
    });
  });

  it('probes nothing while consent is pending, and probes at optIn()', () => {
    const test = new TestPlatform();
    const { platform, writes } = recordWrites(test);
    test.transport.enqueue(responseOutcome(404));
    const page = open({ privacy: { defaultConsent: 'pending' } }, { test, platform });
    page.analytics.track('Waiting');
    page.run();
    expect(writes).toEqual([]);

    page.analytics.optIn();
    page.run();

    expect(writes[0]?.name).toMatch(/^__rubicon_dmn_/);
    expect(
      test.cookies.store
        .cookies()
        .filter((cookie) => cookie.name.startsWith('rubicon_'))
        .map((cookie) => [cookie.name, cookie.domain]),
    ).toEqual([
      [`${IDENTITY}_c`, 'rubicon.test'],
      [IDENTITY, 'rubicon.test'],
    ]);
  });
});

describe('the Content Security Policy diagnosis (Web HTTP 3; step 7.3)', () => {
  function watched(): {
    readonly page: Page;
    readonly calls: (readonly string[])[];
    readonly block: () => void;
    readonly stopped: () => number;
  } {
    const calls: (readonly string[])[] = [];
    let onBlocked: (() => void) | undefined;
    let stops = 0;
    const page = openFresh(
      { host: 'https://api.rubicon.example/rb', logging: { level: 'debug', sendDiagnostics: false } },
      {
        watchPolicyViolations: (endpoints, blocked) => {
          calls.push(endpoints);
          onBlocked = blocked;
          return () => {
            stops += 1;
          };
        },
      },
    );
    return {
      page,
      calls,
      block: () => {
        onBlocked?.();
      },
      stopped: () => stops,
    };
  }

  function cspLines(page: Page): string[] {
    return page.sink.lines
      .filter((line) => line.message.startsWith('CSP_BLOCKED:'))
      .map((line) => `${line.level} ${line.message}`);
  }

  it('watches from the start with the two endpoints, never in the factory', () => {
    const { page, calls } = watched();
    expect(calls).toEqual([]);

    page.run();

    expect(calls).toEqual([['https://api.rubicon.example/rb/v1/batch', 'https://api.rubicon.example/rb/v1/config']]);
  });

  it('a violation is one CSP_BLOCKED ERROR per page naming the host, later ones DEBUG lines', () => {
    const { page, block } = watched();
    page.run();

    block();
    block();

    expect(cspLines(page)).toEqual([
      "error CSP_BLOCKED: The page's Content Security Policy blocked a request to api.rubicon.example; " +
        'allow its origin in connect-src',
      "debug CSP_BLOCKED: The page's Content Security Policy blocked a request to api.rubicon.example; " +
        'allow its origin in connect-src',
    ]);
  });

  it('never changes what the uploader does', () => {
    const { page, block } = watched();
    page.analytics.track('Kept');
    page.run();
    block();
    sendAll(page);

    expect(names(page.sent())).toEqual(['Session Started', 'Kept']);
  });

  it('stops watching at shutdown', () => {
    const { page, stopped } = watched();
    page.run();
    shutdown(page.analytics);
    expect(stopped()).toBe(1);
  });

  it('a watcher that throws costs the diagnosis only, with WORKER_FAILED', () => {
    const page = openFresh(
      {},
      {
        watchPolicyViolations: () => {
          throw new Error('watch');
        },
      },
    );
    page.analytics.track('Still');
    sendAll(page);

    expect(page.sink.messages).toEqual([expect.stringMatching(/^WORKER_FAILED: /) as unknown]);
    expect(names(page.sent())).toEqual(['Session Started', 'Still']);
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

  it('is reached from the instance, tells the platform time, and is absent for the no-op (step 7.7)', () => {
    const test = new TestPlatform();
    const { page, capture } = withCapture({}, test);

    test.clock.advanceBy(1234);

    expect(captureOf(page.analytics)).toBe(capture);
    expect(capture.now()).toBe(test.clock.now());
    expect(captureOf(createNoOpAnalytics())).toBeUndefined();
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

  describe('a moment read now for an event made later (step 7.6)', () => {
    interface MomentEvent extends WireEvent {
      readonly timestamp: number;
      readonly context: { readonly page?: Record<string, unknown>; readonly session?: unknown };
    }

    it('keeps the time, the visibility and the context of when it was read, and never starts the instance', () => {
      const test = new TestPlatform();
      saveRemote(test);
      test.context.callTimeContext = { pageUrl: 'https://shop.example/landing', viewportWidth: 1280 };
      const { page, capture } = withCapture({}, test);

      const moment = capture.moment();
      expect(test.cookies.store.cookies()).toEqual([]);
      expect(test.storage.area.entries.size).toBe(1);
      test.clock.advanceBy(2_000);
      test.context.callTimeContext = { pageUrl: 'https://shop.example/later', viewportWidth: 800 };
      capture.track('page_views', 'Page Viewed', {}, moment);
      sendAll(page);

      const [started, viewed] = page.sent() as MomentEvent[];
      expect(moment).toEqual({
        time: NOW,
        visible: true,
        callTime: { pageUrl: 'https://shop.example/landing', viewportWidth: 1280 },
      });
      expect(names([started, viewed].filter((event) => event !== undefined))).toEqual([
        'Session Started',
        'Page Viewed',
      ]);
      expect(viewed?.timestamp).toBe(NOW);
      expect(viewed?.context.page).toEqual({ url: 'https://shop.example/landing', viewport_width: 1280 });
    });

    it('a moment read while hidden starts no session for its event (Web Session 1)', () => {
      const test = new TestPlatform({ visible: false });
      saveRemote(test);
      const { page, capture } = withCapture({}, test);

      const moment = capture.moment();
      test.lifecycle.show();
      capture.track('page_views', 'Page Viewed', {}, moment);
      sendAll(page);

      const sent = page.sent() as MomentEvent[];
      expect(names(sent)).toEqual(['Page Viewed']);
      expect(sent[0]?.context.session).toBeUndefined();
    });

    it('with a location, page.url and page.query come from it', () => {
      const { capture, page } = withCapture({ context: { page: { queryParams: ['page'] } } });
      page.test.context.callTimeContext = { pageUrl: 'https://shop.example/now' };

      const moment = capture.moment({ origin: 'https://shop.example', pathname: '/before', search: '?page=2' });

      expect(moment?.callTime.pageUrl).toBe('https://shop.example/before');
      expect(page.test.context.callTimeReads).toBe(1);
    });

    it('a provider that throws gives no moment, with WORKER_FAILED', () => {
      const test = new TestPlatform();
      const platform: Platform = {
        ...test.platform,
        context: {
          staticValues: () => ({}),
          callTimeValues: () => {
            throw new Error('context');
          },
        },
      };
      let capture: AutomaticCapture | undefined;
      const page = open({}, { test, platform, onCreated: (given) => (capture = given) });

      expect(capture?.moment()).toBeUndefined();
      expect(page.sink.messages).toEqual([expect.stringMatching(/^WORKER_FAILED: /) as unknown]);
    });
  });

  describe('a capture that starts with the instance (step 7.6)', () => {
    it('configures reads the code configuration, without starting the instance', () => {
      const { capture, page } = withCapture({ autocapture: { enabled: ['sessions'] } });

      expect(capture.configures('sessions')).toBe(true);
      expect(capture.configures('page_views')).toBe(false);
      expect(page.requests()).toEqual([]);
    });

    it('runs once at the start, before the writer listens to the lifecycle, and stops at shutdown', () => {
      const test = new TestPlatform();
      saveRemote(test);
      let capture: AutomaticCapture | undefined;
      let runs = 0;
      let stopped = 0;
      const page = open(
        {},
        {
          test,
          onCreated: (given) => {
            capture = given;
            given.onStart('page_views', () => {
              runs += 1;
              // An event made on pagehide reaches the writer's drain, not the page_closed count.
              const unsubscribe = test.lifecycle.subscribe((event) => {
                if (event === 'pagehide') given.track('page_views', 'Page Viewed', {});
              });
              return () => {
                unsubscribe();
                stopped += 1;
              };
            });
          },
        },
      );

      expect(runs).toBe(0);
      page.analytics.track('First');
      page.analytics.track('Second');
      page.run();
      capture?.onStart('page_views', () => {
        runs += 1;
        return undefined;
      });
      test.lifecycle.pagehide();
      page.run();

      expect(runs).toBe(1);
      expect(names(page.sent())).toEqual(['Session Started', 'First', 'Second', 'Page Viewed']);
      expect(page.sink.messages).toEqual([]);
      shutdown(page.analytics);
      expect(stopped).toBe(1);
    });

    it('does not run when its type is off in the code or switched off by an earlier page load', () => {
      const runs: string[] = [];
      const hook = (label: string) => (given: AutomaticCapture) => {
        given.onStart('page_views', () => {
          runs.push(label);
          return undefined;
        });
      };
      open({ autocapture: { enabled: ['sessions'] } }, { onCreated: hook('code') }).run();
      const test = new TestPlatform();
      saveRemote(test, { autocapture_off: ['page_views'] });
      open({}, { test, onCreated: hook('remote') }).run();
      open({}, { onCreated: hook('on') }).run();

      expect(runs).toEqual(['on']);
    });

    it('a throw costs that capture only, with WORKER_FAILED', () => {
      const test = new TestPlatform();
      saveRemote(test);
      const page = open(
        {},
        {
          test,
          onCreated: (given) => {
            given.onStart('page_views', () => {
              throw new Error('start');
            });
          },
        },
      );

      page.analytics.track('Still');
      sendAll(page);

      expect(page.sink.messages).toEqual([expect.stringMatching(/^WORKER_FAILED: /) as unknown]);
      expect(names(page.sent())).toEqual(['Session Started', 'Still']);
    });
  });
});

describe('a call the snippet queued, replayed as of its recorded moment (step 7.8)', () => {
  // Web Public API 2, Web Context 4, Web Session 5: "Replay evaluates each call with its recorded time
  // and visibility"; message ids are made at replay.
  interface ReplayedEvent extends WireEvent {
    readonly message_id: string;
    readonly timestamp: number;
    readonly properties?: Record<string, unknown>;
    readonly context: {
      readonly page?: Record<string, unknown>;
      readonly session?: { readonly id: string; readonly started_at: number };
    };
  }

  const RECORDED_PAGE = { origin: 'https://shop.example', pathname: '/landing', search: '' };

  function replayPage(config: Record<string, unknown> = {}, test = new TestPlatform()) {
    saveRemote(test);
    let capture: AutomaticCapture | undefined;
    const page = open(config, { test, onCreated: (given) => (capture = given) });
    if (capture === undefined) throw new Error('not attached');
    const recorded = capture;
    const momentAt = (time: number, visible = true) => {
      const read = recorded.moment(RECORDED_PAGE, { width: 375, height: 640 });
      if (read === undefined) throw new Error('no moment');
      return { ...read, time, visible };
    };
    return { page, capture: recorded, momentAt, sent: () => page.sent() as ReplayedEvent[] };
  }

  it('REPLAYED_VERBS lists every method of Analytics, and not the two reads', () => {
    const methods = Object.keys(createNoOpAnalytics()).filter(
      (key) => typeof Reflect.get(createNoOpAnalytics(), key) === 'function',
    );

    expect([...REPLAYED_VERBS].sort()).toEqual(methods.sort());
    expectTypeOf<(typeof REPLAYED_VERBS)[number]>().toEqualTypeOf<ReplayedVerb>();
  });

  it('a replayed track takes the recorded time, visibility, URL and viewport, with an id made now', () => {
    const { page, capture, momentAt, sent } = replayPage();
    page.test.context.callTimeContext = { viewportWidth: 1280, viewportHeight: 800 };
    const moment = momentAt(NOW - 4_000);
    page.test.clock.advanceBy(3_000);

    capture.replay('track', ['Queued', { plan: 'pro' }], moment);
    page.analytics.track('Live');
    sendAll(page);

    const [started, queued, live] = sent();
    expect(names(sent())).toEqual(['Session Started', 'Queued', 'Live']);
    expect(queued?.source).toBe('app');
    expect(queued?.timestamp).toBe(NOW - 4_000);
    expect(queued?.properties).toEqual({ plan: 'pro' });
    expect(queued?.context.page).toEqual({
      url: 'https://shop.example/landing',
      viewport_width: 375,
      viewport_height: 640,
    });
    expect(started?.timestamp).toBe(NOW - 4_000);
    expect(live?.timestamp).toBe(NOW + 3_000);
    expect(live?.context.page).toEqual({ viewport_width: 1280, viewport_height: 800 });
    expect(new Set([started?.message_id, queued?.message_id, live?.message_id]).size).toBe(3);
  });

  it('screen and identify take the recorded moment too', () => {
    const { page, capture, momentAt, sent } = replayPage();
    const moment = momentAt(NOW - 1_000);
    page.test.clock.advanceBy(5_000);

    capture.replay('screen', ['checkout'], moment);
    capture.replay('identify', ['user-1', { plan: 'pro' }], moment);
    sendAll(page);

    const events = sent().filter((event) => event.type !== 'track');
    expect(events.map((event) => [event.type, event.timestamp])).toEqual([
      ['screen', NOW - 1_000],
      ['identify', NOW - 1_000],
    ]);
    expect(events[1]?.user_id).toBe('user-1');
  });

  it('a call recorded while hidden starts no session (Web Session 1)', () => {
    const { page, capture, momentAt, sent } = replayPage();

    capture.replay('track', ['Hidden'], momentAt(NOW, false));
    sendAll(page);

    expect(names(sent())).toEqual(['Hidden']);
    expect(sent()[0]?.context.session).toBeUndefined();
  });

  it('a call recorded before a session another page started carries none and moves nothing back', () => {
    const { page, capture, momentAt, sent } = replayPage();
    const moment = momentAt(NOW);
    page.test.clock.advanceBy(2 * MINUTE);
    page.analytics.track('Live');
    const before = page.test.cookies.store.cookies().map((cookie) => `${cookie.name}=${cookie.value}`);

    capture.replay('track', ['Queued'], moment);
    sendAll(page);

    const queued = sent().find((event) => event.event === 'Queued');
    expect(queued?.context.session).toBeUndefined();
    expect(page.test.cookies.store.cookies().map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual(before);
  });

  it('a replayed reset ends the session as of its recorded moment, not of now', () => {
    const { page, capture, momentAt, sent } = replayPage();
    page.analytics.track('Live');
    const moment = momentAt(NOW + MINUTE);
    page.test.clock.advanceBy(10 * MINUTE);

    capture.replay('reset', [], moment);
    sendAll(page);

    const ended = sent().find((event) => event.event === 'Session Ended');
    expect(ended?.timestamp).toBe(NOW + MINUTE);
    expect(ended?.properties).toEqual({ duration_ms: MINUTE });
    expect(ended?.context.page).toEqual({
      url: 'https://shop.example/landing',
      viewport_width: 375,
      viewport_height: 640,
    });
  });

  it('every other verb reaches its public method, in the order replayed', () => {
    const { page, capture, momentAt, sent } = replayPage();
    const moment = momentAt(NOW);

    capture.replay('register', ['plan', 'pro'], moment);
    capture.replay('track', ['With'], moment);
    capture.replay('unregister', ['plan'], moment);
    capture.replay('track', ['Without'], moment);
    capture.replay('flush', [], moment);
    page.run();
    capture.replay('optOut', [], moment);
    expect(page.analytics.isOptedOut).toBe(true);
    capture.replay('optIn', [], moment);
    expect(page.analytics.isOptedOut).toBe(false);
    const before = page.analytics.deviceId;
    capture.replay('clearLocalData', [], moment);

    expect(sent().map((event) => [event.event, event.properties])).toEqual([
      // Super properties merge into every track event, the session's included (Android log 6.3a).
      ['Session Started', { plan: 'pro' }],
      ['With', { plan: 'pro' }],
      ['Without', {}],
    ]);
    expect(page.analytics.deviceId).not.toBe(before);
  });

  it('a replayed call is checked as the public one: a bad name is a developer error and nothing throws', () => {
    const { page, capture, momentAt } = replayPage({ debug: true });

    expect(() => {
      capture.replay('track', [''], momentAt(NOW));
      capture.replay('identify', [42], momentAt(NOW));
    }).not.toThrow();

    expect(page.sink.lines.map((line) => [line.message.split(':')[0], line.developerErrorForm])).toEqual([
      ['INVALID_EVENT_NAME', true],
      ['INVALID_USER_ID', true],
    ]);
  });

  it('the moment ends with the call: the next live call is of now', () => {
    const { page, capture, momentAt, sent } = replayPage();
    capture.replay('track', ['Queued'], momentAt(NOW - 1_000));
    page.test.clock.advanceBy(1_000);

    page.analytics.track('Live');
    sendAll(page);

    expect(sent().find((event) => event.event === 'Live')?.timestamp).toBe(NOW + 1_000);
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
