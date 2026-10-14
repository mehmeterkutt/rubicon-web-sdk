import type { CookieWrite } from 'rubicon-analytics-core';
import { describe, expect, it } from 'vitest';
import { MemoryCookieJar, MemoryCookieStore, TestClock } from '../src';

function cookie(name: string, value: string, extra: Partial<CookieWrite> = {}): CookieWrite {
  return { name, value, path: '/', maxAgeSeconds: 3600, sameSite: 'Lax', secure: true, ...extra };
}

function setup(publicSuffixes: string[] = []): { clock: TestClock; a: MemoryCookieJar; b: MemoryCookieJar } {
  const clock = new TestClock();
  const a = new MemoryCookieJar(new MemoryCookieStore(clock, { publicSuffixes }), { host: 'a.rubicon.test' });
  return { clock, a, b: a.otherPage({ host: 'b.rubicon.test' }) };
}

describe('MemoryCookieJar', () => {
  describe('reads like document.cookie', () => {
    it('gives an empty string when there is no cookie', () => {
      expect(setup().a.readAll()).toBe('');
    });

    it('joins name=value pairs with "; " and replaces a cookie of the same name, domain and path', () => {
      const { a } = setup();
      a.write(cookie('rubicon_k', 'v1'));
      a.write(cookie('rubicon_k_s', 's1'));
      a.write(cookie('rubicon_k', 'v2'));
      expect(a.readAll()).toBe('rubicon_k=v2; rubicon_k_s=s1');
      expect(a.store.cookies()).toHaveLength(2);
    });

    it('ends a value at its first semicolon, as an assignment to document.cookie does', () => {
      const { a } = setup();
      a.write(cookie('c', 'value; Domain=evil.test'));
      expect(a.readAll()).toBe('c=value');
    });

    it('lists the cookie with the longer path first, then the older one', () => {
      const { a } = setup();
      const deep = a.otherPage({ path: '/shop/cart' });
      deep.write(cookie('root', '1'));
      deep.write(cookie('shop', '2', { path: '/shop' }));
      expect(deep.readAll()).toBe('shop=2; root=1');
      expect(a.readAll()).toBe('root=1');
    });
  });

  describe('domains (Web Identity 2)', () => {
    it('shares a Domain cookie between the hosts of the site and keeps a host-only one on its host', () => {
      const { a, b } = setup();
      a.write(cookie('shared', '1', { domain: 'rubicon.test' }));
      a.write(cookie('local', '2'));
      expect(b.readAll()).toBe('shared=1');
      expect(a.readAll()).toBe('shared=1; local=2');
    });

    it('accepts a leading dot and any letter case in the Domain attribute', () => {
      const { a, b } = setup();
      a.write(cookie('shared', '1', { domain: '.Rubicon.TEST' }));
      expect(b.readAll()).toBe('shared=1');
      expect(a.store.cookies()[0]).toMatchObject({ domain: 'rubicon.test', hostOnly: false });
    });

    it('refuses a Domain that is a public suffix, which is how the domain probe finds the registrable domain', () => {
      const { a } = setup();
      a.write(cookie('__rubicon_dmn_probe', '1', { domain: 'test' }));
      expect(a.readAll()).toBe('');
      a.write(cookie('__rubicon_dmn_probe', '1', { domain: 'rubicon.test' }));
      expect(a.readAll()).toBe('__rubicon_dmn_probe=1');
    });

    it('refuses a multi-label public suffix from the list', () => {
      const clock = new TestClock();
      const jar = new MemoryCookieJar(new MemoryCookieStore(clock, { publicSuffixes: ['co.uk'] }), {
        host: 'shop.example.co.uk',
      });
      jar.write(cookie('probe', '1', { domain: 'co.uk' }));
      expect(jar.readAll()).toBe('');
      jar.write(cookie('probe', '1', { domain: 'example.co.uk' }));
      expect(jar.readAll()).toBe('probe=1');
    });

    it('refuses a Domain that is not the page’s', () => {
      const { a } = setup();
      a.write(cookie('c', '1', { domain: 'other.test' }));
      a.write(cookie('c', '1', { domain: 'b.rubicon.test' }));
      expect(a.store.cookies()).toHaveLength(0);
    });

    it('keeps localhost and an IP address host-only', () => {
      const clock = new TestClock();
      const store = new MemoryCookieStore(clock);
      const localhost = new MemoryCookieJar(store, { host: 'localhost', secure: false });
      localhost.write(cookie('c', '1', { domain: 'localhost', secure: false }));
      expect(store.cookies()[0]).toMatchObject({ domain: 'localhost', hostOnly: true });
      const ip = new MemoryCookieJar(store, { host: '127.0.0.1', secure: false });
      ip.write(cookie('d', '1', { domain: '0.0.1', secure: false }));
      expect(ip.readAll()).toBe('');
    });
  });

  describe('attributes', () => {
    it('expires a cookie by Max-Age on the clock', () => {
      const { clock, a } = setup();
      a.write(cookie('s', '1', { maxAgeSeconds: 12 * 3600 }));
      clock.advanceBy(12 * 3600 * 1000 - 1);
      expect(a.readAll()).toBe('s=1');
      clock.advanceBy(1);
      expect(a.readAll()).toBe('');
    });

    it('deletes a cookie with Max-Age zero', () => {
      const { a, b } = setup();
      a.write(cookie('shared', '1', { domain: 'rubicon.test' }));
      b.write(cookie('shared', '', { domain: 'rubicon.test', maxAgeSeconds: 0 }));
      expect(a.readAll()).toBe('');
    });

    it('ignores Secure on an http page and hides a Secure cookie from one', () => {
      const { a } = setup();
      const plain = a.otherPage({ secure: false });
      plain.write(cookie('secure', '1'));
      expect(a.readAll()).toBe('');
      a.write(cookie('secure', '1'));
      plain.write(cookie('plain', '2', { secure: false }));
      expect(plain.readAll()).toBe('plain=2');
      expect(a.readAll()).toBe('secure=1; plain=2');
    });

    it('keeps the attributes it was given', () => {
      const { clock, a } = setup();
      a.write(cookie('c', '1', { domain: 'rubicon.test', sameSite: 'Lax', maxAgeSeconds: 60 }));
      expect(a.store.cookies()[0]).toEqual({
        name: 'c',
        value: '1',
        domain: 'rubicon.test',
        hostOnly: false,
        path: '/',
        expiresAt: clock.now() + 60_000,
        sameSite: 'Lax',
        secure: true,
        createdAt: clock.now(),
      });
    });
  });

  describe('fault injection produces each failure as the browser would', () => {
    it('throws a SecurityError DOMException on read and write when access fails', () => {
      const { a } = setup();
      a.failAccess = true;
      expect(() => a.readAll()).toThrow(expect.objectContaining({ name: 'SecurityError' }));
      expect(() => {
        a.write(cookie('c', '1'));
      }).toThrow(DOMException);
    });

    it('ignores writes silently when cookies are blocked, so only a read back tells', () => {
      const { a } = setup();
      a.write(cookie('kept', '1'));
      a.blockWrites = true;
      a.write(cookie('c', '1'));
      expect(a.readAll()).toBe('kept=1');
    });

    it('ignores a cookie whose name and value pass 4096 characters', () => {
      const { a } = setup();
      a.write(cookie('c', 'x'.repeat(4095)));
      expect(a.readAll()).toBe(`c=${'x'.repeat(4095)}`);
      a.write(cookie('d', 'x'.repeat(4096)));
      expect(a.store.cookies()).toHaveLength(1);
    });
  });
});
