import { ETAG, REQUEST_ID, RETRY_AFTER, utf8ByteLength } from 'rubicon-analytics-core';
import type { HttpCall, HttpOutcome, HttpRequest, HttpTransport, Scheduler } from 'rubicon-analytics-core';
import { gzip, usableCompressionStream } from './compression';

// The browser's `HttpTransport` (Web HTTP 1 to 3, step 7.3): one `fetch` per request with the options
// of Web HTTP 1, gzip where the browser can (Web HTTP 2), and what `fetch` gave reported raw. The
// classification of Web HTTP 3, the 45-second deadline and the log lines are the core's `HttpClient`
// (step 5.1); this file never decides what a result means. Never `XMLHttpRequest` or `sendBeacon`
// (Web Queue 3), and `fetch` is read from the page at every request, never replaced (Web Lifecycle 6).

/** The response headers the core reads (Retry-After, ETag, X-Request-Id), when the backend exposes them (Web HTTP 4). */
const READ_HEADERS: readonly string[] = [RETRY_AFTER, ETAG, REQUEST_ID];

const CONTENT_ENCODING = 'Content-Encoding';

/**
 * `fetch` behind the core's `HttpTransport`. Every request:
 *
 * - `mode: "cors"`, `credentials: "omit"` (no cookie of the site or of the host travels),
 *   `redirect: "manual"` (a redirect arrives as an `opaqueredirect`, without its target, and never
 *   carries `Authorization` elsewhere), `referrerPolicy: "no-referrer"`, `cache: "no-store"` (the
 *   SDK keeps the `ETag` itself), `priority: "low"`, `keepalive` as the uploader decided (Web Queue
 *   5). Options a browser does not know are ignored by it, so nothing is detected for them.
 * - The core's headers as given, plus `Content-Encoding: gzip` only when the body was compressed.
 * - An `AbortController` where the browser has one, for the core's `abort()` at its deadline; without
 *   one `abort()` does nothing and the core ignores the late answer (Web HTTP 1).
 * - gzip only when the core allows it (`compress`, never on the hiding and `pagehide` paths), the
 *   browser has a usable `CompressionStream` and compressing works; otherwise the body goes as it is
 *   and, without compression, `fetch` starts synchronously inside `send` (Web HTTP 2).
 *
 * The outcome is reported once, never inside `send`: a response with its status, the three headers
 * the core reads and the body only where the core keeps it (an error status, or a configuration
 * answer; never an upload's success); or the rejection, whose `name` the core reads (Web HTTP 3).
 * Nothing throws and no Promise chain is left without a handler (root `CLAUDE.md`, non-negotiable 1).
 */
export function createFetchTransport(scheduler: Scheduler): HttpTransport {
  return {
    send(request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void): HttpCall {
      return sendRequest(request, onOutcome, scheduler);
    },
  };
}

function sendRequest(request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void, scheduler: Scheduler): HttpCall {
  let reported = false;
  let inSend = true;
  let aborted = false;
  const report = (outcome: HttpOutcome): void => {
    if (reported) return;
    reported = true;
    if (inSend) {
      // A failure found inside `send` is reported on a later turn, as the interface requires.
      scheduler.yield(() => {
        deliver(onOutcome, outcome);
      });
    } else {
      deliver(onOutcome, outcome);
    }
  };
  const controller = newAbortController();

  const start = (body: string | ArrayBuffer | undefined, compressed: boolean): void => {
    // Without an `AbortController` a request the core gave up on while it was being compressed is
    // not started at all; the core ignores whatever is reported after its deadline.
    if (aborted && controller === undefined) {
      report({ kind: 'rejected', error: undefined });
      return;
    }
    const sentBytes =
      body === undefined ? undefined : typeof body === 'string' ? utf8ByteLength(body) : body.byteLength;
    try {
      // `Promise.resolve` also takes what a wrapped `fetch` of another script returns.
      Promise.resolve(startFetch(request, body, compressed, controller))
        .then((response) => readResponse(request, response, sentBytes))
        .then(report, (error: unknown) => {
          report({ kind: 'rejected', error });
        });
    } catch (error) {
      report({ kind: 'rejected', error });
    }
  };

  const body = request.body;
  const compression = body !== undefined && request.compress ? usableCompressionStream() : undefined;
  if (body !== undefined && compression !== undefined) {
    gzip(body, compression).then(
      (compressed) => {
        start(compressed, true);
      },
      () => {
        // The broken or failing compressor costs the compression, never the request (Web HTTP 2).
        start(body, false);
      },
    );
  } else {
    start(body, false);
  }
  inSend = false;

  return {
    abort: () => {
      aborted = true;
      try {
        controller?.abort();
      } catch {
        // The core has reported its timeout already; a request that cannot be cancelled runs out.
      }
    },
  };
}

// The `fetch` of the page at this moment, called with the window as `this`, as the browser requires.
function startFetch(
  request: HttpRequest,
  body: string | ArrayBuffer | undefined,
  compressed: boolean,
  controller: AbortController | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(request.headers)) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (compressed) headers[CONTENT_ENCODING] = 'gzip';
  const init: RequestInit = {
    method: request.method,
    mode: 'cors',
    credentials: 'omit',
    redirect: 'manual',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    priority: 'low',
    keepalive: request.keepalive,
    headers,
  };
  if (body !== undefined) init.body = body;
  if (controller !== undefined) init.signal = controller.signal;
  return window.fetch.call(window, request.url, init);
}

// What `fetch` gave, as the core's outcome. The body is read only where the core keeps it: an error
// status (up to 4 KB) and a configuration answer other than 304 (up to 64 KB); an upload's success
// body is never read (Retry 4). A body that cannot be read leaves the status, which is what Retry
// decides on (plan section 15, step 7.3).
function readResponse(request: HttpRequest, response: Response, sentBytes: number | undefined): Promise<HttpOutcome> {
  if (response.type === 'opaqueredirect') {
    return Promise.resolve(withBytes({ kind: 'response', status: 0, opaqueRedirect: true }, sentBytes));
  }
  const status = response.status;
  const outcome = withBytes({ kind: 'response', status, headers: readHeaders(response.headers) }, sentBytes);
  const success = status >= 200 && status <= 299;
  const keepsBody = request.method === 'GET' ? status !== 304 : !success;
  if (!keepsBody) return Promise.resolve(outcome);
  return response.text().then(
    (text): HttpOutcome => ({ ...outcome, body: text }),
    (): HttpOutcome => outcome,
  );
}

function withBytes(
  outcome: Extract<HttpOutcome, { kind: 'response' }>,
  sentBytes: number | undefined,
): Extract<HttpOutcome, { kind: 'response' }> {
  return sentBytes === undefined ? outcome : { ...outcome, sentBytes };
}

// Only what the page may read: from another origin the headers the backend exposes (Web HTTP 4).
function readHeaders(headers: Headers): Record<string, string> {
  const read = Object.create(null) as Record<string, string>;
  for (const name of READ_HEADERS) {
    try {
      const value = headers.get(name);
      if (value !== null) read[name] = value;
    } catch {
      // A header the page cannot read is absent.
    }
  }
  return read;
}

// Below Chrome 66, Firefox 57 and Safari 12.1 there is none (Web HTTP 1).
function newAbortController(): AbortController | undefined {
  try {
    return typeof AbortController === 'function' ? new AbortController() : undefined;
  } catch {
    return undefined;
  }
}

// The core's callback runs behind its own catch (`DefaultAnalytics`); one that throws anyway must not
// leave a rejected Promise in the page.
function deliver(onOutcome: (outcome: HttpOutcome) => void, outcome: HttpOutcome): void {
  try {
    onOutcome(outcome);
  } catch {
    // Nothing more can be done for this request without risking the page.
  }
}
