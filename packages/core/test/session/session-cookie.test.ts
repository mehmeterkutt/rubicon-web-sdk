import { describe, expect, it } from 'vitest';
import {
  decodeSessionCookie,
  encodeSessionCookie,
  identityCookieName,
  keyHash,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  sessionCookieName,
} from '../../src';
import type { CookieWrite, SessionState } from '../../src';

const SESSION_ID = '0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f';
const EPOCH = '0123456789abcdef';
const T0 = 1_759_147_200_000;
const SESSION: SessionState = { id: SESSION_ID, startedAt: T0, lastActivity: T0 + 90_000, personEpoch: EPOCH };
const NAME = sessionCookieName(keyHash('test-api-key'));

// What `document.cookie = ...` receives, the attributes as the browser jar writes them (step 7.2);
// RFC 6265 section 6.1 asks browsers to keep at least 4096 bytes of it.
function setCookieText(cookie: CookieWrite): string {
  const domain = cookie.domain === undefined ? '' : `; Domain=${cookie.domain}`;
  const secure = cookie.secure ? '; Secure' : '';
  return `${cookie.name}=${cookie.value}${domain}; Path=${cookie.path}; Max-Age=${String(cookie.maxAgeSeconds)}; SameSite=${cookie.sameSite}${secure}`;
}

describe('the session cookie', () => {
  describe('its name', () => {
    it('is the identity cookie name and _s', () => {
      expect(NAME).toBe(`${identityCookieName(keyHash('test-api-key'))}_s`);
      expect(NAME).toMatch(/^rubicon_[0-9a-f]{16}_s$/);
    });
  });

  describe('its grammar', () => {
    it('is the version, the session id, the start, the last activity and the epoch, separated by dots', () => {
      expect(encodeSessionCookie(SESSION)).toBe(`1.${SESSION_ID}.1759147200000.1759147290000.${EPOCH}`);
    });

    it('reads back what it writes', () => {
      const sessions: SessionState[] = [
        SESSION,
        { ...SESSION, lastActivity: SESSION.startedAt },
        { ...SESSION, startedAt: 0, lastActivity: 0 },
        { ...SESSION, lastActivity: Number.MAX_SAFE_INTEGER },
      ];
      for (const session of sessions) expect(decodeSessionCookie(encodeSessionCookie(session))).toEqual(session);
    });

    it('writes times as whole non-negative milliseconds', () => {
      expect(encodeSessionCookie({ ...SESSION, startedAt: -5, lastActivity: 12.75 })).toBe(
        `1.${SESSION_ID}.0.12.${EPOCH}`,
      );
    });

    it('writes only cookie octets and needs no percent-encoding (RFC 6265 section 4.1.1)', () => {
      expect(encodeSessionCookie(SESSION)).toMatch(/^[0-9a-f.-]+$/);
    });

    it('a value this version cannot read is unreadable, never a missing session', () => {
      const invalid = [
        '',
        'garbage',
        `2.${SESSION_ID}.${String(T0)}.${String(T0)}.${EPOCH}`,
        `.${SESSION_ID}.${String(T0)}.${String(T0)}.${EPOCH}`,
        `1.${SESSION_ID}.${String(T0)}.${String(T0)}`,
        `1.${SESSION_ID}.${String(T0)}.${String(T0)}.${EPOCH}.`,
        `1.${SESSION_ID}.${String(T0)}.${String(T0)}.${EPOCH}.extra`,
        `1.${SESSION_ID.toUpperCase()}.${String(T0)}.${String(T0)}.${EPOCH}`,
        `1.not-a-uuid.${String(T0)}.${String(T0)}.${EPOCH}`,
        `1.${SESSION_ID}.0${String(T0)}.${String(T0)}.${EPOCH}`,
        `1.${SESSION_ID}.-1.${String(T0)}.${EPOCH}`,
        `1.${SESSION_ID}.1e3.${String(T0)}.${EPOCH}`,
        `1.${SESSION_ID}.${String(T0)}.${String(T0)}5.${EPOCH}0`,
        `1.${SESSION_ID}.${String(T0)}..${EPOCH}`,
        `1.${SESSION_ID}.9007199254740992.9007199254740992.${EPOCH}`,
        `1.${SESSION_ID}.${String(T0 + 1)}.${String(T0)}.${EPOCH}`,
        `1.${SESSION_ID}.${String(T0)}.${String(T0)}.0123`,
        `1.${SESSION_ID}.${String(T0)}.${String(T0)}.${EPOCH.toUpperCase()}`,
        `"1.${SESSION_ID}.${String(T0)}.${String(T0)}.${EPOCH}"`,
      ];
      for (const text of invalid) expect(decodeSessionCookie(text), text).toBeUndefined();
    });
  });

  describe('its size (Web Session 2)', () => {
    it('is 110 bytes of name and value, the size the page counts, whatever the session', () => {
      expect(Buffer.byteLength(`${NAME}=${encodeSessionCookie(SESSION)}`, 'utf8')).toBe(110);
    });

    it('stays below 4096 bytes with its attributes at the worst case', () => {
      const worst: CookieWrite = {
        name: NAME,
        value: encodeSessionCookie({
          ...SESSION,
          startedAt: Number.MAX_SAFE_INTEGER,
          lastActivity: Number.MAX_SAFE_INTEGER,
        }),
        domain: `${'a'.repeat(63)}.`.repeat(3) + 'a'.repeat(61),
        path: '/',
        maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
        sameSite: 'Lax',
        secure: true,
      };

      expect(worst.domain).toHaveLength(253);
      expect(Buffer.byteLength(setCookieText(worst), 'utf8')).toBe(423);
    });

    it('lives 12 hours, the session maximum', () => {
      expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(43_200);
    });
  });
});
