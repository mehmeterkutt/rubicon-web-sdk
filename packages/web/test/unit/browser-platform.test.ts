import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserPlatform } from '../../src/platform/browser-platform';
import { createBrowserClock } from '../../src/platform/clock';
import { createCryptoRandom } from '../../src/platform/random';
import { createBrowserScheduler } from '../../src/platform/scheduler';
import { createBrowserUrls, pageSchemeOf, readPageHost, readPageScheme } from '../../src/platform/urls';

// The browser Platform of step 7.1: the clock, the random source, the scheduler, the URL parser and
// the page scheme. The signals of step 7.4 are in page-signals.test.ts, the context of step 7.5 in
// browser-context.test.ts. Globals are replaced per test and restored after it.

const replaced = new Map<string, PropertyDescriptor | undefined>();

function replaceGlobal(name: string, value: unknown): void {
  if (!replaced.has(name)) replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterEach(() => {
  for (const [name, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  replaced.clear();
});

describe('the browser clock', () => {
  it('reads Date.now() at every call', () => {
    const clock = createBrowserClock();
    const before = Date.now();
    const now = clock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('the crypto random source', () => {
  it('draws its words from crypto.getRandomValues, sixteen at a time', () => {
    let refills = 0;
    let word = 0;
    replaceGlobal('crypto', {
      getRandomValues(array: Uint32Array) {
        refills += 1;
        for (let i = 0; i < array.length; i += 1) array[i] = word += 1;
        return array;
      },
    });
    const random = createCryptoRandom();
    expect(refills).toBe(0);
    const words = Array.from({ length: 17 }, () => random.nextUint32());
    expect(words).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(refills).toBe(2);
  });

  it('gives integers in [0, 2^32) from the real crypto', () => {
    const random = createCryptoRandom();
    for (let i = 0; i < 100; i += 1) {
      const value = random.nextUint32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });
});

describe('the browser scheduler', () => {
  function recordTimers(): { set: [unknown, number][]; cleared: unknown[] } {
    const record = { set: [] as [unknown, number][], cleared: [] as unknown[] };
    let id = 0;
    replaceGlobal('setTimeout', (task: unknown, delay: number) => {
      record.set.push([task, delay]);
      return (id += 1);
    });
    replaceGlobal('clearTimeout', (timer: unknown) => {
      record.cleared.push(timer);
    });
    return record;
  }

  it('runs after() through setTimeout with the delay, never below zero', () => {
    const timers = recordTimers();
    const task = (): void => undefined;
    const scheduler = createBrowserScheduler();
    scheduler.after(250, task);
    scheduler.after(-5, task);
    expect(timers.set).toEqual([
      [task, 250],
      [task, 0],
    ]);
  });

  it('caps a delay at the longest setTimeout keeps, so it never fires at once', () => {
    const timers = recordTimers();
    createBrowserScheduler().after(2 ** 40, () => undefined);
    expect(timers.set[0]?.[1]).toBe(2_147_483_647);
  });

  it('yields with a zero timer, a new task after which the browser may paint', () => {
    const timers = recordTimers();
    const task = (): void => undefined;
    createBrowserScheduler().yield(task);
    expect(timers.set).toEqual([[task, 0]]);
  });

  it('cancels through clearTimeout with the timer it set', () => {
    const timers = recordTimers();
    const scheduler = createBrowserScheduler();
    scheduler.after(10, () => undefined);
    scheduler.yield(() => undefined).cancel();
    expect(timers.cleared).toEqual([2]);
  });
});

describe('the URL parser and the page scheme', () => {
  it('gives the WHATWG parts of an absolute URL', () => {
    expect(createBrowserUrls().parse('https://user:pw@API.example.com:8443/p?q=1#f')).toEqual({
      protocol: 'https:',
      hostname: 'api.example.com',
      search: '?q=1',
      hash: '#f',
      username: 'user',
      password: 'pw',
    });
  });

  it('gives undefined where new URL throws', () => {
    expect(createBrowserUrls().parse('api.example.com')).toBeUndefined();
    expect(createBrowserUrls().parse('https://')).toBeUndefined();
  });

  it('reads the scheme from location.protocol', () => {
    expect(readPageScheme()).toBe(pageSchemeOf(location.protocol));
    expect(pageSchemeOf('https:')).toBe('https');
    expect(pageSchemeOf('http:')).toBe('http');
    expect(pageSchemeOf('file:')).toBe('other');
    expect(pageSchemeOf('HTTPS:')).toBe('other');
  });

  it('reads the host name from location.hostname, in lower case, and "" where it cannot', () => {
    expect(readPageHost()).toBe(location.hostname.toLowerCase());
    replaceGlobal('location', {
      get hostname(): string {
        return 'WWW.Example.COM';
      },
    });
    expect(readPageHost()).toBe('www.example.com');
    replaceGlobal('location', {
      get hostname(): string {
        throw new Error('no location');
      },
    });
    expect(readPageHost()).toBe('');
  });
});

describe('createBrowserPlatform', () => {
  it('builds every member of the Platform, with the scheme of the page', () => {
    const platform = createBrowserPlatform();
    expect(Object.keys(platform).sort()).toEqual(
      [
        'clock',
        'context',
        'cookies',
        'lifecycle',
        'network',
        'pageHost',
        'pageScheme',
        'random',
        'scheduler',
        'storage',
        'storageEvents',
        'transport',
        'urls',
      ].sort(),
    );
    expect(platform.pageScheme).toBe(readPageScheme());
    expect(platform.pageHost).toBe(location.hostname.toLowerCase());
  });

  it('touches no storage and no cookie', () => {
    const before = { cookie: document.cookie, keys: localStorage.length };
    createBrowserPlatform();
    expect({ cookie: document.cookie, keys: localStorage.length }).toEqual(before);
  });
});
