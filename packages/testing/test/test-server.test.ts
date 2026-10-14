import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORS_EXPOSE_HEADERS, CORS_MAX_AGE_SECONDS, DROPPED, TEST_HOST_A, TestServer, redirectTo } from '../src/server';

// Real sockets on the loopback interface: waits are bounded by the server's own timeouts and the
// scripted delays, never by a fixed sleep.

const pages = mkdtempSync(join(tmpdir(), 'rubicon-test-server-'));
mkdirSync(join(pages, 'nested'));
writeFileSync(join(pages, 'blank.html'), '<!doctype html><title>blank</title>');
writeFileSync(join(pages, 'nested', 'script.js'), 'void 0;');
writeFileSync(join(tmpdir(), 'rubicon-test-server-outside.txt'), 'outside');

let server: TestServer;

beforeAll(async () => {
  server = await TestServer.start({ files: { '/pages/': pages } });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
});

function expectResponseCors(response: Response): void {
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('access-control-expose-headers')).toBe(CORS_EXPOSE_HEADERS);
}

function expectNoCors(response: Response): void {
  for (const name of response.headers.keys()) expect(name).not.toMatch(/^access-control-/);
}

/** A raw request, for what `fetch` cannot send: the proxy's absolute form, a chosen Host. */
function rawRequest(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', fail);
    req.end();
  });
}

describe('scripted responses', () => {
  it('answers the script in order and then 200 with an empty body', async () => {
    server.enqueue({ status: 201, body: 'first' }, { status: 503, body: 'second' });

    const first = await fetch(server.url('/v1/batch'), { method: 'POST', body: '{}' });
    const second = await fetch(server.url('/v1/batch'), { method: 'POST', body: '{}' });
    const third = await fetch(server.url('/v1/batch'), { method: 'POST', body: '{}' });

    expect([first.status, await first.text()]).toEqual([201, 'first']);
    expect([second.status, await second.text()]).toEqual([503, 'second']);
    expect([third.status, await third.text()]).toEqual([200, '']);
  });

  it('sends the scripted headers, Retry-After included', async () => {
    server.enqueue({ status: 429, headers: { 'Retry-After': '120', ETag: '"v1"' } });

    const response = await fetch(server.url('/v1/batch'), { method: 'POST' });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(response.headers.get('etag')).toBe('"v1"');
  });

  it('answers a path with its fixed response outside the script', async () => {
    server.respond('/v1/config', { status: 404 });
    server.enqueue({ status: 500 });

    const config = await fetch(server.url('/v1/config'));
    const batch = await fetch(server.url('/v1/batch'), { method: 'POST' });
    const configAgain = await fetch(server.url('/v1/config?x=1'));

    expect([config.status, batch.status, configAgain.status]).toEqual([404, 500, 404]);
  });

  it('holds a delayed answer back after recording the request', async () => {
    server.enqueue({ status: 200, body: 'late', delayMs: 150 });
    const started = Date.now();
    let answered = false;

    const pending = fetch(server.url('/v1/batch'), { method: 'POST', body: 'x' }).then((response) => {
      answered = true;
      return response;
    });
    const recorded = await server.takeRequest();

    expect(recorded.body).toBe('x');
    expect(answered).toBe(false);
    const response = await pending;
    expect(await response.text()).toBe('late');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('answers a redirect with its Location and never follows it', async () => {
    server.enqueue(redirectTo('https://elsewhere.example/v1/batch', 307));

    const response = await fetch(server.url('/v1/batch'), { method: 'POST', redirect: 'manual' });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://elsewhere.example/v1/batch');
    expectResponseCors(response);
    expect(server.requests).toHaveLength(1);
  });

  it('drops the connection without an answer', async () => {
    server.enqueue(DROPPED);

    const failure = await fetch(server.url('/v1/batch'), { method: 'POST', body: 'lost' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TypeError);
    expect(server.requests.map((r) => r.body)).toEqual(['lost']);
  });

  it('drops the connection after a delay', async () => {
    server.enqueue({ drop: true, delayMs: 50 });

    const failure = await fetch(server.url('/v1/batch'), { method: 'POST' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TypeError);
  });

  it('answers 404 on a path outside the API and the static files, recording nothing', async () => {
    const response = await fetch(server.url('/favicon.ico'));

    expect(response.status).toBe(404);
    expect(server.requests).toHaveLength(0);
  });
});

describe('recorded requests', () => {
  it('records method, host, path, query, headers and body', async () => {
    await fetch(server.url('/v1/config?v=1'), { headers: { Authorization: 'Bearer key', 'If-None-Match': '"v7"' } });

    const request = await server.takeRequest();

    expect(request.method).toBe('GET');
    expect(request.host).toBe('127.0.0.1');
    expect(request.path).toBe('/v1/config');
    expect(request.query).toBe('?v=1');
    expect(request.headers['authorization']).toBe('Bearer key');
    expect(request.headers['if-none-match']).toBe('"v7"');
    expect(request.gzip).toBe(false);
    expect(request.body).toBe('');
  });

  it('decompresses a gzip body and keeps the raw bytes', async () => {
    const text = '{"sent_at":1,"batch":[{"event":"Ünïcödé"}]}';
    const compressed = gzipSync(Buffer.from(text, 'utf8'));

    await fetch(server.url('/v1/batch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' },
      body: compressed,
    });
    const request = await server.takeRequest();

    expect(request.gzip).toBe(true);
    expect(request.bodyDecoded).toBe(true);
    expect(request.body).toBe(text);
    expect(Buffer.from(request.rawBody).equals(compressed)).toBe(true);
  });

  it('keeps an uncompressed body as UTF-8 text', async () => {
    await fetch(server.url('/v1/batch'), { method: 'POST', body: '{"a":"ğ"}' });

    const request = await server.takeRequest();

    expect(request.gzip).toBe(false);
    expect(request.body).toBe('{"a":"ğ"}');
  });

  it('marks a gzip body that does not decompress', async () => {
    await fetch(server.url('/v1/batch'), { method: 'POST', headers: { 'Content-Encoding': 'gzip' }, body: 'plain' });

    const request = await server.takeRequest();

    expect(request.bodyDecoded).toBe(false);
    expect(request.body).toBe('');
    expect(Buffer.from(request.rawBody).toString()).toBe('plain');
  });

  it('takes requests in arrival order, waiting for one not yet arrived', async () => {
    await fetch(server.url('/v1/batch'), { method: 'POST', body: '1' });
    const first = await server.takeRequest();
    const second = server.takeRequest();
    await fetch(server.url('/v1/batch'), { method: 'POST', body: '2' });

    expect(first.body).toBe('1');
    expect((await second).body).toBe('2');
    expect(server.requests.map((r) => r.body)).toEqual(['1', '2']);
  });

  it('rejects when no request arrives in time', async () => {
    await expect(server.takeRequest(20)).rejects.toThrow('no request number 1 within 20 ms');
  });

  it('forgets requests, the script and fixed answers on reset', async () => {
    server.enqueue({ status: 500 });
    server.respond('/v1/config', { status: 404 });
    await fetch(server.url('/v1/batch'), { method: 'POST' });
    await server.takeRequest();
    const waiting = server.takeRequest();

    server.reset();

    await expect(waiting).rejects.toThrow('reset');
    expect(server.requests).toHaveLength(0);
    expect((await fetch(server.url('/v1/config'))).status).toBe(200);
    expect((await fetch(server.url('/v1/batch'), { method: 'POST' })).status).toBe(200);
    expect((await server.takeRequest()).path).toBe('/v1/config');
  });
});

describe('CORS (Web HTTP 4)', () => {
  it.each([200, 204, 304, 400, 401, 413, 429, 500, 503])('carries the CORS headers on a %i answer', async (status) => {
    server.enqueue({ status });

    const response = await fetch(server.url('/v1/batch'), { method: 'POST' });

    expect(response.status).toBe(status);
    expectResponseCors(response);
  });

  it('carries the CORS headers on pages and on a 404', async () => {
    expectResponseCors(await fetch(server.url('/pages/blank.html')));
    expectResponseCors(await fetch(server.url('/pages/missing.html')));
    expectResponseCors(await fetch(server.url('/nothing-here')));
  });

  it('answers the OPTIONS preflight with the headers of Web HTTP 4, outside the script', async () => {
    server.enqueue({ status: 500 });

    const response = await fetch(server.url('/v1/batch'), {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://a.rubicon.test:1',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-encoding,content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, GET');
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type, Content-Encoding, If-None-Match',
    );
    expect(response.headers.get('access-control-max-age')).toBe(String(CORS_MAX_AGE_SECONDS));
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(server.requests).toHaveLength(0);
    expect(server.preflights.map((p) => [p.path, p.headers['access-control-request-method']])).toEqual([
      ['/v1/batch', 'POST'],
    ]);
    expect((await fetch(server.url('/v1/batch'), { method: 'POST' })).status).toBe(500);
  });

  it('adds allowed request headers for network.headers tests', async () => {
    server.allowHeaders('X-Gateway-Token');

    const response = await fetch(server.url('/v1/batch'), { method: 'OPTIONS' });

    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type, Content-Encoding, If-None-Match, X-Gateway-Token',
    );
  });

  it('omits every CORS header, the preflight included, when switched off', async () => {
    server.cors = false;
    server.enqueue({ status: 429, headers: { 'Retry-After': '5' } });

    const preflight = await fetch(server.url('/v1/batch'), { method: 'OPTIONS' });
    const answer = await fetch(server.url('/v1/batch'), { method: 'POST' });
    const page = await fetch(server.url('/pages/blank.html'));

    expect(preflight.status).toBe(204);
    expectNoCors(preflight);
    expectNoCors(answer);
    expect(answer.headers.get('retry-after')).toBe('5');
    expectNoCors(page);
  });

  it('omits the CORS headers on one scripted answer only', async () => {
    server.enqueue({ status: 429, omitCors: true }, { status: 200 });

    const gateway = await fetch(server.url('/v1/batch'), { method: 'POST' });
    const backend = await fetch(server.url('/v1/batch'), { method: 'POST' });

    expectNoCors(gateway);
    expectResponseCors(backend);
  });

  it('turns CORS on again on reset', async () => {
    server.cors = false;
    server.reset();

    expectResponseCors(await fetch(server.url('/v1/batch'), { method: 'POST' }));
  });
});

describe('static files', () => {
  it('serves a fixture page with its content type, uncached', async () => {
    const response = await fetch(server.url('/pages/blank.html'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('<!doctype html><title>blank</title>');
    expect((await fetch(server.url('/pages/nested/script.js'))).headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
  });

  it('answers HEAD without a body and other methods with 404', async () => {
    const head = await fetch(server.url('/pages/blank.html'), { method: 'HEAD' });
    const post = await fetch(server.url('/pages/blank.html'), { method: 'POST' });

    expect([head.status, await head.text()]).toEqual([200, '']);
    expect(post.status).toBe(404);
  });

  it('never serves a file outside its directory', async () => {
    // `..` segments are removed by URL parsing; an encoded slash survives it and is decoded later.
    const escaped = await rawRequest('/pages/..%2Frubicon-test-server-outside.txt', `127.0.0.1:${String(server.port)}`);
    const malformed = await rawRequest('/pages/%E0%A4%A', `127.0.0.1:${String(server.port)}`);

    expect([escaped.status, malformed.status]).toEqual([404, 404]);
  });
});

describe('hostnames of D15', () => {
  it('serves a request addressed to a test host by the Host header', async () => {
    server.enqueue({ status: 202 });

    const response = await rawRequest('/v1/batch', `${TEST_HOST_A}:${String(server.port)}`);

    expect(response.status).toBe(202);
    expect(server.requests[0]?.host).toBe(TEST_HOST_A);
  });

  it('serves a request in the proxy absolute form for a test host', async () => {
    const response = await rawRequest(`http://${TEST_HOST_A}:${String(server.port)}/pages/blank.html`, 'ignored');

    expect(response.status).toBe(200);
    expect(response.body).toBe('<!doctype html><title>blank</title>');
  });

  it('refuses a proxied request for another host or port and records nothing', async () => {
    const foreign = await rawRequest(`http://detectportal.example:${String(server.port)}/v1/batch`, 'ignored');
    const otherPort = await rawRequest(`http://${TEST_HOST_A}:1/v1/batch`, 'ignored');

    expect([foreign.status, otherPort.status]).toEqual([502, 502]);
    expect(server.requests).toHaveLength(0);
  });

  it('builds origins and URLs for a host', () => {
    expect(server.origin()).toBe(`http://127.0.0.1:${String(server.port)}`);
    expect(server.url('/v1/batch', TEST_HOST_A)).toBe(`http://a.rubicon.test:${String(server.port)}/v1/batch`);
  });
});

describe('closing', () => {
  it('stops listening, rejects waiters and never sends a delayed answer', async () => {
    const own = await TestServer.start();
    own.enqueue({ status: 200, delayMs: 10_000 });
    const pending = fetch(own.url('/v1/batch'), { method: 'POST' }).then(
      () => 'answered',
      () => 'failed',
    );
    await own.takeRequest();
    const waiting = own.takeRequest();

    await own.close();

    await expect(waiting).rejects.toThrow('closed');
    expect(await pending).toBe('failed');
    await expect(fetch(own.url('/v1/batch'))).rejects.toBeInstanceOf(TypeError);
  });
});
