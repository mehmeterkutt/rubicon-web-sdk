import { maskPathIds } from 'rubicon-analytics-core';

// The properties of `Network Request` (Lifecycle 1, Privacy 5c, Web Lifecycle 6, Web HTTP 3), the port
// of the Android `NetworkRequestProperties` and `NetworkErrors`: the method, the URL without query or
// fragment, the status, a fixed error value, the duration and the declared sizes. Headers and bodies
// are never read, only declared lengths; nothing here reads, clones or consumes a body.

/** The event's name (Lifecycle 1). */
export const NETWORK_REQUEST = 'Network Request';

/** The request as the tracked `fetch` resolved it before calling the base `fetch`. */
export interface TrackedRequest {
  /** Upper-cased. */
  readonly method: string;
  /** The resolved URL. */
  readonly url: URL;
  /** The declared body length, when known without reading the body. */
  readonly requestBytes: number | undefined;
}

/** The fixed `error` values (Web HTTP 3); never the error's `name` or message. */
export type NetworkError = 'canceled' | 'timeout' | 'network' | 'unknown';

/** What the base `fetch` gave: a response, or the error it rejected with. */
export type FetchOutcome =
  { readonly kind: 'response'; readonly response: unknown } | { readonly kind: 'error'; readonly error: unknown };

/**
 * The event's properties, in Android's order: `method`, `url`, `host`, `path`, `status_code` (when
 * there was a response), `error` (when there was none), `duration_ms`, `request_bytes` and
 * `response_bytes` when known.
 */
export function networkRequestProperties(
  request: TrackedRequest,
  outcome: FetchOutcome,
  durationMs: number,
  masking: boolean,
): Record<string, unknown> {
  const url = request.url;
  const path = masking ? maskPathIds(url.pathname) : url.pathname;
  const properties: Record<string, unknown> = {
    method: request.method,
    // `origin` keeps a port that is not the scheme's default, as Android's `url` does.
    url: url.origin + path,
    host: url.hostname,
    path,
  };
  if (outcome.kind === 'response') {
    const status = statusOf(outcome.response);
    if (status !== undefined) properties.status_code = status;
  } else {
    properties.error = networkErrorOf(outcome.error);
  }
  properties.duration_ms = Math.max(0, durationMs);
  if (request.requestBytes !== undefined) properties.request_bytes = request.requestBytes;
  if (outcome.kind === 'response') {
    const length = responseBytesOf(outcome.response);
    if (length !== undefined) properties.response_bytes = length;
  }
  return properties;
}

/**
 * The fixed `error` of a rejection (Web HTTP 3): `AbortError` is `canceled`, `TimeoutError`
 * `timeout`, `TypeError` `network` (also an invalid URL or header, and a CORS refusal, which `fetch`
 * does not tell apart), anything else `unknown`. The name is compared as a string, which also works
 * for an error of another frame, and is never sent: a script can set it to anything.
 */
export function networkErrorOf(error: unknown): NetworkError {
  let name: unknown;
  try {
    name = typeof error === 'object' && error !== null ? Reflect.get(error, 'name') : undefined;
  } catch {
    return 'unknown';
  }
  switch (name) {
    case 'AbortError':
      return 'canceled';
    case 'TimeoutError':
      return 'timeout';
    case 'TypeError':
      return 'network';
    default:
      return 'unknown';
  }
}

/**
 * The size of a request body known without reading it (Web Lifecycle 6): a `Blob`'s (or `File`'s)
 * `size`, an `ArrayBuffer`'s or a view's `byteLength`. A string, `FormData`, `URLSearchParams`, a
 * stream or no body gives `undefined`: `Content-Length` is a forbidden request header and is decided
 * by the browser. Types are told by `Object.prototype.toString`, never `instanceof`, so a body made
 * in another frame counts too.
 */
export function requestBytesOf(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  try {
    const tag = Object.prototype.toString.call(body);
    if (tag === '[object Blob]' || tag === '[object File]') return lengthOf(Reflect.get(body, 'size'));
    if (tag === '[object ArrayBuffer]' || ArrayBuffer.isView(body)) return lengthOf(Reflect.get(body, 'byteLength'));
    return undefined;
  } catch {
    return undefined;
  }
}

// `Response.status`; 0 for an opaque response, as the browser gives it.
function statusOf(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  try {
    return lengthOf(Reflect.get(response, 'status'));
  } catch {
    return undefined;
  }
}

/**
 * `response_bytes` from `Content-Length`, the encoded length, when present and readable (Web Lifecycle
 * 6): absent for a chunked or opaque response, and for a value that is not one decimal number (two
 * headers joined by a comma). The body is never read.
 */
function responseBytesOf(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  try {
    const headers: unknown = Reflect.get(response, 'headers');
    if (typeof headers !== 'object' || headers === null) return undefined;
    const get: unknown = Reflect.get(headers, 'get');
    if (typeof get !== 'function') return undefined;
    const value: unknown = Reflect.apply(get, headers, ['content-length']);
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    return /^[0-9]+$/.test(text) ? lengthOf(Number(text)) : undefined;
  } catch {
    return undefined;
  }
}

function lengthOf(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && Math.floor(value) === value && isFinite(value) ? value : undefined;
}
