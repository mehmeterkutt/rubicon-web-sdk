// The backend's CORS answer of Web HTTP 4, which the test server gives on every response unless a
// test switches it off. Every SDK request is cross-origin with `Authorization` and a JSON body, so
// the browser preflights it; a response without these headers is hidden from the page.

/** `Access-Control-Allow-Methods` on the preflight answer. */
export const CORS_ALLOW_METHODS = 'POST, GET';

/**
 * The request headers the backend must allow at least (Web HTTP 4). `Authorization` is never
 * covered by the wildcard, so it is listed by name. Names from `network.headers` are added per test
 * with `TestServer.allowHeaders`; the server does not reflect `Access-Control-Request-Headers`, so a
 * header the SDK sends that the contract does not name fails the preflight as it would in the field.
 */
export const CORS_ALLOW_HEADERS: readonly string[] = [
  'Authorization',
  'Content-Type',
  'Content-Encoding',
  'If-None-Match',
];

/** `Access-Control-Expose-Headers` on every response that is not a preflight. */
export const CORS_EXPOSE_HEADERS = 'ETag, Retry-After, X-Request-Id';

/** `Access-Control-Max-Age` on the preflight answer, in seconds (Web HTTP 4). */
export const CORS_MAX_AGE_SECONDS = 7200;

/** The headers of a preflight answer. */
export function preflightHeaders(allowHeaders: readonly string[]): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': allowHeaders.join(', '),
    'Access-Control-Max-Age': String(CORS_MAX_AGE_SECONDS),
  };
}

/** The headers of every other response: 2xx, 304, 3xx, 4xx, 5xx, pages and files. */
export function responseCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
  };
}
