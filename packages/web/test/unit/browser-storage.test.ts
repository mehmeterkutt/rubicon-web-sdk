// @vitest-environment-options {"url": "https://a.rubicon.test/"}
import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  consentCookieName,
  CookieDomain,
  encodeConsentCookie,
  encodeIdentityCookie,
  encodeSessionCookie,
  IDENTITY_COOKIE_MAX_AGE_SECONDS,
  identityCookieName,
  keyHash,
  Log,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  sessionCookieName,
  storageReadable,
  storageWritable,
} from 'rubicon-analytics-core';
import type { CookieWrite } from 'rubicon-analytics-core';
import { RecordingSink } from 'rubicon-analytics-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentCookieJar, serializeCookie } from '../../src/platform/document-cookies';
import { createLocalStorage } from '../../src/platform/local-storage';

// `localStorage` and `document.cookie` behind the core's interfaces (step 7.2; Web Disk 1, 4, Web
// Identity 1, 2, Web Privacy 2) in jsdom, on an https page of the test site. What jsdom does not model
// (a sandboxed iframe, each engine's public suffix list) is in test/browser/browser-storage.spec.ts.

const cookie = (fields: Partial<CookieWrite> = {}): CookieWrite => ({
  name: 'rubicon_x',
  value: '1.a',
  path: '/',
  maxAgeSeconds: 60,
  sameSite: 'Lax',
  secure: false,
  ...fields,
});

function clearCookies(): void {
  for (const pair of document.cookie.split('; ')) {
    const name = pair.split('=')[0] ?? '';
    if (name === '') continue;
    document.cookie = `${name}=; Path=/; Max-Age=0`;
    document.cookie = `${name}=; Path=/; Max-Age=0; Domain=rubicon.test`;
  }
}

const replaced: (() => void)[] = [];

afterEach(() => {
  for (const restore of replaced.splice(0)) restore();
  clearCookies();
  localStorage.clear();
});

/** Makes `window.localStorage` throw a `SecurityError`, as in a sandboxed iframe, until the test ends. */
function blockLocalStorage(): void {
  const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  replaced.push(() => {
    if (own) Object.defineProperty(window, 'localStorage', own);
    else Reflect.deleteProperty(window, 'localStorage');
  });
}

describe('the cookie text (Web Identity 1, Web Session 2, Web Privacy 2)', () => {
  it('writes the attributes the core asks for, Domain only when not host-only, Secure only when asked', () => {
    expect(serializeCookie(cookie())).toBe('rubicon_x=1.a; Path=/; Max-Age=60; SameSite=Lax');
    expect(serializeCookie(cookie({ domain: 'rubicon.test', secure: true }))).toBe(
      'rubicon_x=1.a; Path=/; Max-Age=60; SameSite=Lax; Domain=rubicon.test; Secure',
    );
  });

  it('deletes with Max-Age=0, also for a negative age, and writes whole seconds', () => {
    expect(serializeCookie(cookie({ value: '', maxAgeSeconds: 0 }))).toBe(
      'rubicon_x=; Path=/; Max-Age=0; SameSite=Lax',
    );
    expect(serializeCookie(cookie({ maxAgeSeconds: -5 }))).toContain('; Max-Age=0;');
    expect(serializeCookie(cookie({ maxAgeSeconds: 1.9 }))).toContain('; Max-Age=1;');
  });

  it('assigns one cookie per write and reads the whole text', () => {
    const fake = { cookie: 'a=1; b=2' };
    const assigned: string[] = [];
    const jar = createDocumentCookieJar(() => ({
      get cookie() {
        return fake.cookie;
      },
      set cookie(text: string) {
        assigned.push(text);
      },
    }));
    expect(jar.readAll()).toBe('a=1; b=2');
    jar.write(cookie({ secure: true }));
    expect(assigned).toEqual(['rubicon_x=1.a; Path=/; Max-Age=60; SameSite=Lax; Secure']);
  });

  it('every cookie of the SDK with its attributes stays below 4096 bytes at the worst case', () => {
    const hash = keyHash('any key');
    const domain = `${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(61)}`;
    expect(domain).toHaveLength(253);
    const epoch = 'f'.repeat(16);
    const id = '0192e4a1-7c3f-7000-8000-0005deadbeef';
    const time = Number.MAX_SAFE_INTEGER;
    const worst: CookieWrite[] = [
      {
        ...cookie({ domain, secure: true, maxAgeSeconds: IDENTITY_COOKIE_MAX_AGE_SECONDS }),
        name: identityCookieName(hash),
        // 255 code units of a three-byte character, nine bytes each once percent-encoded.
        value: encodeIdentityCookie({ deviceId: id, personEpoch: epoch, userId: '€'.repeat(255) }),
      },
      {
        ...cookie({ domain, secure: true, maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS }),
        name: sessionCookieName(hash),
        value: encodeSessionCookie({ id, startedAt: time, lastActivity: time, personEpoch: epoch }),
      },
      {
        ...cookie({ domain, secure: true, maxAgeSeconds: CONSENT_COOKIE_MAX_AGE_SECONDS }),
        name: consentCookieName(hash),
        value: encodeConsentCookie({ state: 'granted', decidedAt: time }),
      },
    ];
    const sizes = worst.map((write) => new TextEncoder().encode(serializeCookie(write)).length);
    expect(sizes[0]).toBeGreaterThan(2600);
    for (const size of sizes) expect(size).toBeLessThan(4096);
  });
});

describe('the cookie jar over document.cookie in jsdom', () => {
  it('writes, reads back and deletes a host-only cookie', () => {
    const jar = createDocumentCookieJar();
    jar.write(cookie({ secure: true }));
    expect(jar.readAll()).toBe('rubicon_x=1.a');
    jar.write(cookie({ value: '', maxAgeSeconds: 0, secure: true }));
    expect(jar.readAll()).toBe('');
  });

  it('gives the domain probe rubicon.test on a.rubicon.test and deletes the probe', () => {
    const jar = createDocumentCookieJar();
    const sink = new RecordingSink();
    const domain = new CookieDomain({
      cookies: jar,
      host: location.hostname,
      secure: true,
      crossSubdomain: true,
      probeId: () => '0192e4a1-7c3f-7000-8000-0005deadbeef',
      log: new Log({ level: 'debug', debug: false, sink }),
    });
    expect(domain.domain()).toBe('rubicon.test');
    expect(document.cookie).toBe('');
    expect(sink.messages).toEqual([]);
  });

  it('reads document at every access, so a throwing cookie accessor reaches the core as a throw', () => {
    const jar = createDocumentCookieJar(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(() => jar.readAll()).toThrow('insecure');
    expect(() => {
      jar.write(cookie());
    }).toThrow('insecure');
  });
});

describe('the storage over localStorage (Web Disk 1)', () => {
  it('forwards the Web Storage members', () => {
    const storage = createLocalStorage();
    storage.setItem('rubicon.a', '1');
    storage.setItem('rubicon.b', '2');
    expect(storage.length).toBe(2);
    expect(new Set([storage.key(0), storage.key(1)])).toEqual(new Set(['rubicon.a', 'rubicon.b']));
    expect(storage.key(2)).toBeNull();
    expect(storage.getItem('rubicon.a')).toBe('1');
    expect(localStorage.getItem('rubicon.b')).toBe('2');
    storage.removeItem('rubicon.a');
    expect(storage.getItem('rubicon.a')).toBeNull();
    expect(storage.length).toBe(1);
  });

  it('reads window.localStorage at every access, so a SecurityError reaches the core as a throw', () => {
    const storage = createLocalStorage();
    blockLocalStorage();
    expect(() => storage.length).toThrow('insecure');
    expect(() => storage.getItem('a')).toThrow('insecure');
    expect(() => {
      storage.setItem('a', '1');
    }).toThrow('insecure');
    expect(() => storage.key(0)).toThrow('insecure');
    expect(() => {
      storage.removeItem('a');
    }).toThrow('insecure');
  });

  it('lets a QuotaExceededError through to the caller', () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const full = {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => full });
    replaced.push(() => {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else Reflect.deleteProperty(window, 'localStorage');
    });
    expect(() => {
      createLocalStorage().setItem('a', '1');
    }).toThrow('quota');
  });
});

describe('the start probe over localStorage (Web Disk 4; step 7.2, answer 3)', () => {
  it('the read half passes where localStorage can be read, and writes nothing', () => {
    const storage = createLocalStorage();
    expect(storageReadable(storage)).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it('the read half fails where reading localStorage throws', () => {
    const storage = createLocalStorage();
    blockLocalStorage();
    expect(storageReadable(storage)).toBe(false);
  });

  it('the write half writes the empty value, reads it back and leaves no key', () => {
    expect(storageWritable(createLocalStorage(), 'rubicon.0123456789abcdef.probe')).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it('the write half fails on a QuotaExceededError', () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const full = {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      getItem: () => null,
      removeItem: () => undefined,
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => full });
    replaced.push(() => {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else Reflect.deleteProperty(window, 'localStorage');
    });
    expect(storageWritable(createLocalStorage(), 'rubicon.0123456789abcdef.probe')).toBe(false);
  });
});
