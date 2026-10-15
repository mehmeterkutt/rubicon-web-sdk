import { describe, expect, it } from 'vitest';
import { parseHttpDate } from '../../src';

// The http dates half of the Android HttpDatesAndHashingTest, ported with its values.

describe('parseHttpDate', () => {
  it('parses the IMF-fixdate example of RFC 9110', () => {
    expect(parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT')).toBe(784_111_777_000);
  });

  it('parses other valid dates', () => {
    expect(parseHttpDate('Thu, 01 Jan 1970 00:00:00 GMT')).toBe(0);
    expect(parseHttpDate('Thu, 29 Feb 2024 12:34:56 GMT')).toBe(1_709_210_096_000);
    expect(parseHttpDate('Mon, 29 Sep 2025 12:02:00 GMT')).toBe(1_759_147_320_000);
  });

  it('follows the leap year rule for centuries', () => {
    expect(parseHttpDate('Tue, 29 Feb 2000 00:00:00 GMT')).toBe(951_782_400_000);
    expect(parseHttpDate('Mon, 29 Feb 2100 00:00:00 GMT')).toBeUndefined();
  });

  it('ignores whitespace around the value', () => {
    expect(parseHttpDate('  Sun, 06 Nov 1994 08:49:37 GMT \t')).toBe(784_111_777_000);
  });

  it('a leap second counts as the next minute', () => {
    expect(parseHttpDate('Sat, 31 Dec 2016 23:59:60 GMT')).toBe(
      parseHttpDate('Sat, 31 Dec 2016 23:59:59 GMT')! + 1_000,
    );
  });

  it('does not check the day name', () => {
    expect(parseHttpDate('Mon, 06 Nov 1994 08:49:37 GMT')).toBe(784_111_777_000);
  });

  it('reads a year below 100 as written, where Date.UTC would add 1900', () => {
    expect(parseHttpDate('Mon, 01 Jan 0001 00:00:00 GMT')).toBe(-62_135_596_800_000);
  });

  it.each([
    // The obsolete forms of RFC 9110 count as absent.
    'Sunday, 06-Nov-94 08:49:37 GMT',
    'Sun Nov  6 08:49:37 1994',
    // Seconds are Retry-After's other form, parsed elsewhere.
    '120',
    '',
    'Sun, 06 Nov 1994 08:49:37 gmt',
    'sun, 06 Nov 1994 08:49:37 GMT',
    'Sun 06 Nov 1994 08:49:37 GMT',
    'Sun, 6 Nov 1994 08:49:37 GMT',
    'Sun, 06 Nov 94 08:49:37 GMT',
    'Sun, 06 November 1994 08:49:37 GMT',
    'Sun, 06 Nov 1994 08:49:37 UTC',
    'Sun, 06 Nov 1994 08:49:37 +0000',
    'Sun, 06 Nov 1994 08:49 GMT',
    'Sun, 06 Nov 1994 08:49:37 GMT extra',
    'Sun, 31 Nov 1994 08:49:37 GMT',
    'Wed, 29 Feb 2023 00:00:00 GMT',
    'Sun, 00 Nov 1994 08:49:37 GMT',
    'Sun, 06 Nov 1994 24:00:00 GMT',
    'Sun, 06 Nov 1994 08:60:00 GMT',
    'Sun, 06 Nov 1994 08:49:61 GMT',
    // Web additions: digits other than ASCII, and a date split over two lines.
    'Sun, ٠٦ Nov 1994 08:49:37 GMT',
    'Sun, 06 Nov 1994\n08:49:37 GMT',
  ])('rejects anything else: %j', (value) => {
    expect(parseHttpDate(value)).toBeUndefined();
  });
});
