// The header names of the SDK's requests (HTTP 5, Configuration 5, Web HTTP 1), the port of the
// Android `Headers`. No `User-Agent`: the browser sends its own and the SDK names itself in
// `context.library` only (Web HTTP 1).

export const AUTHORIZATION = 'Authorization';
export const CONTENT_TYPE = 'Content-Type';
export const IF_NONE_MATCH = 'If-None-Match';
export const RETRY_AFTER = 'Retry-After';
export const ETAG = 'ETag';
/** Pending backend agreement (HTTP 4, Android log 5.1): a request id the server may return, for the DEBUG line only. */
export const REQUEST_ID = 'X-Request-Id';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const RESERVED: readonly string[] = [
  'authorization',
  'content-type',
  'content-encoding',
  'content-length',
  'user-agent',
  'host',
  'if-none-match',
];
const RESERVED_PREFIX = 'x-rubicon-';

/**
 * Whether `network.headers` may not set `name` because the SDK sets it itself, in any letter case
 * (Configuration 5, Android log 3.1): `toLowerCase` is locale-independent, as Android's
 * `lowercase(Locale.ROOT)`.
 */
export function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED.indexOf(lower) >= 0 || lower.indexOf(RESERVED_PREFIX) === 0;
}

/**
 * The value of the response header `name`, compared in any letter case as HTTP header names are;
 * `undefined` when absent or not exposed to the page (Web HTTP 4).
 */
export function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}
