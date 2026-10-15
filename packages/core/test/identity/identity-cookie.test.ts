import { describe, expect, it } from 'vitest';
import {
  cookieValues,
  decodeIdentityCookie,
  encodeIdentityCookie,
  IDENTITY_COOKIE_MAX_AGE_SECONDS,
  identityCookieName,
  isDeviceId,
  isValidUserId,
  keyHash,
} from '../../src';
import type { CookieWrite, IdentityCookieValue } from '../../src';

const DEVICE_ID = '0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f';
const EPOCH = '0123456789abcdef';
const ANONYMOUS: IdentityCookieValue = { deviceId: DEVICE_ID, userId: null, personEpoch: EPOCH };
const NAME = identityCookieName(keyHash('test-api-key'));

// What `document.cookie = ...` receives for `cookie`, the attributes as the browser jar writes them
// (step 7.2); RFC 6265 section 6.1 asks browsers to keep at least 4096 bytes of it.
function setCookieText(cookie: CookieWrite): string {
  const domain = cookie.domain === undefined ? '' : `; Domain=${cookie.domain}`;
  const secure = cookie.secure ? '; Secure' : '';
  return `${cookie.name}=${cookie.value}${domain}; Path=${cookie.path}; Max-Age=${String(cookie.maxAgeSeconds)}; SameSite=${cookie.sameSite}${secure}`;
}

function identityCookie(value: IdentityCookieValue, domain?: string): CookieWrite {
  return {
    name: NAME,
    value: encodeIdentityCookie(value),
    domain,
    path: '/',
    maxAgeSeconds: IDENTITY_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'Lax',
    secure: true,
  };
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('the identity cookie', () => {
  describe('its name', () => {
    it('is rubicon_ and the key hash', () => {
      expect(NAME).toBe(`rubicon_${keyHash('test-api-key')}`);
      expect(NAME).toMatch(/^rubicon_[0-9a-f]{16}$/);
    });
  });

  describe('its grammar', () => {
    it('is the version, the device id, the epoch and the percent-encoded user id, separated by dots', () => {
      expect(encodeIdentityCookie(ANONYMOUS)).toBe(`1.${DEVICE_ID}.${EPOCH}.`);
      expect(encodeIdentityCookie({ ...ANONYMOUS, userId: 'jane.doe@example.com' })).toBe(
        `1.${DEVICE_ID}.${EPOCH}.jane.doe%40example.com`,
      );
      expect(encodeIdentityCookie({ ...ANONYMOUS, userId: 'a;b c,d"e\\f=g' })).toBe(
        `1.${DEVICE_ID}.${EPOCH}.a%3Bb%20c%2Cd%22e%5Cf%3Dg`,
      );
    });

    it('reads back what it writes, a user id with separators and any Unicode included', () => {
      const users = [null, 'user-42', 'a.b.c', '...', ' padded ', 'Çağrı', '語'.repeat(255), '😀', 'x'.repeat(255)];
      for (const userId of users) {
        const value = { ...ANONYMOUS, userId };
        expect(decodeIdentityCookie(encodeIdentityCookie(value))).toEqual(value);
      }
    });

    it('writes only cookie octets (RFC 6265 section 4.1.1)', () => {
      const all = Array.from({ length: 0x800 }, (_, i) => String.fromCharCode(i + 1)).join('');
      for (let start = 0; start < all.length; start += 255) {
        const text = encodeIdentityCookie({ ...ANONYMOUS, userId: `u${all.slice(start, start + 254)}` });
        expect(text).toMatch(/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/);
      }
    });

    it('never throws on a lone surrogate, which becomes U+FFFD', () => {
      const text = encodeIdentityCookie({ ...ANONYMOUS, userId: 'a\ud800b' });

      expect(decodeIdentityCookie(text)?.userId).toBe('a�b');
    });

    it('a value this version cannot read is unreadable, never a missing identity', () => {
      const invalid = [
        '',
        'garbage',
        `2.${DEVICE_ID}.${EPOCH}.`,
        `.${DEVICE_ID}.${EPOCH}.`,
        `1.${DEVICE_ID}.${EPOCH}`,
        `1.${DEVICE_ID.toUpperCase()}.${EPOCH}.`,
        `1.not-a-uuid.${EPOCH}.`,
        `1.${DEVICE_ID}.0123.`,
        `1.${DEVICE_ID}.${EPOCH.toUpperCase()}.`,
        `1.${DEVICE_ID}.${EPOCH}.%E0%A4%A`,
        `1.${DEVICE_ID}.${EPOCH}.%ED%A0%80`,
        `1.${DEVICE_ID}.${EPOCH}.%20%20`,
        `1.${DEVICE_ID}.${EPOCH}.${'x'.repeat(256)}`,
        `"1.${DEVICE_ID}.${EPOCH}."`,
      ];
      for (const text of invalid) expect(decodeIdentityCookie(text), text).toBeUndefined();
    });
  });

  describe('its size (Web Session 2)', () => {
    it('stays below 4096 bytes with its attributes at the worst case', () => {
      // 255 UTF-16 code units of three-byte characters, nine bytes each when percent-encoded, and
      // the longest domain name a host can have.
      const worst = identityCookie(
        { ...ANONYMOUS, userId: '語'.repeat(255) },
        `${'a'.repeat(63)}.`.repeat(3) + 'a'.repeat(61),
      );

      expect(worst.domain).toHaveLength(253);
      expect(worst.value).toHaveLength(2351);
      expect(utf8Bytes(setCookieText(worst))).toBe(2686);
      expect(utf8Bytes(setCookieText(worst))).toBeLessThan(4096);
    });

    it('a user id of four-byte characters is smaller than the worst case', () => {
      const emoji = identityCookie({ ...ANONYMOUS, userId: '\u{1f600}'.repeat(127) });

      expect(emoji.value.length).toBeLessThan(2351);
    });

    it('has the typical sizes of name and value', () => {
      const size = (userId: string | null): number =>
        utf8Bytes(`${NAME}=${encodeIdentityCookie({ ...ANONYMOUS, userId })}`);

      expect({
        anonymous: size(null),
        uuidUser: size('5f0c8a4e-2b1d-4c3e-9f8a-7b6c5d4e3f2a'),
        emailUser: size('jane.doe@example.com'),
        numericUser: size('1234567'),
      }).toEqual({ anonymous: 81, uuidUser: 117, emailUser: 103, numericUser: 88 });
    });
  });

  describe('the helpers', () => {
    it('isDeviceId accepts the 36 lowercase characters of a UUID only', () => {
      expect(isDeviceId(DEVICE_ID)).toBe(true);
      expect(isDeviceId(DEVICE_ID.toUpperCase())).toBe(false);
      expect(isDeviceId(` ${DEVICE_ID}`)).toBe(false);
      expect(isDeviceId(42)).toBe(false);
    });

    it('isValidUserId takes 1 to 255 code units that are not blank, never trimmed', () => {
      expect(isValidUserId('x'.repeat(255))).toBe(true);
      expect(isValidUserId(' user-42 ')).toBe(true);
      expect(isValidUserId('😀'.repeat(127))).toBe(true);
      expect(isValidUserId('😀'.repeat(128))).toBe(false);
      expect(isValidUserId('x'.repeat(256))).toBe(false);
      expect(isValidUserId('')).toBe(false);
      expect(isValidUserId(' \t\n ')).toBe(false);
      expect(isValidUserId(42)).toBe(false);
      expect(isValidUserId(null)).toBe(false);
    });
  });
});

describe('cookieValues', () => {
  it('finds every value of a name in the document.cookie text, in order', () => {
    expect(cookieValues('a=1; rubicon_x=2; b=3; rubicon_x=4', 'rubicon_x')).toEqual(['2', '4']);
  });

  it('compares names exactly and skips pairs without a name', () => {
    expect(cookieValues('rubicon_xy=1; xrubicon_x=2; rubicon_x; =5; rubicon_x=', 'rubicon_x')).toEqual(['']);
    expect(cookieValues('', 'rubicon_x')).toEqual([]);
  });

  it('keeps the value whole after the first equals sign and trims the spaces around it', () => {
    expect(cookieValues('  rubicon_x = a=b ;c=d', 'rubicon_x')).toEqual(['a=b']);
  });
});
