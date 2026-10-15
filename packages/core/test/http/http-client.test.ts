import {
  abortError,
  fetchTypeError,
  opaqueRedirectOutcome,
  RecordingLogger,
  rejectedOutcome,
  responseOutcome,
  TestPlatform,
} from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import {
  batchBody,
  batchRequest,
  configRequest,
  HttpClient,
  Log,
  NO_OP_SINK,
  readJsonObject,
  REQUEST_TIMEOUT_MS,
} from '../../src';
import type { HttpCall, HttpOutcome, HttpRequest, HttpResult, HttpTransport, LogLevel, RequestConfig } from '../../src';

// The port of the Android HttpURLConnectionTransportTest for what the core owns on the web (step
// 5.1): the request shape of Web HTTP 1, the classification table of Web HTTP 3, `Retry-After` on a
// response, the 45-second deadline and the log lines. Everything goes through `FakeTransport`, which
// scripts what `fetch` gives. Not ported, since the browser owns them (step 7.3 tests them in the
// engines): gzip and its failure, the fixed length, the read timeout, TLS, DNS and the blocked-host
// check (no DNS API, Web HTTP 3), the production constructor.

// Wed, 01 Oct 2026 12:00:00 GMT
const NOW = 1_790_856_000_000;
const LINES = ['{"type":"track","event":"Purchase Completed","message_id":"m1"}', '{"type":"track","event":"b"}'];

const CONFIG: RequestConfig = {
  apiKey: 'rk_test_key',
  batchUrl: 'https://api.rubicon.example/v1/batch',
  configUrl: 'https://api.rubicon.example/v1/config',
  headers: { 'X-Gateway-Token': 'gw-secret' },
};

function upload(options: { keepalive?: boolean; closing?: boolean; sentAt?: number } = {}): HttpRequest {
  return batchRequest(CONFIG, {
    sentAt: options.sentAt ?? NOW,
    lines: LINES,
    keepalive: options.keepalive ?? false,
    closing: options.closing ?? false,
  });
}

function setup(options: { level?: LogLevel; online?: boolean; transport?: HttpTransport } = {}) {
  const test = new TestPlatform({ now: NOW, online: options.online });
  const logger = new RecordingLogger();
  const log = new Log({ level: options.level ?? 'debug', debug: false, logger: logger.logger, sink: NO_OP_SINK });
  const client = new HttpClient({
    transport: options.transport ?? test.transport,
    scheduler: test.scheduler,
    clock: test.clock,
    network: test.network,
    urls: test.platform.urls,
    log,
  });
  const results: HttpResult[] = [];
  return {
    test,
    logger,
    results,
    send: (request: HttpRequest = upload()): void => {
      client.send(request, (result) => results.push(result));
    },
    /** Sends `request`, answers it with `outcome` and returns the one result. */
    exchange: (outcome: HttpOutcome, request: HttpRequest = upload()): HttpResult | undefined => {
      test.transport.enqueue(outcome);
      client.send(request, (result) => results.push(result));
      test.scheduler.runUntilIdle();
      expect(results).toHaveLength(1);
      return results[0];
    },
    logged: (code: string): boolean =>
      logger.lines.some((line) => line.level !== 'debug' && line.message.startsWith(`${code}:`)),
  };
}

describe('the request (Web HTTP 1)', () => {
  it('posts the batch body with the key in Authorization, the JSON type and network.headers', () => {
    const { test, send } = setup();
    send(upload({ keepalive: true }));
    const request = test.transport.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://api.rubicon.example/v1/batch');
    expect({ ...request?.headers }).toEqual({
      Authorization: 'Bearer rk_test_key',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Gateway-Token': 'gw-secret',
    });
    expect(Object.keys(request?.headers ?? {})).toEqual(['Authorization', 'Content-Type', 'X-Gateway-Token']);
    expect(request?.body).toBe(batchBody(NOW, LINES));
    expect(request?.body).toBe(`{"sent_at":${String(NOW)},"batch":[${LINES.join(',')}]}`);
    expect(readJsonObject(request?.body ?? '')).toBeDefined();
    expect(request?.keepalive).toBe(true);
    expect(request?.compress).toBe(true);
  });

  it('sends no User-Agent, version or Content-Encoding header of its own, and never the key in the body', () => {
    const request = upload();
    const names = Object.keys(request.headers).map((name) => name.toLowerCase());
    expect(names).not.toContain('user-agent');
    expect(names).not.toContain('content-encoding');
    expect(names.filter((name) => name.startsWith('x-rubicon'))).toEqual([]);
    expect(request.body).not.toContain('rk_test_key');
  });

  it('keeps the keepalive decision of the uploader', () => {
    expect(upload({ keepalive: false }).keepalive).toBe(false);
    expect(upload({ keepalive: true }).keepalive).toBe(true);
  });

  it('asks for gzip except for a request started while the page goes away (Web HTTP 2)', () => {
    expect(upload({ closing: false }).compress).toBe(true);
    expect(upload({ closing: true }).compress).toBe(false);
    expect(upload({ closing: true, keepalive: true }).keepalive).toBe(true);
  });

  it('writes sent_at anew for every attempt', () => {
    expect(upload({ sentAt: 1 }).body).toBe(batchBody(1, LINES));
    expect(upload({ sentAt: 2 }).body).toBe(batchBody(2, LINES));
  });

  it('custom headers never replace the SDK own, in any letter case', () => {
    // Validation removes reserved names already (Configuration 5); the requests drop them again.
    const sneaky: RequestConfig = {
      ...CONFIG,
      headers: {
        authorization: 'Bearer stolen',
        'USER-AGENT': 'evil',
        'Content-Type': 'text/plain',
        'content-encoding': 'identity',
        'Content-Length': '1',
        HOST: 'evil.example',
        'if-none-match': '"forged"',
        'X-Rubicon-Debug': '1',
        'X-Allowed': 'yes',
      },
    };
    const post = batchRequest(sneaky, { sentAt: NOW, lines: LINES, keepalive: false, closing: false });
    expect({ ...post.headers }).toEqual({
      Authorization: 'Bearer rk_test_key',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Allowed': 'yes',
    });
    const get = configRequest(sneaky, '"abc"');
    expect({ ...get.headers }).toEqual({
      Authorization: 'Bearer rk_test_key',
      'If-None-Match': '"abc"',
      'X-Allowed': 'yes',
    });
  });

  it('keeps a header named __proto__ as a header', () => {
    const headers = Object.create(null) as Record<string, string>;
    headers['__proto__'] = 'value';
    const request = batchRequest(
      { ...CONFIG, headers },
      { sentAt: NOW, lines: LINES, keepalive: false, closing: false },
    );
    expect(Object.keys(request.headers)).toContain('__proto__');
    expect(request.headers['__proto__']).toBe('value');
  });

  it('a configuration GET sends no body and carries If-None-Match', () => {
    const { test, send } = setup();
    send(configRequest(CONFIG, '"abc"'));
    const request = test.transport.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe('https://api.rubicon.example/v1/config');
    expect({ ...request?.headers }).toEqual({
      Authorization: 'Bearer rk_test_key',
      'If-None-Match': '"abc"',
      'X-Gateway-Token': 'gw-secret',
    });
    expect(request?.body).toBeUndefined();
    expect(request?.keepalive).toBe(false);
    expect(request?.compress).toBe(false);
  });

  it('a configuration GET without a saved ETag has no If-None-Match', () => {
    expect({ ...configRequest(CONFIG, undefined).headers }).toEqual({
      Authorization: 'Bearer rk_test_key',
      'X-Gateway-Token': 'gw-secret',
    });
  });
});

describe('the classification table (Web HTTP 3)', () => {
  it.each([200, 201, 202, 204, 299])('%i is a success', (status) => {
    expect(setup().exchange(responseOutcome(status))).toEqual({ kind: 'success', status });
  });

  it('a GET success carries its body and ETag, an upload success neither', () => {
    const get = setup().exchange(
      responseOutcome(200, { body: '{"flush_at":60}', headers: { ETag: '"v7"' } }),
      configRequest(CONFIG, undefined),
    );
    expect(get).toEqual({ kind: 'success', status: 200, body: '{"flush_at":60}', etag: '"v7"' });
    const post = setup().exchange(responseOutcome(200, { body: 'ignored', headers: { ETag: '"v8"' } }));
    expect(post).toEqual({ kind: 'success', status: 200 });
  });

  it('a GET body is kept up to 64 KB', () => {
    const result = setup().exchange(responseOutcome(200, { body: 'x'.repeat(100_000) }), configRequest(CONFIG, '"a"'));
    expect(result?.kind === 'success' && result.body?.length).toBe(64 * 1024);
  });

  it('a 304 to the configuration request is an unchanged success, not a redirect', () => {
    const { exchange, logged } = setup();
    const result = exchange(responseOutcome(304, { headers: { etag: '"abc"' } }), configRequest(CONFIG, '"abc"'));
    expect(result).toEqual({ kind: 'success', status: 304, etag: '"abc"' });
    expect(logged('HTTP_REDIRECT')).toBe(false);
  });

  it('a 304 to an upload is an HTTP error for the retry table', () => {
    expect(setup().exchange(responseOutcome(304))).toEqual({ kind: 'http-error', status: 304 });
  });

  it('an opaqueredirect is an HTTP error marked redirect, with HTTP_REDIRECT naming the host but no target', () => {
    const { exchange, logger, test } = setup();
    const result = exchange(opaqueRedirectOutcome());
    expect(result).toEqual({ kind: 'http-error', status: 0, redirect: true });
    expect(test.transport.requests).toHaveLength(1);
    const line = logger.lines.find((entry) => entry.message.startsWith('HTTP_REDIRECT'));
    expect(line?.level).toBe('error');
    expect(line?.message).toBe(
      'HTTP_REDIRECT: api.rubicon.example answered with a redirect; set host to the final URL',
    );
  });

  it.each([100, 300, 305, 400, 401, 403, 404, 408, 410, 413, 422, 429, 500, 501, 502, 503, 504, 505, 599, 600, 0])(
    'any other status, %i, is an HTTP error with its code and body',
    (status) => {
      const { exchange, logged } = setup();
      expect(exchange(responseOutcome(status, { body: `reason ${String(status)}` }))).toEqual({
        kind: 'http-error',
        status,
        body: `reason ${String(status)}`,
      });
      expect(logged('HTTP_REDIRECT')).toBe(false);
    },
  );

  it('an error without a body has none', () => {
    expect(setup().exchange(responseOutcome(500))).toEqual({ kind: 'http-error', status: 500 });
  });

  it('a 1 MB error body is kept up to 4 KB', () => {
    const result = setup().exchange(responseOutcome(400, { body: 'x'.repeat(1024 * 1024) }));
    expect(result?.kind === 'http-error' && result.body?.length).toBe(4096);
  });

  it('cuts an error body at 4 KB of UTF-8 without splitting a character', () => {
    // 1365 three-byte characters take 4095 bytes; a four-byte pair would pass 4096 and is left out.
    const result = setup().exchange(responseOutcome(500, { body: `${'€'.repeat(1365)}😀tail` }));
    expect(result?.kind === 'http-error' && result.body).toBe('€'.repeat(1365));
  });

  describe('Retry-After on a response', () => {
    function retryAfter(headers: Readonly<Record<string, string>> | undefined, status = 429): number | undefined {
      const result = setup().exchange(responseOutcome(status, headers === undefined ? {} : { headers }));
      return result?.kind === 'http-error' ? result.retryAfterMs : undefined;
    }

    it('in seconds', () => {
      expect(retryAfter({ 'Retry-After': '120' })).toBe(120_000);
    });

    it('as an HTTP date, from the clock when the answer arrived', () => {
      expect(retryAfter({ 'Retry-After': 'Wed, 01 Oct 2026 12:01:00 GMT' })).toBe(60_000);
    });

    it('a date in the past is negative and left to the retry layer', () => {
      expect(retryAfter({ 'Retry-After': 'Wed, 01 Oct 2026 11:59:00 GMT' })).toBe(-60_000);
    });

    it('in any letter case of the header name', () => {
      expect(retryAfter({ 'retry-after': '5' })).toBe(5_000);
      expect(retryAfter({ 'RETRY-AFTER': '6' })).toBe(6_000);
    });

    it('invalid values and a header the backend did not expose are absent', () => {
      expect(retryAfter({ 'Retry-After': 'soon' })).toBeUndefined();
      expect(retryAfter({ 'Retry-After': '-5' })).toBeUndefined();
      expect(retryAfter({ 'Retry-After': '1.5' })).toBeUndefined();
      expect(retryAfter({ 'Retry-After': 'Wednesday, 01-Oct-26 12:01:00 GMT' })).toBeUndefined();
      expect(retryAfter(undefined)).toBeUndefined();
    });

    it('503 carries it too', () => {
      expect(setup().exchange(responseOutcome(503, { headers: { 'Retry-After': '30' } }))).toEqual({
        kind: 'http-error',
        status: 503,
        retryAfterMs: 30_000,
      });
    });
  });

  it('a TypeError while offline is connect', () => {
    const { exchange } = setup({ online: false });
    expect(exchange(rejectedOutcome(fetchTypeError()))).toEqual({ kind: 'network-failure', failure: 'connect' });
  });

  it('a TypeError on a keepalive request while offline is connect too: the rows are taken in order', () => {
    const { exchange } = setup({ online: false });
    expect(exchange(rejectedOutcome(fetchTypeError()), upload({ keepalive: true }))).toEqual({
      kind: 'network-failure',
      failure: 'connect',
    });
  });

  it('reads the network state when the answer arrives, not when the request started', () => {
    const { test, send, results } = setup();
    test.transport.enqueue({ outcome: rejectedOutcome(fetchTypeError()), delayMs: 1_000 });
    send();
    test.network.goOffline();
    test.scheduler.advanceBy(1_000);
    expect(results).toEqual([{ kind: 'network-failure', failure: 'connect' }]);
  });

  it('a TypeError on a keepalive request while online is the keepalive refusal', () => {
    const { exchange } = setup();
    expect(exchange(rejectedOutcome(fetchTypeError()), upload({ keepalive: true }))).toEqual({
      kind: 'keepalive-refused',
    });
  });

  it('any other TypeError is io', () => {
    const { exchange, logged } = setup();
    expect(exchange(rejectedOutcome(fetchTypeError()))).toEqual({ kind: 'network-failure', failure: 'io' });
    expect(logged('HTTP_UNEXPECTED')).toBe(false);
  });

  it('a TypeError of another frame is told by its name', () => {
    // `instanceof TypeError` fails across frames; the name is compared as a string (Web HTTP 3).
    const foreign = { name: 'TypeError', message: 'Load failed' };
    expect(setup().exchange(rejectedOutcome(foreign))).toEqual({ kind: 'network-failure', failure: 'io' });
  });

  it('a configuration GET that fails with a TypeError is io, never a keepalive refusal', () => {
    expect(setup().exchange(rejectedOutcome(fetchTypeError()), configRequest(CONFIG, undefined))).toEqual({
      kind: 'network-failure',
      failure: 'io',
    });
  });

  it('an AbortError the core did not cause is unexpected, with HTTP_UNEXPECTED and the error for the logger only', () => {
    const { exchange, logger } = setup();
    const error = abortError();
    expect(exchange(rejectedOutcome(error))).toEqual({ kind: 'network-failure', failure: 'unexpected' });
    const line = logger.lines.find((entry) => entry.message.startsWith('HTTP_UNEXPECTED'));
    expect(line?.level).toBe('error');
    expect(line?.error).toBe(error);
    expect(line?.message).not.toContain('AbortError');
    expect(line?.message).not.toContain('aborted');
  });

  it.each<[string, unknown]>([
    ['a RangeError', new RangeError('Invalid status')],
    ['a TimeoutError of another script', new DOMException('Timed out', 'TimeoutError')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an object without a name', {}],
    ['a name that is not a string', { name: 42 }],
  ])('any other exception, %s, is unexpected', (_label, error) => {
    const { exchange, logged } = setup();
    expect(exchange(rejectedOutcome(error))).toEqual({ kind: 'network-failure', failure: 'unexpected' });
    expect(logged('HTTP_UNEXPECTED')).toBe(true);
  });

  it('an error whose name getter throws is unexpected and nothing throws', () => {
    const hostile = Object.defineProperty({}, 'name', {
      get(): string {
        throw new Error('getter');
      },
    });
    expect(setup().exchange(rejectedOutcome(hostile))).toEqual({ kind: 'network-failure', failure: 'unexpected' });
  });

  it('a transport that throws inside send gives unexpected on a later turn', () => {
    const thrown = new Error('transport bug');
    const broken: HttpTransport = {
      send(): HttpCall {
        throw thrown;
      },
    };
    const { test, send, results, logger } = setup({ transport: broken });
    send();
    expect(results).toEqual([]);
    test.scheduler.runUntilIdle();
    expect(results).toEqual([{ kind: 'network-failure', failure: 'unexpected' }]);
    expect(logger.lines.find((line) => line.message.startsWith('HTTP_UNEXPECTED'))?.error).toBe(thrown);
    test.scheduler.advanceBy(REQUEST_TIMEOUT_MS);
    expect(results).toHaveLength(1);
  });
});

describe('the 45-second deadline (Web HTTP 1)', () => {
  it('reports a timeout when no answer comes in 45 s, and asks the transport to abort', () => {
    const { test, send, results } = setup();
    test.transport.enqueue({ outcome: responseOutcome(200), delayMs: Infinity });
    send();
    test.scheduler.advanceBy(REQUEST_TIMEOUT_MS - 1);
    expect(results).toEqual([]);
    test.scheduler.advanceBy(1);
    expect(results).toEqual([{ kind: 'network-failure', failure: 'timeout' }]);
    expect(test.transport.calls[0]?.aborted).toBe(true);
    // The AbortError the abort brings is ignored: the timeout was the result.
    test.scheduler.runAll();
    expect(results).toHaveLength(1);
    expect(REQUEST_TIMEOUT_MS).toBe(45_000);
  });

  it('ignores a late answer after the deadline', () => {
    const { test, send, results } = setup();
    test.transport.enqueue({ outcome: responseOutcome(200), delayMs: 60_000 });
    send();
    test.scheduler.advanceBy(60_000);
    test.scheduler.runAll();
    expect(results).toEqual([{ kind: 'network-failure', failure: 'timeout' }]);
  });

  it('ignores a late answer from a transport that cannot abort', () => {
    // Below Chrome 66, Firefox 57 and Safari 12.1 there is no AbortController (Web HTTP 1).
    const pending: ((outcome: HttpOutcome) => void)[] = [];
    const stubborn: HttpTransport = {
      send(_request, onOutcome): HttpCall {
        pending.push(onOutcome);
        return { abort: () => undefined };
      },
    };
    const { test, send, results } = setup({ transport: stubborn });
    send();
    test.scheduler.advanceBy(REQUEST_TIMEOUT_MS);
    pending[0]?.(responseOutcome(200));
    test.scheduler.runAll();
    expect(results).toEqual([{ kind: 'network-failure', failure: 'timeout' }]);
  });

  it('a transport whose abort throws changes nothing', () => {
    const throwing: HttpTransport = {
      send(): HttpCall {
        return {
          abort(): void {
            throw new Error('abort failed');
          },
        };
      },
    };
    const { test, send, results } = setup({ transport: throwing });
    send();
    expect(() => {
      test.scheduler.advanceBy(REQUEST_TIMEOUT_MS);
    }).not.toThrow();
    expect(results).toEqual([{ kind: 'network-failure', failure: 'timeout' }]);
  });

  it('an answer before the deadline cancels it', () => {
    const { test, send, results } = setup();
    test.transport.enqueue({ outcome: responseOutcome(200), delayMs: REQUEST_TIMEOUT_MS - 1 });
    send();
    test.scheduler.advanceBy(REQUEST_TIMEOUT_MS * 2);
    expect(results).toEqual([{ kind: 'success', status: 200 }]);
    expect(test.transport.calls[0]?.aborted).toBe(false);
  });

  it('reports exactly once and never inside send, whatever the transport does', () => {
    const sync: HttpTransport = {
      send(_request, onOutcome): HttpCall {
        onOutcome(responseOutcome(500));
        onOutcome(responseOutcome(200));
        return { abort: () => undefined };
      },
    };
    const { test, send, results } = setup({ transport: sync });
    send();
    expect(results).toEqual([]);
    test.scheduler.runAll();
    expect(results).toEqual([{ kind: 'http-error', status: 500 }]);
  });
});

describe('log lines', () => {
  it('the DEBUG line names the method, endpoint, result, duration, bytes and the request id', () => {
    const { test, send, logger } = setup();
    test.transport.enqueue({
      outcome: responseOutcome(500, { headers: { 'X-Request-Id': 'req-42' }, sentBytes: 312 }),
      delayMs: 120,
    });
    send();
    test.scheduler.advanceBy(120);
    expect(logger.lines).toEqual([
      {
        level: 'debug',
        message: 'POST /v1/batch: 500 in 120 ms, 312 bytes sent (request id req-42)',
        error: undefined,
      },
    ]);
  });

  it('reads the request id in any letter case, and only for the line', () => {
    const { exchange, logger } = setup();
    const result = exchange(responseOutcome(200, { headers: { 'x-request-id': 'abc' } }));
    expect(result).toEqual({ kind: 'success', status: 200 });
    expect(logger.messages).toEqual(['POST /v1/batch: 200 in 0 ms (request id abc)']);
  });

  it('describes every kind of result', () => {
    const lines: string[] = [];
    const cases: [HttpOutcome, HttpRequest][] = [
      [responseOutcome(304), configRequest(CONFIG, '"e"')],
      [opaqueRedirectOutcome(), upload()],
      [rejectedOutcome(fetchTypeError()), upload()],
      [rejectedOutcome(fetchTypeError()), upload({ keepalive: true })],
    ];
    for (const [outcome, request] of cases) {
      const { exchange, logger } = setup();
      exchange(outcome, request);
      lines.push(...logger.lines.filter((line) => line.level === 'debug').map((line) => line.message));
    }
    expect(lines).toEqual([
      'GET /v1/config: 304 in 0 ms',
      'POST /v1/batch: redirect in 0 ms',
      'POST /v1/batch: io in 0 ms',
      'POST /v1/batch: keepalive refused in 0 ms',
    ]);
  });

  it('a timeout line gives the time waited', () => {
    const { test, send, logger } = setup();
    test.transport.enqueue({ outcome: responseOutcome(200), delayMs: Infinity });
    send();
    test.scheduler.advanceBy(REQUEST_TIMEOUT_MS);
    expect(logger.messages).toEqual(['POST /v1/batch: timeout in 45000 ms']);
  });

  it('a clock set back during a request gives no negative duration', () => {
    const { test, send, logger } = setup();
    test.transport.enqueue({ outcome: responseOutcome(200), delayMs: 10 });
    send();
    test.clock.set(NOW - 60_000);
    test.scheduler.advanceBy(10);
    expect(logger.messages).toEqual(['POST /v1/batch: 200 in 0 ms']);
  });

  it('bodies, the key and header values never appear in a line', () => {
    const outcomes: HttpOutcome[] = [
      responseOutcome(500, { body: 'secret detail', headers: { 'X-Request-Id': 'req-42', 'X-Echo': 'echoed-value' } }),
      responseOutcome(200, { body: 'secret detail' }),
      opaqueRedirectOutcome(),
      rejectedOutcome(new Error('secret detail')),
    ];
    const messages: string[] = [];
    for (const outcome of outcomes) {
      const { exchange, logger } = setup();
      exchange(outcome);
      messages.push(...logger.messages);
    }
    const { exchange, logger } = setup();
    exchange(
      responseOutcome(200, { body: '{"flush_at":5,"secret":"detail"}' }),
      configRequest(CONFIG, '"etag-secret"'),
    );
    messages.push(...logger.messages);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      for (const secret of [
        'Purchase Completed',
        'secret',
        'rk_test_key',
        'gw-secret',
        'echoed-value',
        'etag-secret',
        'flush_at',
      ]) {
        expect(message).not.toContain(secret);
      }
    }
    expect(messages.some((message) => message.includes('request id req-42'))).toBe(true);
  });

  it('writes no DEBUG line above the debug level', () => {
    const { exchange, logger } = setup({ level: 'warn' });
    exchange(responseOutcome(200, { headers: { 'X-Request-Id': 'r' } }));
    expect(logger.lines).toEqual([]);
  });
});

describe('UPLOAD_FAILED_OPAQUE (Web HTTP 3, Web Logging 2 and 3; step 7.3)', () => {
  function opaqueLines(logger: RecordingLogger): string[] {
    return logger.lines
      .filter((line) => line.message.startsWith('UPLOAD_FAILED_OPAQUE:'))
      .map((line) => `${line.level} ${line.message}`);
  }

  it('the first io of an upload is one WARN naming the host and the possible causes, never the error', () => {
    const { exchange, logger } = setup();
    expect(exchange(rejectedOutcome(fetchTypeError()))).toEqual({ kind: 'network-failure', failure: 'io' });
    expect(opaqueLines(logger)).toEqual([
      'warn UPLOAD_FAILED_OPAQUE: An upload to api.rubicon.example failed without a reason the browser reveals; ' +
        "check the host's CORS answer, the page's Content Security Policy, an ad blocker and the certificate",
    ]);
    const line = logger.lines.find((entry) => entry.message.startsWith('UPLOAD_FAILED_OPAQUE:'));
    expect(line?.error).toBeUndefined();
    expect(line?.message).not.toContain('Failed to fetch');
  });

  it('a later io of the same page is a DEBUG line (per page, then once a day per device)', () => {
    const { test, send, logger } = setup();
    test.transport.enqueue(rejectedOutcome(fetchTypeError()), rejectedOutcome(fetchTypeError()));
    send();
    send();
    test.scheduler.runUntilIdle();
    expect(opaqueLines(logger).map((line) => line.split(' ')[0])).toEqual(['warn', 'debug']);
  });

  it('is asked of the daily limit of .device, which can hold it back', () => {
    const test = new TestPlatform({ now: NOW });
    const logger = new RecordingLogger();
    const log = new Log({ level: 'warn', debug: false, logger: logger.logger, sink: NO_OP_SINK });
    const claimed: string[] = [];
    log.dailyLimit = {
      claim: (code) => {
        claimed.push(code);
        return false;
      },
    };
    const client = new HttpClient({
      transport: test.transport,
      scheduler: test.scheduler,
      clock: test.clock,
      network: test.network,
      urls: test.platform.urls,
      log,
    });
    test.transport.enqueue(rejectedOutcome(fetchTypeError()));
    client.send(upload(), () => undefined);
    test.scheduler.runUntilIdle();
    expect(claimed).toEqual(['UPLOAD_FAILED_OPAQUE']);
    expect(opaqueLines(logger)).toEqual([]);
  });

  it('is not written for an offline connect, a keepalive refusal, a timeout or the configuration request', () => {
    const offline = setup({ online: false });
    offline.exchange(rejectedOutcome(fetchTypeError()));
    expect(opaqueLines(offline.logger)).toEqual([]);

    const refused = setup();
    refused.exchange(rejectedOutcome(fetchTypeError()), upload({ keepalive: true }));
    expect(opaqueLines(refused.logger)).toEqual([]);

    const config = setup();
    expect(config.exchange(rejectedOutcome(fetchTypeError()), configRequest(CONFIG, undefined))).toEqual({
      kind: 'network-failure',
      failure: 'io',
    });
    expect(opaqueLines(config.logger)).toEqual([]);

    const slow = setup();
    slow.test.transport.enqueue({ outcome: responseOutcome(200), delayMs: Infinity });
    slow.send();
    slow.test.scheduler.advanceBy(REQUEST_TIMEOUT_MS);
    expect(slow.results).toEqual([{ kind: 'network-failure', failure: 'timeout' }]);
    expect(opaqueLines(slow.logger)).toEqual([]);
  });

  it('an HTTP error status is no opaque failure', () => {
    const { exchange, logger } = setup();
    exchange(responseOutcome(503));
    expect(opaqueLines(logger)).toEqual([]);
  });
});
