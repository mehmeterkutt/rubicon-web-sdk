import { daysFromCivil } from './iso-dates';

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parses the HTTP date form of `Retry-After` (Retry 3, Web HTTP 1): the IMF-fixdate of RFC 9110,
 * section 5.6.7, such as `Sun, 06 Nov 1994 08:49:37 GMT`, into epoch milliseconds; `undefined` when
 * the value is not an IMF-fixdate or not a real date. A port of the Android `HttpDates`.
 *
 * The two obsolete forms that RFC 9110 asks recipients to accept (RFC 850, `Sunday, 06-Nov-94 ...`,
 * and asctime, `Sun Nov  6 08:49:37 1994`) are not parsed, and the header then counts as absent; the
 * day name is not checked against the date, since RFC 9110 makes it redundant; a leap second counts
 * as the first second of the next minute (Android log 2.3).
 */
export function parseHttpDate(value: string): number | undefined {
  const match = IMF_FIXDATE.exec(value.trim());
  if (match === null) return undefined;
  const day = Number(match[2]);
  const month = MONTHS.indexOf(match[3] ?? '') + 1;
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  if (day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 60) return undefined;
  return ((daysFromCivil(year, month, day) * 24 + hour) * 60 + minute) * 60_000 + second * 1_000;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}
