import { parseHttpDate } from '../util/http-dates';

const DIGITS = /^[0-9]+$/;

/**
 * `Retry-After` in milliseconds from `now` (HTTP 4, Web HTTP 3), the Android `retryAfterMs`: whole
 * seconds or an IMF-fixdate; `undefined` when absent or invalid (`1.5`, `-5`, the obsolete date
 * forms). A number of seconds too large for a safe integer of milliseconds gives
 * `Number.MAX_SAFE_INTEGER`, the web form of Android's `Long.MAX_VALUE`; a date in the past gives a
 * negative value. The cap and the one-second floor are the retry layer's (Retry 3, Android log 5.1).
 */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (DIGITS.test(text)) {
    const seconds = Number(text);
    return seconds > Number.MAX_SAFE_INTEGER / 1000 ? Number.MAX_SAFE_INTEGER : seconds * 1000;
  }
  const date = parseHttpDate(text);
  return date === undefined ? undefined : date - now;
}
