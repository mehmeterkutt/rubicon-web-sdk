import { coreOf, createCore, createNoOpAnalytics, keyHash, shutdown, storeKey } from 'rubicon-analytics-core';
import type { Analytics, AutomaticCapture, Event, Log } from 'rubicon-analytics-core';
import { golden, RecordingSink, TestPlatform } from 'rubicon-analytics-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createTrackedFetch } from '../../src';
import type { TrackedFetchOptions } from '../../src';
import { parseHostPatterns } from '../../src/network/host-patterns';
import { networkErrorOf, requestBytesOf } from '../../src/network/network-request';
import { createTracker, resolveRequest } from '../../src/network/tracked-fetch';

// `createTrackedFetch` of step 7.7 (Web Lifecycle 6, Web HTTP 3, Privacy 5c; Android log 7.6) in jsdom:
// the core over the virtual-time `TestPlatform`, events observed through a `beforeSend` hook, and the
// base `fetch` a fake per test that answers with Node's own `Response`. The Android
// `RubiconNetworkInterceptorTest` cases are ported here; the engines run the same function, and
// axios with its fetch adapter, in test/browser/tracked-fetch.spec.ts.

interface Reconfigurable {
  reconfigure(options: { url: string }): void;
}

const API_KEY = 'rk_tracked_fetch';
const HOST = 'api.shop.example.com';
const jsdomUrl = location.href;
const pages: Analytics[] = [];
const replaced = new Map<string, PropertyDescriptor | undefined>();

afterEach(() => {
  for (const analytics of pages.splice(0)) shutdown(analytics);
  for (const [name, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  replaced.clear();
  goTo(jsdomUrl);
});

function goTo(url: string): void {
  (Reflect.get(globalThis, 'jsdom') as Reconfigurable).reconfigure({ url });
}

function replaceGlobal(name: string, value: unknown): void {
  if (!replaced.has(name)) replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

interface Page {
  readonly test: TestPlatform;
  readonly analytics: Analytics;
  readonly sink: RecordingSink;
  /** The `Network Request` events that reached the writer, after running every slice due now. */
  readonly requests: () => Event[];
}

/** An instance over the virtual-time platform whose remote configuration was fetched just now. */
function open(config: Record<string, unknown> = {}): Page {
  const test = new TestPlatform();
  const sink = new RecordingSink();
  const events: Event[] = [];
  test.storage.area.entries.set(
    storeKey(keyHash(API_KEY), 'remote'),
    JSON.stringify({ v: 1, values: {}, fetched_at: test.clock.now() }),
  );
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
    test.platform,
    { sink },
  );
  pages.push(analytics);
  return {
    test,
    analytics,
    sink,
    requests: () => {
      test.scheduler.runUntilIdle();
      return events.filter((event) => event.type === 'track' && event.name === 'Network Request');
    },
  };
}

interface FetchCall {
  readonly args: unknown[];
  readonly self: unknown;
}

/** A recording base `fetch`; its answer each test decides, by default an empty 200. */
function fakeFetch(answer: (call: FetchCall) => unknown = () => Promise.resolve(new Response(null))): {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const base = function (this: unknown, ...args: unknown[]): unknown {
    const call = { args, self: this };
    calls.push(call);
    return answer(call);
  } as unknown as typeof fetch;
  return { fetch: base, calls };
}

function tracked(page: Page, base: typeof fetch, options: Partial<TrackedFetchOptions> = {}): typeof fetch {
  return createTrackedFetch(page.analytics, { hosts: [HOST], fetch: base, ...options });
}

function propertiesOf(event: Event | undefined): Record<string, unknown> | undefined {
  return event?.type === 'track' ? event.properties : undefined;
}

describe('the event (Lifecycle 1, Privacy 5c, Android log 7.6)', () => {
  it('carries the decided fields, without query or fragment, ids masked', async () => {
    const page = open();
    const base = fakeFetch(() =>
      Promise.resolve(new Response('hello', { status: 200, headers: { 'Content-Length': '5' } })),
    );

    const response = await tracked(page, base.fetch)(`https://${HOST}/users/12345/orders?token=secret#frag`, {
      method: 'POST',
      body: new Blob(['abc']),
      headers: { Authorization: 'Bearer secret' },
    });

    expect(await response.text()).toBe('hello');
    const [event] = page.requests();
    expect(page.requests()).toHaveLength(1);
    expect(event).toMatchObject({ type: 'track', name: 'Network Request', source: 'auto' });
    expect(propertiesOf(event)).toEqual({
      method: 'POST',
      url: `https://${HOST}/users/:id/orders`,
      host: HOST,
      path: '/users/:id/orders',
      status_code: 200,
      duration_ms: 0,
      request_bytes: 3,
      response_bytes: 5,
    });
    expect(Object.keys(propertiesOf(event) ?? {})).toEqual([
      'method',
      'url',
      'host',
      'path',
      'status_code',
      'duration_ms',
      'request_bytes',
      'response_bytes',
    ]);
    expect(JSON.stringify(event)).not.toMatch(/secret|frag/);
  });

  it('gives the properties of the golden file', async () => {
    const page = open();
    const file = golden('network-request');
    const base = fakeFetch(() => {
      page.test.clock.advanceBy(184);
      return Promise.resolve(new Response(new Uint8Array(5120), { headers: { 'Content-Length': '5120' } }));
    });

    await tracked(page, base.fetch)(`https://${HOST}/users/12345/orders?page=2#top`);

    expect(propertiesOf(page.requests()[0])).toEqual(file.properties);
  });

  it('keeps a port that is not the scheme default, and masking can be switched off', async () => {
    const page = open();
    const base = fakeFetch();

    await tracked(page, base.fetch, { maskPathIds: false })(`https://${HOST}:8443/users/12345`);
    await tracked(page, base.fetch)(`https://${HOST}:443/files/3f2a9c1e-0b1c-4d2e-8f3a-7b2d9c1e0b1c/v1`);

    expect(page.requests().map((event) => propertiesOf(event)?.url)).toEqual([
      `https://${HOST}:8443/users/12345`,
      `https://${HOST}/files/:id/v1`,
    ]);
  });

  it('measures the duration to the response on the platform clock, never below zero', async () => {
    const page = open();
    let step = 250;
    const base = fakeFetch(() => {
      page.test.clock.advanceBy(step);
      return Promise.resolve(new Response(null));
    });
    const trackedFetch = tracked(page, base.fetch);

    await trackedFetch(`https://${HOST}/a`);
    step = -1000;
    await trackedFetch(`https://${HOST}/b`);

    expect(page.requests().map((event) => propertiesOf(event)?.duration_ms)).toEqual([250, 0]);
  });
});

describe('behaviour equivalence (Web Lifecycle 6)', () => {
  it('returns a 404 untouched, as the same Response and not an error', async () => {
    const page = open();
    const notFound = new Response('missing', { status: 404 });
    const base = fakeFetch(() => Promise.resolve(notFound));

    const response = await tracked(page, base.fetch)(`https://${HOST}/nothing`);

    expect(response).toBe(notFound);
    expect(await response.text()).toBe('missing');
    expect(propertiesOf(page.requests()[0])).toMatchObject({ status_code: 404 });
    expect(propertiesOf(page.requests()[0])).not.toHaveProperty('error');
  });

  it('rethrows an abort as the same error object, recorded as canceled', async () => {
    const page = open();
    const controller = new AbortController();
    const base = fakeFetch(
      (call) =>
        new Promise((_resolve, reject) => {
          const init = call.args[1] as RequestInit;
          init.signal?.addEventListener('abort', () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the signal's reason, as fetch rejects with it.
            reject(init.signal?.reason);
          });
        }),
    );

    const pending = tracked(page, base.fetch)(`https://${HOST}/slow`, { signal: controller.signal });
    controller.abort();

    const error: unknown = await pending.catch((reason: unknown) => reason);
    expect(error).toBe(controller.signal.reason);
    expect(base.calls[0]?.args[1]).toMatchObject({ signal: controller.signal });
    expect(propertiesOf(page.requests()[0])).toMatchObject({ error: 'canceled' });
    expect(propertiesOf(page.requests()[0])).not.toHaveProperty('status_code');
    expect(propertiesOf(page.requests()[0])).not.toHaveProperty('response_bytes');
  });

  it('passes the arguments on as they are, with the window as this', async () => {
    const page = open();
    const base = fakeFetch();
    const init = { method: 'PUT', headers: { 'X-Csrf': 'token' } };
    const client = { fetch: tracked(page, base.fetch) };

    // A method call, as axios makes it through `env.fetch`: `this` is the client, never passed on.
    await client.fetch(`https://${HOST}/a`, init);
    await client.fetch(`https://${HOST}/b`);

    expect(base.calls[0]?.args).toEqual([`https://${HOST}/a`, init]);
    expect(base.calls[0]?.args[1]).toBe(init);
    expect(base.calls[1]?.args).toHaveLength(1);
    expect(base.calls.map((call) => call.self)).toEqual([window, window]);
  });

  it('reads the page fetch at every call when none is given', async () => {
    const page = open();
    const first = fakeFetch();
    const later = fakeFetch();
    replaceGlobal('fetch', first.fetch);
    const trackedFetch = createTrackedFetch(page.analytics, { hosts: [HOST] });

    await trackedFetch(`https://${HOST}/a`);
    replaceGlobal('fetch', later.fetch);
    await trackedFetch(`https://${HOST}/b`);

    expect(first.calls).toHaveLength(1);
    expect(later.calls).toHaveLength(1);
    expect(page.requests()).toHaveLength(2);
  });

  it('a base fetch that throws throws the same error, and one that returns no Promise is passed on', () => {
    const page = open();
    const failure = new TypeError('no fetch');
    const throwing = fakeFetch(() => {
      throw failure;
    });
    const plain = { answer: true };
    const odd = fakeFetch(() => plain);

    expect(() => tracked(page, throwing.fetch)(`https://${HOST}/a`)).toThrow(failure);
    expect(tracked(page, odd.fetch)(`https://${HOST}/a`)).toBe(plain);
    expect(page.requests()).toEqual([]);
  });

  it('a caught rejection leaves no unhandled one', async () => {
    const page = open();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    const base = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    try {
      await tracked(page, base.fetch)(`https://${HOST}/a`).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(unhandled).toEqual([]);
    expect(propertiesOf(page.requests()[0])).toMatchObject({ error: 'network' });
  });

  it('never reads or clones a request or response body', async () => {
    const page = open();
    const reads: string[] = [];
    const body = new Blob(['abcd']);
    for (const name of ['text', 'arrayBuffer', 'stream', 'slice', 'bytes']) {
      Object.defineProperty(body, name, {
        value: () => {
          reads.push(`request.${name}`);
          throw new Error('read');
        },
      });
    }
    const response = new Response('body', { headers: { 'Content-Length': '4' } });
    for (const name of ['text', 'json', 'arrayBuffer', 'blob', 'clone', 'formData', 'bytes']) {
      Object.defineProperty(response, name, {
        value: () => {
          reads.push(`response.${name}`);
          throw new Error('read');
        },
      });
    }
    Object.defineProperty(response, 'body', {
      get: () => {
        reads.push('response.body');
        return null;
      },
    });
    const base = fakeFetch(() => Promise.resolve(response));

    const returned = await tracked(page, base.fetch)(`https://${HOST}/upload`, { method: 'POST', body });

    expect(returned).toBe(response);
    expect(reads).toEqual([]);
    expect(propertiesOf(page.requests()[0])).toMatchObject({ request_bytes: 4, response_bytes: 4 });
  });
});

describe('the input forms (Web Lifecycle 6)', () => {
  it('takes the method from init, else the Request, else GET, upper-cased', () => {
    const request = new Request(`https://${HOST}/r`, { method: 'DELETE' });

    expect(resolveRequest(request, { method: 'patch' })?.method).toBe('PATCH');
    expect(resolveRequest(request, undefined)?.method).toBe('DELETE');
    expect(resolveRequest(`https://${HOST}/s`, {})?.method).toBe('GET');
    expect(resolveRequest(`https://${HOST}/s`, { method: 'post' })?.method).toBe('POST');
  });

  it('captures a Request input with an init.method override, without its body size', async () => {
    const page = open();
    const base = fakeFetch();
    const request = new Request(`https://${HOST}/orders/42?x=1`, { method: 'POST', body: 'text' });

    await tracked(page, base.fetch)(request, { method: 'put' });

    expect(base.calls[0]?.args[0]).toBe(request);
    expect(propertiesOf(page.requests()[0])).toMatchObject({ method: 'PUT', path: '/orders/:id' });
    expect(propertiesOf(page.requests()[0])).not.toHaveProperty('request_bytes');
  });

  it('resolves a relative URL against the page and matches its host', async () => {
    goTo(`https://${HOST}/shop/cart?step=2`);
    const page = open();
    const base = fakeFetch();
    const trackedFetch = tracked(page, base.fetch);

    await trackedFetch('items/987');
    await trackedFetch(new URL('/v2/search?q=shoes', location.href));

    expect(base.calls[0]?.args[0]).toBe('items/987');
    expect(page.requests().map((event) => propertiesOf(event)?.url)).toEqual([
      `https://${HOST}/shop/items/:id`,
      `https://${HOST}/v2/search`,
    ]);
  });

  it('passes through an input it cannot read without running the application code', async () => {
    const page = open();
    const base = fakeFetch();
    let stringified = 0;
    const odd = {
      toString(): string {
        stringified += 1;
        return `https://${HOST}/odd`;
      },
    };

    await tracked(page, base.fetch)(odd as unknown as string);
    await tracked(page, base.fetch)('http://[::1');

    expect(stringified).toBe(0);
    expect(base.calls).toHaveLength(2);
    expect(page.requests()).toEqual([]);
  });

  it('knows a body size only from a Blob, an ArrayBuffer or a view', () => {
    expect(requestBytesOf(new Blob(['abcdef']))).toBe(6);
    expect(requestBytesOf(new ArrayBuffer(8))).toBe(8);
    expect(requestBytesOf(new Uint16Array(4))).toBe(8);
    expect(requestBytesOf(new DataView(new ArrayBuffer(3)))).toBe(3);
    expect(requestBytesOf('abc')).toBeUndefined();
    expect(requestBytesOf(new URLSearchParams('a=1'))).toBeUndefined();
    expect(requestBytesOf(new FormData())).toBeUndefined();
    expect(requestBytesOf(new ReadableStream())).toBeUndefined();
    expect(requestBytesOf(null)).toBeUndefined();
    expect(requestBytesOf(undefined)).toBeUndefined();
  });

  it('takes response_bytes only from one readable Content-Length', async () => {
    const page = open();
    const answers = [
      new Response('x'),
      new Response('x', { headers: { 'Content-Length': 'abc' } }),
      new Response('x', {
        headers: [
          ['Content-Length', '1'],
          ['Content-Length', '1'],
        ],
      }),
      new Response('x', { headers: { 'Content-Length': ' 7 ' } }),
    ];
    const base = fakeFetch(() => Promise.resolve(answers.shift()));
    const trackedFetch = tracked(page, base.fetch);

    for (let index = 0; index < 4; index += 1) await trackedFetch(`https://${HOST}/r`);

    expect(page.requests().map((event) => propertiesOf(event)?.response_bytes)).toEqual([
      undefined,
      undefined,
      undefined,
      7,
    ]);
  });
});

describe('the error values (Web HTTP 3)', () => {
  it('maps the rejection by its name to a fixed value, never the name itself', async () => {
    const page = open();
    const custom = new Error('x');
    custom.name = 'user@example.com';
    const throwingName = {
      get name(): string {
        throw new Error('name');
      },
    };
    const reasons: unknown[] = [
      new DOMException('aborted', 'AbortError'),
      new DOMException('timed out', 'TimeoutError'),
      new TypeError('Failed to fetch'),
      custom,
      throwingName,
      'text',
      null,
    ];
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a base fetch may reject with anything.
    const base = fakeFetch(() => Promise.reject(reasons[base.calls.length - 1]));
    const trackedFetch = tracked(page, base.fetch);

    for (const reason of reasons) {
      expect(await trackedFetch(`https://${HOST}/r`).catch((error: unknown) => error)).toBe(reason);
    }

    expect(page.requests().map((event) => propertiesOf(event)?.error)).toEqual([
      'canceled',
      'timeout',
      'network',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(JSON.stringify(page.requests())).not.toContain('user@example.com');
  });

  it('compares names as strings, so an error of another realm maps too', () => {
    expect(networkErrorOf({ name: 'TypeError' })).toBe('network');
    expect(networkErrorOf({ name: 'AbortError' })).toBe('canceled');
  });
});

describe('the hosts (Privacy 5c, Android log 7.6)', () => {
  it('match exactly or by a leading wildcard, ignoring case', () => {
    const patterns = parseHostPatterns(['API.shop.com', '*.cdn.example.com'], undefined);

    expect(patterns.matches('api.shop.com')).toBe(true);
    expect(patterns.matches('Api.Shop.Com')).toBe(true);
    expect(patterns.matches('img.shop.com')).toBe(false);
    expect(patterns.matches('shop.com')).toBe(false);
    expect(patterns.matches('eu.cdn.example.com')).toBe(true);
    expect(patterns.matches('a.b.cdn.example.com')).toBe(true);
    expect(patterns.matches('cdn.example.com')).toBe(false);
    expect(patterns.matches('evilcdn.example.com')).toBe(false);
  });

  it('an unconfigured host is not captured', async () => {
    const page = open();
    const base = fakeFetch();

    await createTrackedFetch(page.analytics, { hosts: ['api.shop.com', '*.shop.com'], fetch: base.fetch })(
      `https://${HOST}/`,
    );

    expect(base.calls).toHaveLength(1);
    expect(page.requests()).toEqual([]);
  });

  it("the SDK's own host is never captured", async () => {
    const page = open({ host: 'https://collect.shop.example.com' });
    const base = fakeFetch();

    await createTrackedFetch(page.analytics, { hosts: ['*.shop.example.com'], fetch: base.fetch })(
      'https://COLLECT.shop.example.com/v1/batch',
    );
    await createTrackedFetch(page.analytics, { hosts: ['*.shop.example.com'], fetch: base.fetch })(`https://${HOST}/a`);

    expect(page.requests().map((event) => propertiesOf(event)?.host)).toEqual([HOST]);
  });

  describe('an invalid pattern is ignored with INVALID_CAPTURE_HOST, a developer error never thrown', () => {
    const invalid = [
      '*.com',
      'https://api.shop.com',
      'api.shop.com/v1',
      'api.shop.com:443',
      '*api.shop.com',
      '',
      'api.*.com',
    ];

    it('with debug: false, a WARN naming the position, never the pattern', async () => {
      const page = open();
      const base = fakeFetch();

      for (const pattern of invalid) {
        const trackedFetch = createTrackedFetch(page.analytics, { hosts: [pattern], fetch: base.fetch });
        await trackedFetch('https://api.shop.com/');
      }

      expect(page.requests()).toEqual([]);
      expect(base.calls).toHaveLength(invalid.length);
      // `per_page`: the first at WARN, the others at DEBUG, which the default level does not write.
      expect(page.sink.lines).toEqual([
        {
          level: 'warn',
          message:
            'INVALID_CAPTURE_HOST: hosts[0] of createTrackedFetch is invalid: use a host name such as ' +
            'api.shop.com or a wildcard such as *.shop.com; it is ignored',
          developerErrorForm: false,
        },
      ]);
    });

    it('with debug: true, the developer-error form, and nothing thrown', () => {
      const page = open({ debug: true });

      expect(() =>
        createTrackedFetch(page.analytics, { hosts: ['api.shop.com', 'https://api.shop.com'] }),
      ).not.toThrow();

      expect(page.sink.lines).toEqual([
        {
          level: 'error',
          message: expect.stringMatching(/^INVALID_CAPTURE_HOST: hosts\[1\] /) as unknown,
          developerErrorForm: true,
        },
      ]);
    });

    it('with logging.level "off", nothing', () => {
      const page = open({ debug: true, logging: { level: 'off', sendDiagnostics: false } });

      createTrackedFetch(page.analytics, { hosts: ['*.com'] });

      expect(page.sink.lines).toEqual([]);
    });

    it('a hosts that is not an array, or an element that is not a string, captures nothing there', async () => {
      const page = open({ logging: { level: 'debug', sendDiagnostics: false } });
      const base = fakeFetch();
      const options = (hosts: unknown): TrackedFetchOptions => ({ hosts: hosts as string[], fetch: base.fetch });

      await createTrackedFetch(page.analytics, options(new Set([HOST])))(`https://${HOST}/`);
      await createTrackedFetch(page.analytics, options([42, null, HOST]))(`https://${HOST}/`);

      expect(page.requests()).toHaveLength(1);
      expect(page.sink.messages.filter((message) => message.includes('INVALID_CAPTURE_HOST'))).toEqual([
        'INVALID_CAPTURE_HOST: hosts of createTrackedFetch is not an array of host names; nothing is captured',
        expect.stringMatching(/hosts\[0\] /) as unknown,
        expect.stringMatching(/hosts\[1\] /) as unknown,
      ]);
    });
  });
});

describe('the gate (Web Lifecycle 6, 8)', () => {
  it('passes through without measuring while capture is off', async () => {
    const page = open({ autocapture: { enabled: ['sessions'] } });
    const base = fakeFetch();

    await tracked(page, base.fetch)(`https://${HOST}/a`);

    expect(base.calls).toHaveLength(1);
    expect(page.requests()).toEqual([]);
  });

  it('a remote switch-off during a request sends nothing for it, and applies to the next', async () => {
    const page = open();
    let answer: (response: Response) => void = () => undefined;
    const base = fakeFetch(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const trackedFetch = tracked(page, base.fetch);

    const pending = trackedFetch(`https://${HOST}/a`);
    coreOf(page.analytics)?.flags.stopCapturingNetworkRequests();
    answer(new Response(null));
    await pending;
    const next = trackedFetch(`https://${HOST}/b`);
    answer(new Response(null));
    await next;

    expect(page.requests()).toEqual([]);
  });

  it('an opt-out during a request sends nothing for it', async () => {
    const page = open();
    let answer: (response: Response) => void = () => undefined;
    const base = fakeFetch(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );

    const pending = tracked(page, base.fetch)(`https://${HOST}/a`);
    page.analytics.optOut();
    answer(new Response(null));
    await pending;

    expect(page.requests()).toEqual([]);
  });

  it('reads the flag once at the start and once before the event, and measures nothing when off', () => {
    const reads: string[] = [];
    let on = true;
    const tracks: unknown[] = [];
    const capture = {
      get capturesNetworkRequests() {
        reads.push('flag');
        return on;
      },
      now() {
        reads.push('now');
        return 0;
      },
      sdkHost: 'api.rubicon.example',
      track(...args: unknown[]) {
        tracks.push(args);
      },
    } as unknown as AutomaticCapture;
    const tracker = createTracker(capture, parseHostPatterns([HOST], undefined), true);

    on = false;
    expect(tracker.begin(`https://${HOST}/a`, undefined)).toBeUndefined();
    expect(reads).toEqual(['flag']);
    on = true;
    reads.length = 0;
    tracker.begin(`https://${HOST}/a`, undefined)?.end({ kind: 'response', response: new Response(null) });

    expect(reads).toEqual(['flag', 'now', 'flag', 'now']);
    expect(tracks).toHaveLength(1);
  });

  it('passes through for the no-op and for an object that is not an instance of the SDK', async () => {
    const base = fakeFetch();
    const fake = { ...createNoOpAnalytics() };

    await createTrackedFetch(createNoOpAnalytics(), { hosts: [HOST], fetch: base.fetch })(`https://${HOST}/a`);
    await createTrackedFetch(fake, { hosts: [HOST], fetch: base.fetch })(`https://${HOST}/b`);

    expect(base.calls).toHaveLength(2);
  });
});

describe('never crash the host (root CLAUDE.md, non-negotiable 1)', () => {
  it('a throwing capture still returns the response, and a recording that fails throws nothing', () => {
    const throwing = {
      get capturesNetworkRequests(): boolean {
        throw new Error('flag');
      },
    } as unknown as AutomaticCapture;
    const tracking = {
      capturesNetworkRequests: true,
      sdkHost: 'api.rubicon.example',
      now: () => 0,
      track: () => {
        throw new Error('track');
      },
      log: undefined as unknown as Log,
    } as unknown as AutomaticCapture;
    const response = new Response('intact');

    expect(createTracker(throwing, parseHostPatterns([HOST], undefined), true).begin(`https://${HOST}/`, {})).toBe(
      undefined,
    );
    const recording = createTracker(tracking, parseHostPatterns([HOST], undefined), true).begin(`https://${HOST}/`, {});
    expect(() => {
      recording?.end({ kind: 'response', response });
    }).not.toThrow();
    expect(recording).toBeDefined();
  });

  it('options that throw when read give a pass-through', async () => {
    const page = open();
    const base = fakeFetch();
    replaceGlobal('fetch', base.fetch);
    const options = new Proxy(
      {},
      {
        get() {
          throw new Error('options');
        },
      },
    ) as TrackedFetchOptions;

    const trackedFetch = createTrackedFetch(page.analytics, options);
    await trackedFetch(`https://${HOST}/a`);

    expect(base.calls).toHaveLength(1);
    expect(page.requests()).toEqual([]);
  });

  it('options that are missing, or a fetch option that is not a function, use the defaults', async () => {
    const page = open();
    const base = fakeFetch();
    replaceGlobal('fetch', base.fetch);

    await createTrackedFetch(page.analytics, undefined as unknown as TrackedFetchOptions)(`https://${HOST}/a`);
    await createTrackedFetch(page.analytics, { hosts: [HOST], fetch: 'fetch' as unknown as typeof fetch })(
      `https://${HOST}/b`,
    );

    expect(base.calls).toHaveLength(2);
    expect(page.requests().map((event) => propertiesOf(event)?.path)).toEqual(['/b']);
  });
});
