import { SeededRandom } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { daysFromCivil, formatIsoDate, ISO_MAX_MILLIS, ISO_MIN_MILLIS } from '../../src';

// The Android IsoDatesTest, ported. Android formats with its own calendar arithmetic and checks it
// against java.time; the web formats with `toISOString` (Web Serialization 2), checked here against
// the Android table and against the Android arithmetic, ported below as the reference. The same
// table runs in the three engines in step 8.1.

const MILLIS_PER_DAY = 86_400_000;

/** The Android `IsoDates.civilFromDays`: the year, month (1 to 12) and day of `days` since 1970. */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthFromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1;
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/** The Android `IsoDates.format`, the reference for the random instants. */
function androidFormat(millis: number): string {
  const days = Math.floor(millis / MILLIS_PER_DAY);
  const millisOfDay = millis - days * MILLIS_PER_DAY;
  const [year, month, day] = civilFromDays(days);
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(Math.floor(millisOfDay / 3_600_000), 2)}:` +
    `${pad(Math.floor(millisOfDay / 60_000) % 60, 2)}:${pad(Math.floor(millisOfDay / 1_000) % 60, 2)}.` +
    `${pad(millisOfDay % 1_000, 3)}Z`
  );
}

describe('formatIsoDate', () => {
  it.each([
    [0, '1970-01-01T00:00:00.000Z'],
    [999, '1970-01-01T00:00:00.999Z'],
    [-1, '1969-12-31T23:59:59.999Z'],
    [-2208988800000, '1900-01-01T00:00:00.000Z'],
    [946684799999, '1999-12-31T23:59:59.999Z'],
    [946684800000, '2000-01-01T00:00:00.000Z'],
    [951782400000, '2000-02-29T00:00:00.000Z'],
    [1709210096789, '2024-02-29T12:34:56.789Z'],
    [4107542400000, '2100-03-01T00:00:00.000Z'],
    [1759147200123, '2025-09-29T12:00:00.123Z'],
    [-62167219200000, '0000-01-01T00:00:00.000Z'],
    [253402300799999, '9999-12-31T23:59:59.999Z'],
  ])('formats known instants: %d is %s', (millis, expected) => {
    expect(formatIsoDate(new Date(millis))).toBe(expected);
    expect(androidFormat(millis)).toBe(expected);
  });

  it('instants outside the years 0000 to 9999 are unsupported', () => {
    expect(formatIsoDate(new Date(ISO_MIN_MILLIS - 1))).toBeUndefined();
    expect(formatIsoDate(new Date(ISO_MAX_MILLIS + 1))).toBeUndefined();
    // The ECMAScript limits, ±8.64e15, where `toISOString` writes six-digit years.
    expect(formatIsoDate(new Date(-8.64e15))).toBeUndefined();
    expect(formatIsoDate(new Date(8.64e15))).toBeUndefined();
  });

  it('an invalid date is unsupported', () => {
    expect(formatIsoDate(new Date(NaN))).toBeUndefined();
    expect(formatIsoDate(new Date('not a date'))).toBeUndefined();
  });

  it('agrees with the Android arithmetic on 100 000 random instants', () => {
    const random = new SeededRandom(2024);
    const span = ISO_MAX_MILLIS - ISO_MIN_MILLIS + 1;
    for (let i = 0; i < 100_000; i += 1) {
      // 53 random bits from two draws, scaled into the range.
      const fraction = ((random.nextUint32() >>> 5) * 2 ** 26 + (random.nextUint32() >>> 6)) / 2 ** 53;
      const millis = ISO_MIN_MILLIS + Math.floor(fraction * span);
      const actual = formatIsoDate(new Date(millis));
      if (actual !== androidFormat(millis)) expect(actual, `at ${String(millis)}`).toBe(androidFormat(millis));
    }
  });

  it('never runs a method replaced on the object', () => {
    const date = new Date(0);
    Object.defineProperty(date, 'toISOString', { value: () => 'replaced' });
    Object.defineProperty(date, 'getTime', { value: () => Number.NaN });

    expect(formatIsoDate(date)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('a value that only claims to be a Date is unsupported, not an exception', () => {
    const impostor = { [Symbol.toStringTag]: 'Date' } as unknown as Date;

    expect(Object.prototype.toString.call(impostor)).toBe('[object Date]');
    expect(formatIsoDate(impostor)).toBeUndefined();
  });
});

describe('daysFromCivil', () => {
  it('day arithmetic round-trips over the whole supported range', () => {
    const first = Math.floor(ISO_MIN_MILLIS / MILLIS_PER_DAY);
    const last = Math.floor(ISO_MAX_MILLIS / MILLIS_PER_DAY);
    for (let day = first; day <= last; day += 1) {
      const [year, month, dayOfMonth] = civilFromDays(day);
      const back = daysFromCivil(year, month, dayOfMonth);
      if (back !== day) expect(back, `at day ${String(day)}`).toBe(day);
    }
    expect(civilFromDays(0)).toEqual([1970, 1, 1]);
  });

  it('agrees with the engine on the first day of every year from 0000 to 9999', () => {
    for (let year = 0; year <= 9999; year += 1) {
      const date = new Date(0);
      date.setUTCFullYear(year, 0, 1);
      const expected = date.getTime() / MILLIS_PER_DAY;
      if (daysFromCivil(year, 1, 1) !== expected)
        expect(daysFromCivil(year, 1, 1), `in ${String(year)}`).toBe(expected);
    }
  });
});
