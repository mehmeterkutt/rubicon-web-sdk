/** 0000-01-01T00:00:00.000Z, the first instant a date in properties may have (Serialization 4). */
export const ISO_MIN_MILLIS = -62_167_219_200_000;

/** 9999-12-31T23:59:59.999Z, the last instant a date in properties may have (Serialization 4). */
export const ISO_MAX_MILLIS = 253_402_300_799_999;

/**
 * A `Date` as `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` in UTC, the one date format of the wire (Event Model 5,
 * Serialization 4), or `undefined` for an invalid date or one outside the years 0000 to 9999, which
 * are unsupported (Web Serialization 2).
 *
 * The Android `IsoDates` text is `toISOString()`: ECMAScript counts in the proleptic Gregorian
 * calendar and writes exactly this form for those years, so no formatter of our own is needed. The
 * `Date.prototype` methods are called on the value, so a date from another frame works and a method
 * replaced on the object is never run; a value that only claims to be a `Date` (through
 * `Symbol.toStringTag`) is unsupported, never an exception.
 */
export function formatIsoDate(date: Date): string | undefined {
  try {
    const millis = Date.prototype.getTime.call(date);
    // NaN, an invalid date, fails both comparisons.
    if (!(millis >= ISO_MIN_MILLIS && millis <= ISO_MAX_MILLIS)) return undefined;
    return Date.prototype.toISOString.call(date);
  } catch {
    return undefined;
  }
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date; `month` is 1 to 12. The Android
 * `IsoDates.daysFromCivil`, used by the HTTP date parser: `Date.UTC` would read the years 0 to 99 as
 * 1900 to 1999.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  // Howard Hinnant's algorithm, with years starting in March so the leap day comes last.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthFromMarch = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthFromMarch + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}
