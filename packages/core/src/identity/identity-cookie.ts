import { replaceLoneSurrogates } from '../validation';

/**
 * The identity cookie's contents (Web Identity 1, 4, Web Session 5): the authority for the two ids,
 * with the epoch that ties the session cookie to this person.
 */
export interface IdentityCookieValue {
  /** A UUIDv7 in 36 lowercase characters. */
  readonly deviceId: string;
  /** `null` while anonymous. */
  readonly userId: string | null;
  /** 16 lowercase hex characters (Web Session 5). */
  readonly personEpoch: string;
}

/**
 * The version of the cookie's grammar, its first field. A value of another version is unreadable,
 * so a newer SDK's cookie on another page of the site is never overwritten (Web Identity 1, Disk 7).
 */
export const IDENTITY_COOKIE_VERSION = '1';

/** One year, the identity cookie's lifetime (Web Identity 1, Web Privacy 5). */
export const IDENTITY_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** A `user_id`: 1 to 255 UTF-16 code units, not blank, never trimmed (Identity 3). */
export const MAX_USER_ID_LENGTH = 255;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH = /^[0-9a-f]{16}$/;
const SEPARATOR = '.';

/** The identity cookie's name: `rubicon_<keyHash>` (Web Identity 4). */
export function identityCookieName(keyHash: string): string {
  return `rubicon_${keyHash}`;
}

/** Whether `value` is a device id this SDK would make: 36 lowercase characters of a UUID. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Whether `value` is a `user_id` that `identify` accepts (Identity 3). */
export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_USER_ID_LENGTH && !/^\s*$/.test(value);
}

/**
 * The cookie value: `<version>.<device_id>.<person_epoch>.<user_id>`, the user id last and
 * percent-encoded as UTF-8 by `encodeURIComponent`, empty while anonymous (a valid user id is never
 * empty). Every character is a cookie octet (RFC 6265 section 4.1.1), so the browser keeps the value
 * as written. The user id may contain the separator; it is last, so the first three separators
 * delimit the fields. Lone surrogates were replaced at `identify`; replacing again keeps
 * `encodeURIComponent`, which throws on one, from ever throwing here.
 */
export function encodeIdentityCookie(value: IdentityCookieValue): string {
  const user = value.userId === null ? '' : encodeURIComponent(replaceLoneSurrogates(value.userId));
  return [IDENTITY_COOKIE_VERSION, value.deviceId, value.personEpoch, user].join(SEPARATOR);
}

/**
 * The contents of a cookie value, or `undefined` when it is invalid, which makes the cookie
 * unreadable rather than missing (Web Identity 1): another version, a device id that is not a UUID,
 * an epoch that is not 16 hex characters, broken percent-encoding or a user id `identify` would
 * reject. Never throws.
 */
export function decodeIdentityCookie(text: string): IdentityCookieValue | undefined {
  const first = text.indexOf(SEPARATOR);
  const second = text.indexOf(SEPARATOR, first + 1);
  const third = text.indexOf(SEPARATOR, second + 1);
  if (first < 0 || second < 0 || third < 0) return undefined;
  if (text.slice(0, first) !== IDENTITY_COOKIE_VERSION) return undefined;
  const deviceId = text.slice(first + 1, second);
  const personEpoch = text.slice(second + 1, third);
  if (!isDeviceId(deviceId) || !EPOCH.test(personEpoch)) return undefined;
  const encodedUser = text.slice(third + 1);
  if (encodedUser === '') return { deviceId, userId: null, personEpoch };
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUser);
  } catch {
    return undefined;
  }
  return isValidUserId(userId) ? { deviceId, userId, personEpoch } : undefined;
}

/** Whether two cookie contents are the same. */
export function sameIdentity(a: IdentityCookieValue, b: IdentityCookieValue): boolean {
  return a.deviceId === b.deviceId && a.userId === b.userId && a.personEpoch === b.personEpoch;
}
