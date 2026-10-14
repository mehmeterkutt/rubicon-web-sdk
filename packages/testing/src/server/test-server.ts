// A small HTTP/1.1 server on `node:http` for the SDK's own tests (D14), the counterpart of
// MockWebServer on Android and `TestHTTPServer` on iOS: scripted answers on the API paths, every API
// request recorded with its gzip body decompressed, the CORS answer of Web HTTP 4 on every response,
// and fixture pages for Playwright. It also answers requests that arrive in a proxy's absolute form,
// which is how WebKit reaches the hostnames of D15 (plan section 15, step 1.3).
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CORS_ALLOW_HEADERS, preflightHeaders, responseCorsHeaders } from './cors';

/** The site of D15: its subdomains share cookies written with `Domain=rubicon.test`. */
export const TEST_SITE = 'rubicon.test';
/** The first host of the site, mapped to the loopback interface in every engine (D15). */
export const TEST_HOST_A = 'a.rubicon.test';
/** The second host of the site. */
export const TEST_HOST_B = 'b.rubicon.test';
/** The address the server listens on, and the host of {@link TestServer.origin} by default. */
export const LOOPBACK_HOST = '127.0.0.1';
/** Requests under this path are API requests: answered from the script and recorded. */
export const API_PATH_PREFIX = '/v1/';

/**
 * A scripted answer. Missing fields mean `200`, no extra headers and an empty body.
 *
 * - `delayMs` holds the answer back after the request has been read and recorded (timeout tests).
 * - `drop` closes the connection without a byte once the request is read (the `io` failure kind,
 *   MockWebServer's `DISCONNECT_AFTER_REQUEST`); after `delayMs` when both are given.
 * - `omitCors` leaves the CORS headers off this answer only: the gateway error page of Web HTTP 4
 *   whose missing headers hide a 429 or a 401 from the page.
 *
 * Headers given here are written after the CORS headers and replace one of the same name.
 */
export interface ScriptedResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly delayMs?: number;
  readonly drop?: boolean;
  readonly omitCors?: boolean;
}

/** An answer that closes the connection without a byte. */
export const DROPPED: ScriptedResponse = { drop: true };

/** A redirect to `location` (Web HTTP 1 refuses to follow it; the page sees `opaqueredirect`). */
export function redirectTo(location: string, status = 302): ScriptedResponse {
  return { status, headers: { Location: location } };
}

/** One received request. */
export interface RecordedRequest {
  readonly method: string;
  /** The host name the client addressed, from the absolute form or the `Host` header. */
  readonly host: string;
  /** The path without the query. */
  readonly path: string;
  /** The query with its `?`, or `""`. */
  readonly query: string;
  /** Every header, names in lower case; repeated headers joined with `", "`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body as it arrived. */
  readonly rawBody: Uint8Array;
  /** `Content-Encoding` is `gzip`. */
  readonly gzip: boolean;
  /** The body as UTF-8 text, decompressed when `gzip`; `""` when it could not be decompressed. */
  readonly body: string;
  /** `false` only when a `gzip` body failed to decompress. */
  readonly bodyDecoded: boolean;
}

/** Options of {@link TestServer.start}. */
export interface TestServerOptions {
  /**
   * Static files: a URL path prefix (ending in `/`) mapped to a directory, for example
   * `{ '/pages/': '<web>/test/browser/pages' }`. Served for `GET` and `HEAD`, never recorded.
   */
  readonly files?: Readonly<Record<string, string>>;
}

interface Waiter {
  readonly index: number;
  readonly resolve: (request: RecordedRequest) => void;
  readonly reject: (error: Error) => void;
}

interface Target {
  readonly host: string;
  readonly path: string;
  readonly query: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The test server. One per Playwright worker (`packages/web/test/browser/fixtures.ts`) or per
 * Vitest file; `reset()` between tests.
 *
 * ```ts
 * const server = await TestServer.start();
 * server.enqueue({ status: 429, headers: { 'Retry-After': '120' } });
 * // ... the SDK uploads to server.origin() ...
 * const request = await server.takeRequest();
 * expect(request.headers['content-encoding']).toBe('gzip');
 * await server.close();
 * ```
 */
export class TestServer {
  /**
   * `false` leaves every CORS header off, the preflight answer's included, for the failure tests
   * of Web HTTP 4. `reset()` turns it on again.
   */
  cors = true;

  /** The port the server listens on, an ephemeral one of the loopback interface. */
  readonly port: number;

  private readonly server: Server;
  private readonly files: readonly (readonly [string, string])[];
  private script: ScriptedResponse[] = [];
  private readonly fixed = new Map<string, ScriptedResponse>();
  private recorded: RecordedRequest[] = [];
  private preflightRequests: RecordedRequest[] = [];
  private extraAllowHeaders: string[] = [];
  private taken = 0;
  private waiters: Waiter[] = [];
  private readonly delays = new Set<NodeJS.Timeout>();

  private constructor(server: Server, files: TestServerOptions['files']) {
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.files = Object.entries(files ?? {}).map(([prefix, directory]) => [prefix, resolve(directory)] as const);
  }

  /** Starts listening on an ephemeral port of the loopback interface. */
  static async start(options: TestServerOptions = {}): Promise<TestServer> {
    const server = createServer();
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', fail);
        done();
      });
    });
    const testServer = new TestServer(server, options.files);
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      testServer.handle(request, response);
    });
    return testServer;
  }

  /** `http://{host}:{port}`; the host form the SDK's `host` setting takes. */
  origin(host: string = LOOPBACK_HOST): string {
    return `http://${host}:${String(this.port)}`;
  }

  /** `http://{host}:{port}{path}`. */
  url(path: string, host: string = LOOPBACK_HOST): string {
    return `${this.origin(host)}${path}`;
  }

  /** Appends answers to the script, used in order by API requests without a fixed answer. */
  enqueue(...responses: ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  /**
   * Always answers `path` with `response`, outside the script: a backend whose `/v1/config` says 404
   * while `/v1/batch` follows the script. A test that scripts answers for requests on more than one
   * connection binds them to paths (iOS log 8.5).
   */
  respond(path: string, response: ScriptedResponse): void {
    this.fixed.set(path, response);
  }

  /** Adds names to the preflight's `Access-Control-Allow-Headers`, for `network.headers` tests. */
  allowHeaders(...names: string[]): void {
    this.extraAllowHeaders.push(...names);
  }

  /** The API requests received so far, oldest first; preflights are in {@link preflights}. */
  get requests(): readonly RecordedRequest[] {
    return this.recorded;
  }

  /** The `OPTIONS` requests received so far, oldest first. */
  get preflights(): readonly RecordedRequest[] {
    return this.preflightRequests;
  }

  /**
   * The next API request not yet taken, in arrival order, waiting for it up to `timeoutMs`; rejects
   * when none arrives in time.
   */
  takeRequest(timeoutMs = 5000): Promise<RecordedRequest> {
    const index = this.taken;
    this.taken += 1;
    const ready = this.recorded[index];
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise<RecordedRequest>((done, fail) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        fail(new Error(`TestServer: no request number ${String(index + 1)} within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      const waiter: Waiter = {
        index,
        resolve: (request) => {
          clearTimeout(timer);
          done(request);
        },
        reject: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      };
      this.waiters.push(waiter);
    });
  }

  /** Forgets the script, fixed answers, recorded requests and extra headers; CORS on again. */
  reset(): void {
    this.rejectWaiters('TestServer: reset while waiting for a request');
    this.script = [];
    this.fixed.clear();
    this.recorded = [];
    this.preflightRequests = [];
    this.extraAllowHeaders = [];
    this.taken = 0;
    this.cors = true;
  }

  /** Stops listening and closes every connection; delayed answers are never sent. */
  async close(): Promise<void> {
    this.rejectWaiters('TestServer: closed while waiting for a request');
    for (const timer of this.delays) clearTimeout(timer);
    this.delays.clear();
    const closed = new Promise<void>((done) => {
      this.server.close(() => {
        done();
      });
    });
    this.server.closeAllConnections();
    await closed;
  }

  private rejectWaiters(message: string): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(new Error(message));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', () => {
      // A client that went away mid-body: nothing to answer.
    });
    request.on('end', () => {
      const target = this.target(request);
      if (target === undefined) {
        // A request for another host through the proxy form: never ours to answer or record.
        response.writeHead(502);
        response.end();
        return;
      }
      const method = request.method ?? 'GET';
      if (method === 'OPTIONS') {
        this.preflightRequests.push(record(request, target, Buffer.concat(chunks)));
        const allowed = [...CORS_ALLOW_HEADERS, ...this.extraAllowHeaders];
        response.writeHead(204, this.cors ? preflightHeaders(allowed) : {});
        response.end();
        return;
      }
      if (target.path.startsWith(API_PATH_PREFIX)) {
        this.answerApi(response, record(request, target, Buffer.concat(chunks)));
        return;
      }
      void this.serveFile(method, target.path, response);
    });
  }

  private answerApi(response: ServerResponse, request: RecordedRequest): void {
    this.recorded.push(request);
    const index = this.recorded.length - 1;
    const waiting = this.waiters.filter((w) => w.index === index);
    this.waiters = this.waiters.filter((w) => w.index !== index);
    for (const waiter of waiting) waiter.resolve(request);

    const answer = this.fixed.get(request.path) ?? this.script.shift() ?? {};
    const delayMs = answer.delayMs ?? 0;
    if (delayMs <= 0) {
      this.send(response, answer);
      return;
    }
    const timer = setTimeout(() => {
      this.delays.delete(timer);
      this.send(response, answer);
    }, delayMs);
    this.delays.add(timer);
  }

  private send(response: ServerResponse, answer: ScriptedResponse): void {
    if (response.destroyed || response.socket === null || response.socket.destroyed) return;
    if (answer.drop === true) {
      response.socket.destroy();
      return;
    }
    const cors = this.cors && answer.omitCors !== true ? responseCorsHeaders() : {};
    const body = answer.body ?? '';
    response.writeHead(answer.status ?? 200, { ...cors, ...answer.headers });
    response.end(typeof body === 'string' ? body : Buffer.from(body));
  }

  private async serveFile(method: string, path: string, response: ServerResponse): Promise<void> {
    const cors = this.cors ? responseCorsHeaders() : {};
    const file = this.resolveFile(path);
    if ((method !== 'GET' && method !== 'HEAD') || file === undefined) {
      response.writeHead(404, cors);
      response.end();
      return;
    }
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      response.writeHead(404, cors);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...cors,
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(method === 'HEAD' ? undefined : content);
  }

  /** The file under a static prefix that `path` names, or `undefined` outside every directory. */
  private resolveFile(path: string): string | undefined {
    for (const [prefix, directory] of this.files) {
      if (!path.startsWith(prefix)) continue;
      let relative: string;
      try {
        relative = decodeURIComponent(path.slice(prefix.length));
      } catch {
        return undefined;
      }
      const file = resolve(join(directory, relative));
      return file.startsWith(directory + sep) ? file : undefined;
    }
    return undefined;
  }

  /**
   * Where the request was addressed. A request in the proxy's absolute form names its target; one
   * for a host that is neither the loopback interface nor the test site, or for another port, is
   * not ours (a browser's background request through the proxy) and gives `undefined`.
   */
  private target(request: IncomingMessage): Target | undefined {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? LOOPBACK_HOST}`);
    } catch {
      return undefined;
    }
    const host = url.hostname;
    const ours = host === LOOPBACK_HOST || host === 'localhost' || host === TEST_SITE || host.endsWith(`.${TEST_SITE}`);
    if (!ours || url.port !== String(this.port)) return undefined;
    return { host, path: url.pathname, query: url.search };
  }
}

function record(request: IncomingMessage, target: Target, rawBody: Buffer): RecordedRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const gzip = (headers['content-encoding'] ?? '').trim().toLowerCase() === 'gzip';
  let body = '';
  let bodyDecoded = true;
  try {
    body = (gzip ? gunzipSync(rawBody) : rawBody).toString('utf8');
  } catch {
    bodyDecoded = false;
  }
  return {
    method: request.method ?? 'GET',
    host: target.host,
    path: target.path,
    query: target.query,
    headers,
    rawBody: new Uint8Array(rawBody),
    gzip,
    body,
    bodyDecoded,
  };
}
