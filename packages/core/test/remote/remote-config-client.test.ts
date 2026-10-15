import {
  fetchTypeError,
  opaqueRedirectOutcome,
  RecordingLogger,
  rejectedOutcome,
  responseOutcome,
  TestClock,
  TestPlatform,
} from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import {
  HttpClient,
  keyHash,
  Log,
  NO_OP_SINK,
  REMOTE_FETCH_INTERVAL_MS,
  RemoteConfigClient,
  REQUEST_TIMEOUT_MS,
  RuntimeFlags,
  storeKey,
  Stores,
  validateConfig,
} from '../../src';
import type { ConfigSnapshot, HostSecurity, HttpOutcome, IssueCode, RemoteConsent, StoreAccess } from '../../src';

// The port of the Android RemoteConfigTest's "the client" group (Configuration 1, Android log 5.3)
// with "launch" read as page load (Web Configuration 5): a page is a `RemoteConfigClient` with its
// own `Log`, flags and transport over the origin's shared storage, as a tab is. The Android test "the
// fetch needs no consent" is inverted by the contract of 2026-10-14: no request while consent is
// pending or refused (Web Privacy 1, Web Logging 4).

const API_KEY = 'rk_test';
const KEY_HASH = keyHash(API_KEY);
const REMOTE_KEY = storeKey(KEY_HASH, 'remote');
const CONFIG_URL = 'https://api.rubicon.example/v1/config';

function code(input: Record<string, unknown> = {}, hostSecurity?: HostSecurity): ConfigSnapshot {
  const { snapshot } = validateConfig(
    { apiKey: API_KEY, ...input },
    { urls: new TestPlatform().platform.urls, pageScheme: 'https' },
  );
  if (snapshot === undefined) throw new Error('no snapshot');
  return hostSecurity === undefined ? snapshot : { ...snapshot, hostSecurity };
}

/** A 200 with `body` and the `ETag` `etag`; `null` for none. */
function ok(body: string, etag: string | null = '"v1"'): HttpOutcome {
  return responseOutcome(200, { body, headers: etag === null ? {} : { ETag: etag } });
}

interface PageOptions {
  readonly code?: ConfigSnapshot;
  readonly access?: StoreAccess['level'];
  readonly logger?: RecordingLogger;
}

/** One page load: its log, stores, flags and client over the browser of `test`. */
function openPage(test: TestPlatform, options: PageOptions = {}) {
  const logger = options.logger ?? new RecordingLogger();
  const log = new Log({ level: 'debug', debug: false, logger: logger.logger, sink: NO_OP_SINK });
  const stores = new Stores({
    keyHash: KEY_HASH,
    storage: test.storage,
    log,
    clock: test.clock,
    access: options.access,
  });
  const http = new HttpClient({
    transport: test.transport,
    scheduler: test.scheduler,
    clock: test.clock,
    network: test.network,
    urls: test.platform.urls,
    log,
  });
  const flags = new RuntimeFlags();
  const client = new RemoteConfigClient({
    code: options.code ?? code(),
    store: stores.remote,
    http,
    flags,
    clock: test.clock,
    log,
  });
  return {
    test,
    logger,
    stores,
    flags,
    client,
    /** `startup` with a fixed device id. */
    start: (deviceId = 'device-1') => client.startup(deviceId),
    /** `fetchIfDue`, then every answer delivered. */
    fetch: (consent: RemoteConsent = 'granted'): void => {
      client.fetchIfDue(consent);
      test.scheduler.runUntilIdle();
    },
    /** Lines of `code` at its own level. */
    count: (issue: IssueCode): number =>
      logger.lines.filter((line) => line.level !== 'debug' && line.message.startsWith(`${issue}:`)).length,
  };
}

function stored(test: TestPlatform): Record<string, unknown> | undefined {
  const text = test.storage.area.entries.get(REMOTE_KEY);
  return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
}

function save(test: TestPlatform, record: Record<string, unknown>): void {
  test.storage.area.entries.set(REMOTE_KEY, JSON.stringify({ v: 1, ...record }));
}

const NOW = TestClock.DEFAULT_START;
const LONG_AGO = NOW - REMOTE_FETCH_INTERVAL_MS - 1;

describe('the client', () => {
  it('200 saves the values, the ETag and the fetch time for the next page load', () => {
    const test = new TestPlatform();
    const page = openPage(test);
    test.transport.enqueue(ok('{"flush_at":60}'));

    page.fetch();

    expect(test.transport.requests).toHaveLength(1);
    const request = test.transport.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(CONFIG_URL);
    expect(request?.headers).toEqual({ Authorization: `Bearer ${API_KEY}` });
    expect(request?.body).toBeUndefined();
    expect(stored(test)).toEqual({ v: 1, etag: '"v1"', values: { flush_at: 60 }, fetched_at: NOW });
  });

  it('a later page load applies the saved values', () => {
    const test = new TestPlatform();
    test.transport.enqueue(ok('{"flush_at":60,"autocapture_off":["page_views"]}'));
    openPage(test).fetch();

    const effective = openPage(test.otherPage()).start();

    expect(effective.snapshot.flushAt).toBe(60);
    expect(effective.snapshot.autocapture.has('page_views')).toBe(false);
    expect(effective.collecting).toBe(true);
  });

  it('the saved ETag is sent, and 304 keeps the values and records the fetch time', () => {
    const test = new TestPlatform();
    save(test, { etag: '"v1"', values: { flush_at: 60 }, fetched_at: LONG_AGO });
    test.transport.enqueue(responseOutcome(304));
    const page = openPage(test);

    page.fetch();

    expect(test.transport.requests[0]?.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      'If-None-Match': '"v1"',
    });
    expect(stored(test)).toEqual({ v: 1, etag: '"v1"', values: { flush_at: 60 }, fetched_at: NOW });
    expect(page.count('REMOTE_CONFIG_FAILED')).toBe(0);
  });

  it('a 304 after another page replaced the record leaves the newer record', () => {
    const test = new TestPlatform();
    save(test, { etag: '"v1"', values: { flush_at: 60 }, fetched_at: LONG_AGO });
    test.transport.enqueue({ outcome: responseOutcome(304), delayMs: 1_000 });
    const page = openPage(test);
    page.client.fetchIfDue('granted');
    save(test, { etag: '"v2"', values: { flush_at: 70 }, fetched_at: NOW });

    test.scheduler.advanceBy(1_000);

    expect(stored(test)).toEqual({ v: 1, etag: '"v2"', values: { flush_at: 70 }, fetched_at: NOW });
  });

  it('404 means no remote values and deletes the saved ones, so the next page load requests again', () => {
    const test = new TestPlatform();
    save(test, { etag: '"v1"', values: { flush_at: 60 }, fetched_at: LONG_AGO });
    test.transport.enqueue(responseOutcome(404));
    const page = openPage(test);

    page.fetch();

    expect(stored(test)).toBeUndefined();
    expect(page.count('REMOTE_CONFIG_FAILED')).toBe(0);
    const other = test.otherPage();
    const next = openPage(other);
    expect(next.start().snapshot.flushAt).toBe(30);
    next.fetch();
    expect(test.transport.requests).toHaveLength(1);
    expect(other.transport.requests).toHaveLength(1);
    expect(other.transport.requests[0]?.headers['If-None-Match']).toBeUndefined();
  });

  it('404 leaves a record this SDK cannot read, and one held while consent is refused', () => {
    const test = new TestPlatform();
    test.storage.area.entries.set(REMOTE_KEY, '{"v":2,"values":{}}');
    test.transport.enqueue(responseOutcome(404));
    openPage(test).fetch();
    expect(test.storage.area.entries.get(REMOTE_KEY)).toBe('{"v":2,"values":{}}');

    const refused = new TestPlatform();
    save(refused, { values: { flush_at: 60 }, fetched_at: LONG_AGO });
    refused.transport.enqueue({ outcome: responseOutcome(404), delayMs: 1_000 });
    const page = openPage(refused);
    page.client.fetchIfDue('granted');
    page.stores.accessLevel = 'consent';
    refused.scheduler.advanceBy(1_000);
    expect(stored(refused)).toEqual({ v: 1, values: { flush_at: 60 }, fetched_at: LONG_AGO });
  });

  it('5xx, a network failure or a malformed body keep the last valid values, with a warning in each page', () => {
    const test = new TestPlatform();
    const saved = { etag: '"v1"', values: { flush_at: 60 }, fetched_at: LONG_AGO };
    save(test, saved);
    test.transport.enqueue(responseOutcome(503), rejectedOutcome(fetchTypeError()), ok('<html>'), responseOutcome(200));
    const logger = new RecordingLogger();

    for (let i = 0; i < 4; i += 1) openPage(test, { logger }).fetch();

    expect(test.transport.requests).toHaveLength(4);
    expect(stored(test)).toEqual({ v: 1, ...saved });
    expect(
      logger.lines.filter((line) => line.level === 'warn' && line.message.startsWith('REMOTE_CONFIG_FAILED')),
    ).toHaveLength(4);
  });

  it('after a failure the next page load tries again and warns again', () => {
    const test = new TestPlatform();
    test.transport.enqueue(responseOutcome(500));
    const first = openPage(test);
    first.fetch();

    const other = test.otherPage();
    other.transport.enqueue(ok('{}'));
    const second = openPage(other);
    second.fetch();

    expect(first.count('REMOTE_CONFIG_FAILED')).toBe(1);
    expect(test.transport.requests).toHaveLength(1);
    expect(other.transport.requests).toHaveLength(1);
    expect(stored(test)).toEqual({ v: 1, etag: '"v1"', values: {}, fetched_at: NOW });
  });

  it('a request that never answers is a timeout after 45 seconds and keeps the saved values', () => {
    const test = new TestPlatform();
    save(test, { values: { flush_at: 60 }, fetched_at: LONG_AGO });
    test.transport.enqueue({ outcome: responseOutcome(200), delayMs: Infinity });
    const page = openPage(test);

    page.client.fetchIfDue('granted');
    test.scheduler.advanceBy(REQUEST_TIMEOUT_MS);

    expect(page.count('REMOTE_CONFIG_FAILED')).toBe(1);
    expect(page.logger.lines.some((line) => line.message.includes('(timeout)'))).toBe(true);
    expect(stored(test)).toEqual({ v: 1, values: { flush_at: 60 }, fetched_at: LONG_AGO });
  });

  it('a redirect is HTTP_REDIRECT and a failed fetch', () => {
    const test = new TestPlatform();
    test.transport.enqueue(opaqueRedirectOutcome());
    const page = openPage(test);

    page.fetch();

    expect(page.count('HTTP_REDIRECT')).toBe(1);
    expect(page.count('REMOTE_CONFIG_FAILED')).toBe(1);
    expect(stored(test)).toBeUndefined();
  });

  it('the kill switch stops collection at once and stays off at the next page load', () => {
    const test = new TestPlatform();
    test.transport.enqueue(ok('{"enabled":false}'));
    const page = openPage(test);
    page.start();

    page.fetch();

    expect(page.flags.collecting).toBe(false);
    const next = openPage(test.otherPage());
    expect(next.start().collecting).toBe(false);
    expect(next.flags.collecting).toBe(false);
  });

  it('switching collection back on waits for the next page load', () => {
    const test = new TestPlatform();
    save(test, { values: { enabled: false }, fetched_at: LONG_AGO });
    const running = openPage(test);
    expect(running.start().collecting).toBe(false);
    test.transport.enqueue(ok('{"enabled":true}'));

    running.fetch();

    expect(running.flags.collecting).toBe(false);
    expect(openPage(test.otherPage()).start().collecting).toBe(true);
  });

  it('switching off network requests applies at once, other types at the next page load', () => {
    const test = new TestPlatform();
    test.transport.enqueue(ok('{"autocapture_off":["network_requests","page_views"]}'));
    const running = openPage(test);
    const before = running.start();

    running.fetch();

    expect(running.flags.capturingNetworkRequests).toBe(false);
    expect(running.flags.collecting).toBe(true);
    expect(before.snapshot.autocapture.has('page_views')).toBe(true);
    expect(openPage(test.otherPage()).start().snapshot.autocapture.has('page_views')).toBe(false);
  });

  it('network requests switched off in code clear the flag at startup', () => {
    const page = openPage(new TestPlatform(), { code: code({ autocapture: { enabled: ['sessions', 'page_views'] } }) });

    page.start();

    expect(page.flags.capturingNetworkRequests).toBe(false);
  });

  it('a device outside the sample rate collects nothing', () => {
    const test = new TestPlatform();
    save(test, { values: { sample_rate: 0 } });
    const page = openPage(test);

    const effective = page.start();

    expect(effective.collecting).toBe(false);
    expect(page.flags.collecting).toBe(false);
    expect(page.logger.lines.some((line) => line.level === 'info' && line.message.includes('sample rate'))).toBe(true);
  });

  it('diagnostics follow the code switch and their own sample rate', () => {
    const test = new TestPlatform();
    expect(openPage(test).start().sendsDiagnostics).toBe(true);
    save(test, { values: { diagnostics_sample_rate: 0 } });
    expect(openPage(test).start().sendsDiagnostics).toBe(false);
    expect(
      openPage(new TestPlatform(), { code: code({ logging: { sendDiagnostics: false } }) }).start().sendsDiagnostics,
    ).toBe(false);
  });

  it('saved values are validated again against the code of this page load', () => {
    const test = new TestPlatform();
    save(test, { values: { flush_at: 30 } });

    const stricter = openPage(test, { code: code({ flush: { at: 50 } }) }).start();

    expect(stricter.snapshot.flushAt).toBe(50);
  });
});

describe('the five-minute interval shared by the tabs (Web Configuration 5)', () => {
  it('two pages within five minutes make one request', () => {
    const test = new TestPlatform();
    test.transport.enqueue(ok('{"flush_at":60}'));
    openPage(test).fetch();
    test.clock.advanceBy(4 * 60_000);
    const other = test.otherPage();

    const second = openPage(other);
    const effective = second.start();
    second.fetch();

    expect(test.transport.requests).toHaveLength(1);
    expect(other.transport.requests).toHaveLength(0);
    expect(effective.snapshot.flushAt).toBe(60);
    expect(second.logger.lines.some((line) => line.message.includes('less than five minutes ago'))).toBe(true);
  });

  it('a page load more than five minutes later requests again with the ETag', () => {
    const test = new TestPlatform();
    save(test, { etag: '"v1"', values: {}, fetched_at: NOW });

    test.clock.set(NOW + REMOTE_FETCH_INTERVAL_MS);
    openPage(test).fetch();
    expect(test.transport.requests).toHaveLength(0);

    test.clock.set(NOW + REMOTE_FETCH_INTERVAL_MS + 1);
    openPage(test).fetch();
    expect(test.transport.requests).toHaveLength(1);
    expect(test.transport.requests[0]?.headers['If-None-Match']).toBe('"v1"');
  });

  it('two pages that load before either is answered both request, and the later answer is kept', () => {
    const test = new TestPlatform();
    const other = test.otherPage();
    test.transport.enqueue({ outcome: ok('{"flush_at":60}', '"a"'), delayMs: 100 });
    other.transport.enqueue({ outcome: ok('{"flush_at":70}', '"b"'), delayMs: 200 });

    openPage(test).client.fetchIfDue('granted');
    openPage(other).client.fetchIfDue('granted');
    test.scheduler.advanceBy(200);

    expect(test.transport.requests.length + other.transport.requests.length).toBe(2);
    expect(stored(test)).toEqual({ v: 1, etag: '"b"', values: { flush_at: 70 }, fetched_at: NOW + 200 });
  });

  it('a page requests at most once, whatever calls follow', () => {
    const test = new TestPlatform();
    test.transport.enqueue(responseOutcome(500));
    const page = openPage(test);

    page.fetch();
    test.clock.advanceBy(REMOTE_FETCH_INTERVAL_MS * 2);
    page.fetch();
    page.fetch();

    expect(test.transport.requests).toHaveLength(1);
  });

  it('a fetch time later than now, after the clock was set back, does not hold the request back', () => {
    const test = new TestPlatform();
    save(test, { values: {}, fetched_at: NOW + 86_400_000 });
    test.transport.enqueue(ok('{}'));

    openPage(test).fetch();

    expect(test.transport.requests).toHaveLength(1);
    expect(stored(test)).toEqual({ v: 1, etag: '"v1"', values: {}, fetched_at: NOW });
  });

  it('an unreadable record is never overwritten, so every page load requests', () => {
    const test = new TestPlatform();
    test.storage.area.entries.set(REMOTE_KEY, '{"v":2,"values":{}}');
    test.transport.enqueue(ok('{"enabled":false}'), ok('{}'));

    const first = openPage(test);
    first.fetch();
    openPage(test.otherPage()).fetch();

    expect(test.storage.area.entries.get(REMOTE_KEY)).toBe('{"v":2,"values":{}}');
    expect(first.flags.collecting).toBe(false);
    expect(first.count('STORE_UNREADABLE')).toBe(1);
  });

  it('a save that fails keeps the stop flags and leaves the next page load to fetch', () => {
    const test = new TestPlatform();
    test.storage.failWrites = true;
    test.transport.enqueue(ok('{"enabled":false}'));
    const page = openPage(test);

    page.fetch();

    expect(page.flags.collecting).toBe(false);
    expect(page.count('STORAGE_WRITE_FAILED')).toBe(1);
    expect(stored(test)).toBeUndefined();
  });
});

describe('consent (Web Privacy 1, Web Logging 4)', () => {
  it('no request while consent is pending or refused, and one after optIn()', () => {
    const test = new TestPlatform();
    const page = openPage(test, { access: 'consent' });
    page.start();

    page.fetch('pending');
    page.fetch('denied');
    expect(test.transport.requests).toHaveLength(0);
    expect(test.storage.area.entries.size).toBe(0);

    page.stores.accessLevel = 'full';
    test.transport.enqueue(ok('{}', null));
    page.fetch('granted');

    expect(test.transport.requests).toHaveLength(1);
    expect(stored(test)).toEqual({ v: 1, values: {}, fetched_at: NOW });
  });

  it('a pending page reads nothing of .remote, and the saved stop flags apply at optIn()', () => {
    const test = new TestPlatform();
    save(test, { values: { enabled: false, autocapture_off: ['network_requests'], flush_at: 60 }, fetched_at: NOW });
    const page = openPage(test, { access: 'consent' });

    const effective = page.start();
    expect(effective.collecting).toBe(true);
    expect(effective.snapshot.flushAt).toBe(30);

    page.stores.accessLevel = 'full';
    page.fetch('granted');

    expect(test.transport.requests).toHaveLength(0);
    expect(page.flags.collecting).toBe(false);
    expect(page.flags.capturingNetworkRequests).toBe(false);
  });

  it('an answer that arrives after an opt-out is not stored', () => {
    const test = new TestPlatform();
    test.transport.enqueue({ outcome: ok('{"flush_at":60}'), delayMs: 1_000 });
    const page = openPage(test);
    page.client.fetchIfDue('granted');

    page.stores.accessLevel = 'consent';
    test.scheduler.advanceBy(1_000);

    expect(test.transport.inFlight).toBe(0);
    expect(test.storage.area.entries.size).toBe(0);
  });
});

describe('the page and the log', () => {
  it('no request to a host the page blocks as mixed content (Web HTTP 3)', () => {
    const test = new TestPlatform();
    const page = openPage(test, { code: code({}, 'blocked') });

    page.fetch();

    expect(test.transport.requests).toHaveLength(0);
  });

  it('no line holds the body, the ETag, the key or a header value', () => {
    const test = new TestPlatform();
    test.transport.enqueue(ok('<html>token-123</html>', '"etag-secret"'));
    const page = openPage(test, { code: code({ network: { headers: { 'X-Gateway': 'gw-secret' } } }) });

    page.start();
    page.fetch();

    expect(test.transport.requests[0]?.headers['X-Gateway']).toBe('gw-secret');
    for (const line of page.logger.lines) {
      for (const secret of ['token-123', 'etag-secret', API_KEY, 'gw-secret'])
        expect(line.message).not.toContain(secret);
    }
    expect(page.count('REMOTE_CONFIG_FAILED')).toBe(1);
  });

  it('a throwing transport is a failed fetch and never reaches the caller', () => {
    const test = new TestPlatform();
    const logger = new RecordingLogger();
    const log = new Log({ level: 'debug', debug: false, logger: logger.logger, sink: NO_OP_SINK });
    const stores = new Stores({ keyHash: KEY_HASH, storage: test.storage, log, clock: test.clock });
    const http = new HttpClient({
      transport: {
        send() {
          throw new Error('boom');
        },
      },
      scheduler: test.scheduler,
      clock: test.clock,
      network: test.network,
      urls: test.platform.urls,
      log,
    });
    const client = new RemoteConfigClient({
      code: code(),
      store: stores.remote,
      http,
      flags: new RuntimeFlags(),
      clock: test.clock,
      log,
    });

    expect(() => {
      client.fetchIfDue('granted');
      test.scheduler.runUntilIdle();
    }).not.toThrow();
    expect(logger.lines.some((line) => line.message.startsWith('REMOTE_CONFIG_FAILED'))).toBe(true);
  });

  it('storage that throws on every access leaves the code alone and still fetches', () => {
    const test = new TestPlatform();
    test.storage.failAccess = true;
    test.transport.enqueue(ok('{"enabled":false}'));
    const page = openPage(test);

    expect(() => {
      page.start();
      page.fetch();
    }).not.toThrow();
    expect(test.transport.requests).toHaveLength(1);
    expect(page.flags.collecting).toBe(false);
  });
});
