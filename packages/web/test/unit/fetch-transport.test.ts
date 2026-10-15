import { gunzipSync } from 'node:zlib';
import type { HttpOutcome, HttpRequest } from 'rubicon-analytics-core';
import { batchRequest, configRequest } from 'rubicon-analytics-core';
import { TestScheduler } from 'rubicon-analytics-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { hasBrokenCompression } from '../../src/platform/compression';
import { createFetchTransport } from '../../src/platform/fetch-transport';

// The `fetch` transport of step 7.3 (Web HTTP 1 to 3) in jsdom, with `fetch` replaced by a recording
// fake per test: the options and headers of every request, gzip and when it is skipped, what each
// kind of response and rejection is reported as, once and never inside `send`. The engines run the
// same transport against the test server in `test/browser/fetch-transport.spec.ts`.

const SAFARI_16_4 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15';
const CONFIG = {
  apiKey: 'rk_transport',
  batchUrl: 'https://api.rubicon.example/v1/batch',
  configUrl: 'https://api.rubicon.example/v1/config',
  headers: { 'X-Gateway-Token': 'gw' },
};
const LINES = ['{"type":"track","event":"Bought","message_id":"m1","properties":{"name":"Çiğdem"}}'];

function upload(options: { keepalive?: boolean; closing?: boolean } = {}): HttpRequest {
  return batchRequest(CONFIG, {
    sentAt: 1,
    lines: LINES,
    keepalive: options.keepalive ?? false,
    closing: options.closing ?? false,
  });
}

const replaced = new Map<string, PropertyDescriptor | undefined>();

function replaceGlobal(name: string, value: unknown): void {
  if (!replaced.has(name)) replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterEach(() => {
  for (const [name, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  replaced.clear();
});

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly self: unknown;
}

/** A recording `fetch` whose answer each test decides; the default never answers. */
function fakeFetch(answer: (call: FetchCall) => Promise<unknown> = () => new Promise(() => undefined)): FetchCall[] {
  const calls: FetchCall[] = [];
  replaceGlobal('fetch', function (this: unknown, url: string, init: RequestInit) {
    const call = { url, init, self: this };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

interface FakeResponseOptions {
  readonly type?: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly bodyFails?: boolean;
}

/** A `Response` as `fetch` gives it, counting reads of the body. */
function fakeResponse(options: FakeResponseOptions = {}): {
  readonly response: Response;
  readonly reads: () => number;
} {
  let reads = 0;
  const response = {
    type: options.type ?? 'cors',
    status: options.status ?? 200,
    headers: new Headers(options.headers ?? {}),
    text: () => {
      reads += 1;
      return options.bodyFails === true ? Promise.reject(new TypeError('body')) : Promise.resolve(options.body ?? '');
    },
  } as unknown as Response;
  return { response, reads: () => reads };
}

/** Lets the Promise and stream jobs of a request run: whole turns of the event loop, no timed wait. */
async function settle(until: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !until(); turn += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

function send(request: HttpRequest, scheduler = new TestScheduler()): { outcomes: HttpOutcome[]; abort: () => void } {
  const outcomes: HttpOutcome[] = [];
  const call = createFetchTransport(scheduler).send(request, (outcome) => outcomes.push(outcome));
  return {
    outcomes,
    abort: () => {
      call.abort();
    },
  };
}

describe('the request (Web HTTP 1)', () => {
  it('is a cors fetch without credentials, redirects, referrer or cache, at low priority, with the core headers', () => {
    replaceGlobal('CompressionStream', undefined);
    const calls = fakeFetch();
    send(upload({ keepalive: true }));

    expect(calls).toHaveLength(1);
    const { url, init, self } = calls[0] as FetchCall;
    expect(url).toBe('https://api.rubicon.example/v1/batch');
    expect(self).toBe(window);
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      priority: 'low',
      keepalive: true,
    });
    expect(init.headers).toEqual({
      Authorization: 'Bearer rk_transport',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Gateway-Token': 'gw',
    });
    expect(init.body).toBe(upload().body);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a configuration GET has no body and no keepalive', () => {
    const calls = fakeFetch();
    send(configRequest(CONFIG, '"v1"'));

    const init = calls[0]?.init;
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.keepalive).toBe(false);
    expect(init?.headers).toEqual({
      Authorization: 'Bearer rk_transport',
      'If-None-Match': '"v1"',
      'X-Gateway-Token': 'gw',
    });
  });

  it('reads fetch from the page at every request, never keeping one', () => {
    const first = fakeFetch();
    const transport = createFetchTransport(new TestScheduler());
    transport.send(upload({ closing: true }), () => undefined);
    const second = fakeFetch();
    transport.send(upload({ closing: true }), () => undefined);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('without AbortController sends without a signal, and abort does nothing', () => {
    replaceGlobal('AbortController', undefined);
    const calls = fakeFetch();
    const { abort } = send(upload({ closing: true }));

    expect(calls[0]?.init.signal).toBeUndefined();
    expect(abort).not.toThrow();
  });

  it('abort cancels the fetch through its AbortController', () => {
    const calls = fakeFetch();
    const { abort } = send(upload({ closing: true }));
    abort();

    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });
});

describe('gzip (Web HTTP 2)', () => {
  it('compresses a body the core allows, with Content-Encoding and the compressed size', async () => {
    const calls = fakeFetch(() => Promise.resolve(fakeResponse().response));
    const { outcomes } = send(upload());
    expect(calls).toHaveLength(0);

    await settle(() => outcomes.length > 0);

    const init = calls[0]?.init;
    expect(init?.headers).toMatchObject({ 'Content-Encoding': 'gzip' });
    const sent = init?.body as ArrayBuffer;
    expect(gunzipSync(new Uint8Array(sent)).toString('utf8')).toBe(upload().body);
    expect(outcomes).toEqual([{ kind: 'response', status: 200, headers: {}, sentBytes: sent.byteLength }]);
  });

  it('never compresses a request started while the page goes away, and starts it inside send', () => {
    const calls = fakeFetch();
    send(upload({ closing: true, keepalive: true }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).toBe(upload().body);
    expect(Object.keys(calls[0]?.init.headers ?? {})).not.toContain('Content-Encoding');
  });

  it('sends uncompressed, at once, where CompressionStream is missing', () => {
    replaceGlobal('CompressionStream', undefined);
    const calls = fakeFetch();
    send(upload());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).toBe(upload().body);
  });

  it('sends uncompressed in Safari 16.4 and 16.5', () => {
    replaceGlobal('navigator', { userAgent: SAFARI_16_4, onLine: true });
    const calls = fakeFetch();
    send(upload());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).toBe(upload().body);
  });

  it('sends uncompressed from any browser on iOS 16.4 and 16.5, whose WebKit is the same', () => {
    replaceGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/112.0.5615.46 Mobile/15E148 Safari/604.1',
      onLine: true,
    });
    const calls = fakeFetch();
    send(upload());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.body).toBe(upload().body);
  });

  it('sends uncompressed when compressing fails', async () => {
    replaceGlobal('CompressionStream', function brokenCompressionStream() {
      throw new TypeError('broken');
    });
    const calls = fakeFetch(() => Promise.resolve(fakeResponse().response));
    const { outcomes } = send(upload());
    await settle(() => outcomes.length > 0);

    expect(calls[0]?.init.body).toBe(upload().body);
    expect(Object.keys(calls[0]?.init.headers ?? {})).not.toContain('Content-Encoding');
  });

  it('tells every browser on iOS and iPadOS 16.4 and 16.5 by its OS token (plan section 15, step 7.3)', () => {
    const ios = (os: string, browser: string): string =>
      `Mozilla/5.0 (${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser} Mobile/15E148 Safari/604.1`;
    // Chrome, Firefox and Edge on an iPhone, Safari on an iPad, an in-app web view without a browser token.
    expect(hasBrokenCompression(ios('iPhone; CPU iPhone OS 16_4', 'CriOS/112.0.5615.46'))).toBe(true);
    expect(hasBrokenCompression(ios('iPhone; CPU iPhone OS 16_5', 'FxiOS/114.0'))).toBe(true);
    expect(hasBrokenCompression(ios('iPhone; CPU iPhone OS 16_4_1', 'EdgiOS/112.0.1722.49'))).toBe(true);
    expect(hasBrokenCompression(ios('iPad; CPU OS 16_5', 'Version/16.5'))).toBe(true);
    expect(
      hasBrokenCompression(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      ),
    ).toBe(true);
    // The versions before and after, and iOS 26.
    expect(hasBrokenCompression(ios('iPhone; CPU iPhone OS 16_3', 'CriOS/111.0'))).toBe(false);
    expect(hasBrokenCompression(ios('iPhone; CPU iPhone OS 16_6', 'CriOS/115.0'))).toBe(false);
    expect(hasBrokenCompression(ios('iPad; CPU OS 17_4', 'Version/17.4'))).toBe(false);
    expect(hasBrokenCompression(ios('iPhone; CPU iPhone OS 26_0', 'Version/26.0'))).toBe(false);
  });

  it('tells Safari 16.4 and 16.5 from other Safari versions and from the browsers that copy its tokens', () => {
    const mac = (version: string): string =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
    const iphone = (version: string): string =>
      `Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`;
    expect(hasBrokenCompression(mac('16.4'))).toBe(true);
    expect(hasBrokenCompression(mac('16.5'))).toBe(true);
    expect(hasBrokenCompression(mac('16.4.1'))).toBe(true);
    expect(hasBrokenCompression(iphone('16.5'))).toBe(true);
    expect(hasBrokenCompression(mac('16.3'))).toBe(false);
    expect(hasBrokenCompression(mac('16.6'))).toBe(false);
    expect(hasBrokenCompression(mac('17.4'))).toBe(false);
    expect(hasBrokenCompression(mac('26.0'))).toBe(false);

    expect(
      hasBrokenCompression(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(hasBrokenCompression('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe(false);
  });
});

describe('the outcome (Web HTTP 3)', () => {
  async function outcomeOf(request: HttpRequest, options: FakeResponseOptions): Promise<[HttpOutcome[], number]> {
    const fake = fakeResponse(options);
    fakeFetch(() => Promise.resolve(fake.response));
    const { outcomes } = send(request);
    await settle(() => outcomes.length > 0);
    return [outcomes, fake.reads()];
  }

  const closing = upload({ closing: true });
  const sentBytes = new TextEncoder().encode(closing.body).length;

  it('an upload success: the status and the size sent, its body never read', async () => {
    const [outcomes, reads] = await outcomeOf(closing, { status: 202, body: 'ignored' });
    expect(outcomes).toEqual([{ kind: 'response', status: 202, headers: {}, sentBytes }]);
    expect(reads).toBe(0);
  });

  it('an error status: its body and the three headers the core reads, when exposed', async () => {
    const [outcomes] = await outcomeOf(closing, {
      status: 429,
      body: 'slow down',
      headers: { 'Retry-After': '30', 'X-Request-Id': 'req-1', 'Set-Cookie': 'x=1', Server: 'gw' },
    });
    expect(outcomes).toEqual([
      {
        kind: 'response',
        status: 429,
        headers: { 'Retry-After': '30', 'X-Request-Id': 'req-1' },
        body: 'slow down',
        sentBytes,
      },
    ]);
  });

  it('a configuration answer: its body and ETag; a 304 without a body read', async () => {
    const [ok] = await outcomeOf(configRequest(CONFIG, undefined), {
      status: 200,
      body: '{}',
      headers: { ETag: '"a"' },
    });
    expect(ok).toEqual([{ kind: 'response', status: 200, headers: { ETag: '"a"' }, body: '{}' }]);
    const [unchanged, reads] = await outcomeOf(configRequest(CONFIG, '"a"'), { status: 304 });
    expect(unchanged).toEqual([{ kind: 'response', status: 304, headers: {} }]);
    expect(reads).toBe(0);
  });

  it('an opaqueredirect: status 0, marked, nothing of the target', async () => {
    const [outcomes] = await outcomeOf(closing, { type: 'opaqueredirect', status: 0 });
    expect(outcomes).toEqual([{ kind: 'response', status: 0, opaqueRedirect: true, sentBytes }]);
  });

  it('a body that cannot be read keeps the status', async () => {
    const [outcomes] = await outcomeOf(closing, { status: 503, bodyFails: true });
    expect(outcomes).toEqual([{ kind: 'response', status: 503, headers: {}, sentBytes }]);
  });

  it('a rejection: the value fetch rejected with, for the core to classify', async () => {
    const error = new TypeError('Failed to fetch');
    fakeFetch(() => Promise.reject(error));
    const { outcomes } = send(closing);
    await settle(() => outcomes.length > 0);
    expect(outcomes).toEqual([{ kind: 'rejected', error }]);
  });

  it('a fetch that throws inside send is reported once, on a later turn', () => {
    const error = new TypeError('wrapped fetch threw');
    replaceGlobal('fetch', () => {
      throw error;
    });
    const scheduler = new TestScheduler();
    const { outcomes } = send(closing, scheduler);
    expect(outcomes).toEqual([]);

    scheduler.runUntilIdle();
    expect(outcomes).toEqual([{ kind: 'rejected', error }]);
  });

  it('a fetch that returns no Promise is a rejection, never a throw', async () => {
    replaceGlobal('fetch', () => undefined);
    const { outcomes } = send(closing);
    await settle(() => outcomes.length > 0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('rejected');
  });

  it('a callback that throws leaves no rejection behind', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      fakeFetch(() => Promise.resolve(fakeResponse().response));
      let calls = 0;
      createFetchTransport(new TestScheduler()).send(closing, () => {
        calls += 1;
        throw new Error('callback');
      });
      await settle(() => calls > 0);
      await settle(() => false);
      expect(calls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});
