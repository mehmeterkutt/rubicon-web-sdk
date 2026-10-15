// The id masking of Privacy 5c, the port of the Android `NetworkRequestProperties.isId` and `path`:
// a path segment that is all digits, a UUID or hexadecimal longer than 16 characters becomes `:id`.
// One implementation for `context.page.url` and `page.referrer` (Web Context 2) and the `Network
// Request` properties of `createTrackedFetch` (step 7.7).

/** What an id in a path is replaced with. */
export const PATH_ID_MASK = ':id';

const DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LONG_HEX = /^[0-9a-fA-F]{17,}$/;

/** Whether a path segment is an id: all digits, a UUID, or hexadecimal longer than 16 characters. */
export function isPathId(segment: string): boolean {
  return DIGITS.test(segment) || UUID.test(segment) || LONG_HEX.test(segment);
}

/**
 * `path` (as the URL encodes it, such as `location.pathname`) with every id segment replaced by
 * `:id`; empty segments, and so the leading and a trailing slash, are kept as Android keeps them.
 */
export function maskPathIds(path: string): string {
  return path
    .split('/')
    .map((segment) => (isPathId(segment) ? PATH_ID_MASK : segment))
    .join('/');
}
