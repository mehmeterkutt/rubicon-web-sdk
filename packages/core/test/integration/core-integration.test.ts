import { TestPlatform, TestServer, TimerScheduler, realTimePlatform } from 'rubicon-analytics-testing';
import type { RecordedRequest } from 'rubicon-analytics-testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Analytics } from '../../src';
import {
  chunkKey,
  createCore,
  encodeIdentityCookie,
  flushAndWait,
  identityCookieName,
  keyHash,
  parseQueueKey,
  shutdown,
  storeKey,
} from '../../src';

// The component integration suite (plan section 5, step 6.7), the port of the Android
// `CoreIntegrationTest`: the whole core from the public call to the test server over a real socket,
// through Node's `fetch`, with the wall clock and real timers; storage and cookies are the in-memory
// ones of `TestPlatform`, shared by the simulated pages of one browser. Every wait is a condition
// with a timeout, never a fixed sleep. Not ported: the second instance (step 7.1 on the web), the
// frozen configuration (the web freezes nothing, Web Configuration 1) and the Android automatic
// events (the unit tests cover the web's automatic capture).

const API_KEY = 'rk_integration';
const KEY_HASH = keyHash(API_KEY);
const HOUR = 60 * 60 * 1000;

let server: TestServer;
const opened: { analytics: Analytics; scheduler: TimerScheduler }[] = [];

beforeAll(async () => {
  server = await TestServer.start();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
  // No remote values: a 404 deletes nothing and keeps the code's configuration (step 5.3).
  server.respond('/v1/config', { status: 404 });
});

afterEach(() => {
  for (const page of opened.splice(0)) {
    shutdown(page.analytics);
    page.scheduler.cancelAll();
  }
});

/** One page of the browser `test`, on real time, sending to the test server. */
function open(test: TestPlatform, config: Record<string, unknown> = {}): Analytics {
  const scheduler = new TimerScheduler();
  const analytics = createCore(
    {
      apiKey: API_KEY,
      host: server.origin(),
      flush: { intervalMs: 1_000 },
      // The cleartext host's WARN would otherwise add `SDK Diagnostics` to the batches.
      logging: { sendDiagnostics: false },
      ...config,
    },
    realTimePlatform(test, { scheduler }),
  );
  opened.push({ analytics, scheduler });
  return analytics;
}

interface WireEvent {
  readonly type: string;
  readonly event?: string;
  readonly name?: string;
  readonly message_id: string;
  readonly device_id: string;
  readonly user_id: string | null;
}

function uploads(): RecordedRequest[] {
  return server.requests.filter((request) => request.path === '/v1/batch');
}

function events(request: RecordedRequest | undefined): WireEvent[] {
  return (JSON.parse(request?.body ?? '{"batch":[]}') as { batch: WireEvent[] }).batch;
}

function allEvents(): WireEvent[] {
  return uploads().flatMap((request) => events(request));
}

/** App events by name: the session events the pages add are left out. */
function names(list: readonly WireEvent[]): string[] {
  return list
    .map((event) => event.event ?? event.name ?? event.type)
    .filter((name) => name !== 'Session Started' && name !== 'Session Ended');
}

/** The number of events in this key's chunks in storage. */
function storedEvents(test: TestPlatform): number {
  let count = 0;
  for (const key of test.storage.area.entries.keys()) {
    const parsed = parseQueueKey(key);
    if (parsed?.kind === 'chunk' && parsed.name.keyHash === KEY_HASH) count += parsed.name.count;
  }
  return count;
}

/** Resolves once `condition` holds, polling on a real timer; rejects after `timeoutMs`. */
function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (condition()) resolve();
      else if (Date.now() > deadline) reject(new Error('condition not met in time'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

describe('the core against the test server', () => {
  it('tracked events reach the server through Node fetch', async () => {
    const analytics = open(new TestPlatform());

    analytics.identify('user-42', { plan: 'pro' });
    analytics.track('Signed Up', { method: 'email' });
    analytics.screen('checkout');

    expect(await flushAndWait(analytics, 10_000)).toBe(true);
    const request = uploads()[0];
    expect(request?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(request?.headers['content-type']).toBe('application/json; charset=utf-8');
    const sent = events(request);
    expect(names(sent)).toEqual(['identify', 'Signed Up', 'checkout']);
    expect(sent.every((event) => event.user_id === 'user-42')).toBe(true);
    expect(sent.every((event) => event.device_id === analytics.deviceId)).toBe(true);
  });

  it('offline then online', async () => {
    const test = new TestPlatform({ online: false });
    const analytics = open(test);

    analytics.track('Offline');
    analytics.flush();
    await waitFor(() => storedEvents(test) > 1);
    expect(uploads()).toEqual([]);

    test.network.goOnline();

    expect(await flushAndWait(analytics, 10_000)).toBe(true);
    expect(names(allEvents())).toEqual(['Offline']);
  });

  it('503 then 200 sends the same batch again', async () => {
    server.enqueue({ status: 503, headers: { 'Retry-After': '1' } }, { status: 200 });
    const analytics = open(new TestPlatform());

    analytics.track('Retried');

    expect(await flushAndWait(analytics, 10_000)).toBe(true);
    const [first, second] = uploads();
    expect(events(second).map((event) => event.message_id)).toEqual(events(first).map((event) => event.message_id));
  });

  it('a reload over the same storage sends what the previous page left', async () => {
    const test = new TestPlatform({ online: false });
    const first = open(test);
    first.track('Left', { n: 1 });
    first.track('Left', { n: 2 });
    first.flush();
    await waitFor(() => storedEvents(test) === 3);
    // Leaving the page releases its chunks to the next page (Web Queue 2, Web Disk 2).
    test.lifecycle.pagehide();
    test.lifecycle.hide();
    shutdown(first);
    test.network.goOnline();

    const second = open(test.otherPage());

    expect(await flushAndWait(second, 10_000)).toBe(true);
    expect(names(allEvents())).toEqual(['Left', 'Left']);
    expect(second.deviceId).toBe(first.deviceId);
  });

  it('two pages at once send every event once, with one device id', async () => {
    const test = new TestPlatform();
    const a = open(test);
    const b = open(test.otherPage());

    for (let i = 0; i < 3; i += 1) {
      a.track('From A', { i });
      b.track('From B', { i });
    }

    expect(await flushAndWait(a, 10_000)).toBe(true);
    expect(await flushAndWait(b, 10_000)).toBe(true);
    const sent = allEvents();
    expect(names(sent).sort()).toEqual(['From A', 'From A', 'From A', 'From B', 'From B', 'From B']);
    expect(new Set(sent.map((event) => event.message_id)).size).toBe(sent.length);
    expect(new Set(sent.map((event) => event.device_id))).toEqual(new Set([a.deviceId]));
    expect(b.deviceId).toBe(a.deviceId);
  });

  it('leftovers of a page that died between writes are sent, whole lines only', async () => {
    const test = new TestPlatform();
    const deviceId = '0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f';
    test.cookies.write({
      name: identityCookieName(KEY_HASH),
      value: encodeIdentityCookie({ deviceId, userId: null, personEpoch: '0123456789abcdef' }),
      path: '/',
      maxAgeSeconds: 3600,
      sameSite: 'Lax',
      secure: true,
    });
    // A page that never reached `pagehide`: no released marker, its chunk aged past adoption, one
    // line of it broken (Web Queue 2 point 5, Disk 5).
    const then = Date.now() - 2 * HOUR;
    const line = (id: string): string =>
      JSON.stringify({
        type: 'track',
        event: 'Before Death',
        source: 'app',
        message_id: id,
        timestamp: then,
        user_id: null,
        device_id: deviceId,
      });
    const value = `${line('m-1')}\n{"type":"track","event":"Half\n${line('m-2')}\n`;
    test.storage.area.entries.set(
      chunkKey({
        keyHash: KEY_HASH,
        writtenAt: then,
        newestEventAt: then,
        pageId: 'deadbeefdeadbeef',
        seq: 0,
        count: 3,
        chars: value.length,
      }),
      value,
    );

    const analytics = open(test);

    expect(await flushAndWait(analytics, 10_000)).toBe(true);
    expect(allEvents().map((event) => event.message_id)).toEqual(['m-1', 'm-2']);
    const device = JSON.parse(test.storage.area.entries.get(storeKey(KEY_HASH, 'device')) ?? '{}') as {
      diagnostics?: { dropped?: Record<string, number> };
    };
    expect(device.diagnostics?.dropped?.['corrupt']).toBe(1);
  });

  it('an unusable configuration gives the no-op instance and sends nothing', async () => {
    const test = new TestPlatform();
    const analytics = open(test, { host: 'not a host' });

    analytics.track('Nowhere');

    expect(analytics.isOptedOut).toBe(true);
    expect(await flushAndWait(analytics, 100)).toBe(false);
    expect(server.requests).toEqual([]);
    expect(test.storage.area.entries.size).toBe(0);
  });

  it('an invalid event name is dropped and the next event goes on', async () => {
    const analytics = open(new TestPlatform(), { debug: true });

    analytics.track(' ');
    analytics.track('Valid');

    expect(await flushAndWait(analytics, 10_000)).toBe(true);
    expect(names(allEvents())).toEqual(['Valid']);
  });

  it('opted out, nothing new is sent and the choice survives a reload', async () => {
    const test = new TestPlatform();
    const first = open(test);
    first.optOut();
    first.track('Hidden');
    expect(await flushAndWait(first, 10_000)).toBe(true);
    shutdown(first);

    const reloaded = open(test.otherPage());

    expect(reloaded.isOptedOut).toBe(true);
    reloaded.track('Still hidden');
    expect(await flushAndWait(reloaded, 10_000)).toBe(true);
    expect(uploads()).toEqual([]);
    expect(storedEvents(test)).toBe(0);
  });
});
