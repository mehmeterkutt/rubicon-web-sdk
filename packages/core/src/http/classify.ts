import { utf8Prefix } from '../json/utf8-byte-length';
import type { HttpMethod, HttpOutcome } from '../platform/http-transport';
import { ETAG, headerValue, RETRY_AFTER } from './headers';
import type { HttpResult } from './http-result';
import { parseRetryAfter } from './retry-after';

/** The part of an error body kept for the retry layer (HTTP 4). */
export const MAX_ERROR_BODY_BYTES = 4 * 1024;
/** The part of a configuration answer kept; a longer one is cut and its reader rejects it (Android log 5.3). */
export const MAX_CONFIG_BODY_BYTES = 64 * 1024;

/** What the table needs besides the outcome, read when the outcome arrived. */
export interface ClassifyContext {
  /** `GET` is the configuration request, `POST` the upload. */
  readonly method: HttpMethod;
  readonly keepalive: boolean;
  /** `navigator.onLine !== false` when the outcome arrived (Web Retry 2). */
  readonly online: boolean;
  /** For `Retry-After` in its date form. */
  readonly now: number;
}

/**
 * The table of Web HTTP 3, from what the transport reported to the result Retry decides on; never
 * throws. Rows are taken in the page's order, the first that matches wins:
 *
 * | Outcome | Result |
 * |---|---|
 * | `opaqueredirect` | `http-error`, `redirect`, status 0 (group E, `HTTP_REDIRECT`) |
 * | 2xx; 304 to the `GET` | `success`; a `GET` keeps its body (64 KB) and `ETag` |
 * | any other status | `http-error` with 4 KB of the body and `Retry-After` |
 * | `TypeError` while offline | `connect` |
 * | `TypeError` on a `keepalive` request | `keepalive-refused` |
 * | any other `TypeError` | `io` |
 * | anything else, an `AbortError` included | `unexpected` (`HTTP_UNEXPECTED`) |
 *
 * The `AbortError` of the core's own deadline never reaches the table: the `HttpClient` reports the
 * `timeout` itself when the deadline passes, the flag of the page's "a flag plus the name", and
 * ignores what the aborted request reports later. An `AbortError` the core did not cause comes from
 * another script, so it is `unexpected`. Names are compared as strings, which works across frames
 * (Web HTTP 3); the name is never logged or sent.
 */
export function classifyOutcome(outcome: HttpOutcome, context: ClassifyContext): HttpResult {
  if (outcome.kind === 'rejected') {
    if (errorName(outcome.error) !== 'TypeError') return { kind: 'network-failure', failure: 'unexpected' };
    if (!context.online) return { kind: 'network-failure', failure: 'connect' };
    if (context.keepalive) return { kind: 'keepalive-refused' };
    return { kind: 'network-failure', failure: 'io' };
  }
  if (outcome.opaqueRedirect === true) return { kind: 'http-error', status: 0, redirect: true };
  const status = outcome.status;
  const isGet = context.method === 'GET';
  if ((status >= 200 && status <= 299) || (isGet && status === 304)) {
    if (!isGet) return { kind: 'success', status };
    const body = outcome.body === undefined ? undefined : utf8Prefix(outcome.body, MAX_CONFIG_BODY_BYTES);
    const etag = headerValue(outcome.headers, ETAG);
    return {
      kind: 'success',
      status,
      ...(body === undefined ? {} : { body }),
      ...(etag === undefined ? {} : { etag }),
    };
  }
  const body = outcome.body === undefined ? undefined : utf8Prefix(outcome.body, MAX_ERROR_BODY_BYTES);
  const retryAfterMs = parseRetryAfter(headerValue(outcome.headers, RETRY_AFTER), context.now);
  return {
    kind: 'http-error',
    status,
    ...(body === undefined ? {} : { body }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/** The `name` of a thrown value when it is a string; a getter that throws gives `undefined`. */
function errorName(error: unknown): string | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return undefined;
  try {
    const name: unknown = (error as { readonly name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}
