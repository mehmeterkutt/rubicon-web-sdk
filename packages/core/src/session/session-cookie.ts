import { isDeviceId } from '../identity/identity-cookie';

/**
 * The session shared by every tab and subdomain of the site (Web Session 2, 5), as the session
 * cookie holds it. Times are epoch milliseconds from the `Clock` (Web Session 4).
 */
export interface SessionState {
  /** A UUIDv7 in 36 lowercase characters, from the instance's generator (Session 2). */
  readonly id: string;
  readonly startedAt: number;
  /** Never earlier than `startedAt`; moved only forward (Web Session 5). */
  readonly lastActivity: number;
  /** The identity cookie's epoch when the session started; another epoch makes it stale (Web Session 5). */
  readonly personEpoch: string;
}

/**
 * The version of the cookie's grammar, its first field. A value of another version is unreadable,
 * so a newer SDK's session on another page of the site is never overwritten (Web Identity 1, Disk 7).
 */
export const SESSION_COOKIE_VERSION = '1';

/**
 * Twelve hours, the session maximum, renewed on every write (Web Session 2 as changed on 2026-10-14
 * by Web Privacy 1 and 5): a cookie without an expiry could live for ever in a browser that restores
 * its sessions.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

const EPOCH = /^[0-9a-f]{16}$/;
// Epoch milliseconds in decimal without a sign, a fraction or leading zeros.
const TIME = /^(0|[1-9][0-9]{0,15})$/;
const SEPARATOR = '.';
const FIELDS = 5;

/** The session cookie's name: `rubicon_<keyHash>_s` (Web Session 5). */
export function sessionCookieName(keyHash: string): string {
  return `rubicon_${keyHash}_s`;
}

/**
 * The cookie value: `<version>.<session_id>.<started_at>.<last_activity>.<person_epoch>`, the times
 * in decimal epoch milliseconds. No field holds arbitrary text, so nothing is percent-encoded and
 * every character is a cookie octet (RFC 6265 section 4.1.1). Name and value are 110 bytes, the size
 * Web Session 2 counts. Times are written as whole non-negative milliseconds.
 */
export function encodeSessionCookie(state: SessionState): string {
  return [
    SESSION_COOKIE_VERSION,
    state.id,
    String(wholeMillis(state.startedAt)),
    String(wholeMillis(state.lastActivity)),
    state.personEpoch,
  ].join(SEPARATOR);
}

/**
 * The contents of a cookie value, or `undefined` when it is invalid, which makes the cookie
 * unreadable rather than missing (Web Identity 1, Web Session 2): another version, another number of
 * fields, a session id that is not a UUID, a time that is not a safe whole number, a last activity
 * before the start, or an epoch that is not 16 lowercase hex characters. Never throws.
 */
export function decodeSessionCookie(text: string): SessionState | undefined {
  const fields = text.split(SEPARATOR);
  if (fields.length !== FIELDS) return undefined;
  const [version, id, started, last, personEpoch] = fields as [string, string, string, string, string];
  if (version !== SESSION_COOKIE_VERSION || !isDeviceId(id) || !EPOCH.test(personEpoch)) return undefined;
  const startedAt = parseTime(started);
  const lastActivity = parseTime(last);
  if (startedAt === undefined || lastActivity === undefined || lastActivity < startedAt) return undefined;
  return { id, startedAt, lastActivity, personEpoch };
}

function parseTime(text: string): number | undefined {
  if (!TIME.test(text)) return undefined;
  const value = Number(text);
  return value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

function wholeMillis(time: number): number {
  return Math.max(0, Math.floor(time));
}
