import { describe, expect, it } from 'vitest';
import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  consentCookieName,
  decodeConsentCookie,
  encodeConsentCookie,
  keyHash,
} from '../../src';

// The consent cookie's grammar, the user's answer of 2026-10-15 (plan section 15, step 6.5):
// `1.<granted|denied>.<decided_at>`, the identity and session cookies' style (Web Privacy 2).

describe('the consent cookie', () => {
  it('is named rubicon_<keyHash>_c and lives 365 days', () => {
    const hash = keyHash('test-api-key');
    expect(consentCookieName(hash)).toBe(`rubicon_${hash}_c`);
    expect(CONSENT_COOKIE_MAX_AGE_SECONDS).toBe(365 * 24 * 60 * 60);
  });

  it('holds the version, the state and the time of the decision, nothing else', () => {
    expect(encodeConsentCookie({ state: 'denied', decidedAt: 1_760_500_000_000 })).toBe('1.denied.1760500000000');
    expect(encodeConsentCookie({ state: 'granted', decidedAt: 0 })).toBe('1.granted.0');
  });

  it('writes a time as whole non-negative milliseconds', () => {
    expect(encodeConsentCookie({ state: 'granted', decidedAt: 12.9 })).toBe('1.granted.12');
    expect(encodeConsentCookie({ state: 'granted', decidedAt: -5 })).toBe('1.granted.0');
  });

  it('reads back what it writes', () => {
    for (const record of [
      { state: 'granted', decidedAt: 1 },
      { state: 'denied', decidedAt: Number.MAX_SAFE_INTEGER },
    ] as const) {
      expect(decodeConsentCookie(encodeConsentCookie(record))).toEqual(record);
    }
  });

  it.each([
    ['another version', '2.denied.1'],
    ['no version', 'denied.1'],
    ['an unknown state', '1.pending.1'],
    ['a state in another case', '1.Denied.1'],
    ['a missing time', '1.denied.'],
    ['a leading zero', '1.denied.01'],
    ['a sign', '1.denied.-1'],
    ['a fraction', '1.denied.1.5'],
    ['a time beyond the safe range', '1.denied.9007199254740993'],
    ['more fields', '1.denied.1.x'],
    ['the mirror’s JSON', '{"state":"denied","decided_at":1}'],
    ['an empty value', ''],
  ])('is unreadable with %s', (_, text) => {
    expect(decodeConsentCookie(text)).toBeUndefined();
  });
});
