import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../../src';

// The `Retry-After` nest of the Android HttpURLConnectionTransportTest with its values (Android log
// 5.1); the response-level cases (429 and 503 carrying it) are in http-client.test.ts.

// Wed, 01 Oct 2026 12:00:00 GMT
const NOW = 1_790_856_000_000;

describe('parseRetryAfter', () => {
  it('reads seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
  });

  it('reads an HTTP date as the time from now', () => {
    expect(parseRetryAfter('Wed, 01 Oct 2026 12:01:00 GMT', NOW)).toBe(60_000);
  });

  it('gives a date in the past as a negative value, left to the retry layer', () => {
    expect(parseRetryAfter('Wed, 01 Oct 2026 11:59:00 GMT', NOW)).toBe(-60_000);
  });

  it.each([
    'soon',
    '-5',
    '1.5',
    'Wednesday, 01-Oct-26 12:01:00 GMT',
    'Wed Oct  1 12:01:00 2026',
    '',
    '   ',
    '1e3',
    '+5',
  ])('treats %j as absent', (value) => {
    expect(parseRetryAfter(value, NOW)).toBeUndefined();
  });

  it('treats a missing header as absent', () => {
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
  });

  it('does not overflow on a huge number of seconds', () => {
    // Android gives Long.MAX_VALUE; JavaScript's largest exact integer is the web's counterpart.
    expect(parseRetryAfter('99999999999999999999', NOW)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseRetryAfter('9223372036854775807', NOW)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseRetryAfter('9007199254740', NOW)).toBe(9_007_199_254_740_000);
    expect(parseRetryAfter('9007199254741', NOW)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('ignores whitespace around the value and reads zero and leading zeros', () => {
    expect(parseRetryAfter(' 30 ', NOW)).toBe(30_000);
    expect(parseRetryAfter('0', NOW)).toBe(0);
    expect(parseRetryAfter('0120', NOW)).toBe(120_000);
  });

  it('accepts only ASCII digits for seconds', () => {
    expect(parseRetryAfter('١٢٠', NOW)).toBeUndefined();
    expect(parseRetryAfter('１２０', NOW)).toBeUndefined();
  });
});
