import { CONSENT_DECISIONS } from '../storage/consent-store';
import type { ConsentDecision, ConsentRecord } from '../storage/consent-store';

/**
 * The version of the cookie's grammar, its first field. A value of another version, or one that
 * breaks the grammar, is unreadable: the `.consent` mirror answers instead (Web Privacy 2), and a new
 * decision overwrites it, since it is the user's latest choice (plan section 15, step 6.5).
 */
export const CONSENT_COOKIE_VERSION = '1';

/** 365 days, as the identity cookie (Web Privacy 2, point 1). */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

// Epoch milliseconds in decimal without a sign, a fraction or leading zeros.
const TIME = /^(0|[1-9][0-9]{0,15})$/;
const SEPARATOR = '.';
const FIELDS = 3;

/** The consent cookie's name: `rubicon_<keyHash>_c` (Web Privacy 2). */
export function consentCookieName(keyHash: string): string {
  return `rubicon_${keyHash}_c`;
}

/**
 * The cookie value: `<version>.<state>.<decided_at>`, the state `granted` or `denied` as the mirror
 * writes it and the time in decimal epoch milliseconds, for example `1.denied.1760500000000`; the
 * user's answer (plan section 15, step 6.5). Never an identifier (Web Logging 4 point 1); every
 * character is a cookie octet, so nothing is encoded.
 */
export function encodeConsentCookie(record: ConsentRecord): string {
  return [CONSENT_COOKIE_VERSION, record.state, String(Math.max(0, Math.floor(record.decidedAt)))].join(SEPARATOR);
}

/** The decision in a cookie value, or `undefined` when the value is unreadable. Never throws. */
export function decodeConsentCookie(text: string): ConsentRecord | undefined {
  const fields = text.split(SEPARATOR);
  if (fields.length !== FIELDS) return undefined;
  const [version, state, time] = fields as [string, string, string];
  if (version !== CONSENT_COOKIE_VERSION || !isDecision(state) || !TIME.test(time)) return undefined;
  const decidedAt = Number(time);
  return decidedAt <= Number.MAX_SAFE_INTEGER ? { state, decidedAt } : undefined;
}

function isDecision(text: string): text is ConsentDecision {
  return (CONSENT_DECISIONS as readonly string[]).indexOf(text) >= 0;
}
