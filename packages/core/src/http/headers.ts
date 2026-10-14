// The header names of the SDK's requests (HTTP 5, Configuration 5), the port of the Android
// `Headers`; step 5.1 adds the names the requests use.

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
