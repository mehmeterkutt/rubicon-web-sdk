import { MemoryCookieJar, MemoryCookieStore, RecordingSink, TestClock } from 'rubicon-analytics-testing';
import type { MemoryCookieStoreOptions } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { CookieDomain, DOMAIN_PROBE_MAX_AGE_SECONDS, DOMAIN_PROBE_PREFIX, Log, SiteCookies } from '../../src';
import type { CookieJar, CookieWrite, IssueCode, LogLevel } from '../../src';

// The domain of the SDK's cookies (Web Identity 2, as changed by Web Logging 3; plan section 15, step
// 7.2), over the in-memory cookie store, which refuses a public suffix as `Domain` as browsers do.

/** A jar that records every write and read, over a {@link MemoryCookieJar}. */
class RecordingJar implements CookieJar {
  readonly writes: CookieWrite[] = [];
  reads = 0;

  constructor(readonly jar: MemoryCookieJar) {}

  readAll(): string {
    this.reads += 1;
    return this.jar.readAll();
  }

  write(cookie: CookieWrite): void {
    this.writes.push(cookie);
    this.jar.write(cookie);
  }
}

interface Setup {
  readonly domain: CookieDomain;
  readonly jar: RecordingJar;
  readonly sink: RecordingSink;
  readonly counted: IssueCode[];
}

interface SetupOptions {
  readonly host?: string;
  readonly secure?: boolean;
  readonly crossSubdomain?: boolean;
  readonly cookieDomain?: string;
  readonly store?: MemoryCookieStoreOptions;
  readonly level?: LogLevel;
  readonly debug?: boolean;
  readonly prepare?: (jar: MemoryCookieJar) => void;
}

function setup(options: SetupOptions = {}): Setup {
  const host = options.host ?? 'a.rubicon.test';
  const memory = new MemoryCookieJar(new MemoryCookieStore(new TestClock(), options.store), {
    host,
    secure: options.secure ?? true,
  });
  options.prepare?.(memory);
  const jar = new RecordingJar(memory);
  const sink = new RecordingSink();
  const counted: IssueCode[] = [];
  const log = new Log({
    level: options.level ?? 'debug',
    debug: options.debug ?? false,
    sink,
    issues: { increment: (code) => counted.push(code) },
  });
  let probes = 0;
  const domain = new CookieDomain({
    cookies: jar,
    host,
    secure: options.secure ?? true,
    crossSubdomain: options.crossSubdomain ?? true,
    cookieDomain: options.cookieDomain,
    probeId: () => `0192e4a1-7c3f-7000-8000-${String((probes += 1)).padStart(12, '0')}`,
    log,
  });
  return { domain, jar, sink, counted };
}

/** The domains the probe was written for, in order; `host-only` for none. */
function probed(jar: RecordingJar): string[] {
  return jar.writes.filter((write) => write.maxAgeSeconds > 0).map((write) => write.domain ?? 'host-only');
}

describe('discovery (Web Identity 2)', () => {
  it('finds the registrable domain from the last label upwards and deletes the probe', () => {
    const { domain, jar, sink } = setup();

    expect(domain.domain()).toBe('rubicon.test');

    expect(probed(jar)).toEqual(['test', 'rubicon.test']);
    expect(jar.jar.store.cookies()).toEqual([]);
    expect(sink.messages).toEqual([]);
  });

  it('names the probe __rubicon_dmn_<uuid>, empty, with the attributes of the cookies it stands for', () => {
    const { domain, jar } = setup();
    domain.domain();

    const [first, ...rest] = jar.writes;
    expect(first?.name).toMatch(new RegExp(`^${DOMAIN_PROBE_PREFIX}[0-9a-f-]{36}$`));
    expect(first).toEqual({
      name: first?.name,
      value: '',
      domain: 'test',
      path: '/',
      maxAgeSeconds: DOMAIN_PROBE_MAX_AGE_SECONDS,
      sameSite: 'Lax',
      secure: true,
    });
    // One name for the whole discovery; the accepted candidate is deleted with its own domain.
    expect(rest.map((write) => [write.name, write.domain, write.maxAgeSeconds])).toEqual([
      [first?.name, 'rubicon.test', DOMAIN_PROBE_MAX_AGE_SECONDS],
      [first?.name, 'rubicon.test', 0],
    ]);
  });

  it('leaves Secure off on an http page', () => {
    const { domain, jar } = setup({ secure: false });
    domain.domain();
    expect(jar.writes.every((write) => !write.secure)).toBe(true);
  });

  it('applies the browser public suffix list, so co.uk and github.io are never the domain', () => {
    expect(setup({ host: 'www.shop.example.co.uk', store: { publicSuffixes: ['co.uk'] } }).domain.domain()).toBe(
      'example.co.uk',
    );
    expect(setup({ host: 'myapp.github.io', store: { publicSuffixes: ['github.io'] } }).domain.domain()).toBe(
      'myapp.github.io',
    );
  });

  it('decides once per page', () => {
    const { domain, jar } = setup();
    domain.domain();
    const writes = jar.writes.length;

    expect(domain.domain()).toBe('rubicon.test');
    expect(domain.domain()).toBe('rubicon.test');
    expect(jar.writes.length).toBe(writes);
  });

  it.each(['localhost', '127.0.0.1', '[::1]', '::1'])('gives host-only cookies on %s without a probe', (host) => {
    const { domain, jar } = setup({ host });
    expect(domain.domain()).toBeUndefined();
    expect(jar.writes).toEqual([]);
  });

  it('gives host-only cookies with crossSubdomain false, without a probe', () => {
    const { domain, jar } = setup({ crossSubdomain: false });
    expect(domain.domain()).toBeUndefined();
    expect(jar.writes).toEqual([]);
  });

  it('gives host-only cookies when the browser keeps no probe, without a line', () => {
    const { domain, sink } = setup({
      prepare: (jar) => {
        jar.blockWrites = true;
      },
    });
    expect(domain.domain()).toBeUndefined();
    expect(sink.messages).toEqual([]);
  });

  it('gives host-only cookies when cookies cannot be used, and never throws', () => {
    const { domain, sink } = setup({
      prepare: (jar) => {
        jar.failAccess = true;
      },
    });
    expect(domain.domain()).toBeUndefined();
    expect(sink.messages).toEqual([]);
  });

  it('gives host-only cookies for a host name with an empty label', () => {
    const { domain, jar } = setup({ host: 'example.com.' });
    expect(domain.domain()).toBeUndefined();
    expect(jar.writes).toEqual([]);
  });
});

describe('identity.cookieDomain (Web Identity 2, Web Logging 3)', () => {
  it('is used when it is a suffix of the host and the browser keeps it, without discovery', () => {
    const { domain, jar, sink } = setup({ host: 'www.shop.rubicon.test', cookieDomain: 'shop.rubicon.test' });

    expect(domain.domain()).toBe('shop.rubicon.test');
    expect(probed(jar)).toEqual(['shop.rubicon.test']);
    expect(jar.jar.store.cookies()).toEqual([]);
    expect(sink.messages).toEqual([]);
  });

  it('may be the host itself, and is read without a leading dot and in lower case', () => {
    expect(setup({ cookieDomain: 'a.rubicon.test' }).domain.domain()).toBe('a.rubicon.test');
    expect(setup({ cookieDomain: '.Rubicon.TEST' }).domain.domain()).toBe('rubicon.test');
  });

  it('wins over crossSubdomain false (plan section 15, step 7.2)', () => {
    expect(setup({ crossSubdomain: false, cookieDomain: 'rubicon.test' }).domain.domain()).toBe('rubicon.test');
  });

  it.each(['example.com', 'ubicon.test', 'b.rubicon.test', ''])(
    'is not used when %j is not a suffix of the host: host-only, INVALID_COOKIE_DOMAIN, nothing written',
    (cookieDomain) => {
      const { domain, jar, sink, counted } = setup({ cookieDomain });

      expect(domain.domain()).toBeUndefined();
      expect(jar.writes).toEqual([]);
      expect(sink.messages).toEqual([
        'INVALID_COOKIE_DOMAIN: identity.cookieDomain is not a suffix of this host; cookies are host-only',
      ]);
      expect(counted).toEqual(['INVALID_COOKIE_DOMAIN']);
    },
  );

  it('is not used when the browser refuses it: host-only, INVALID_COOKIE_DOMAIN, no discovery', () => {
    const { domain, jar, sink } = setup({ cookieDomain: 'test' });

    expect(domain.domain()).toBeUndefined();
    expect(probed(jar)).toEqual(['test', 'host-only']);
    expect(jar.jar.store.cookies()).toEqual([]);
    expect(sink.messages).toEqual([
      'INVALID_COOKIE_DOMAIN: identity.cookieDomain was refused by the browser; cookies are host-only',
    ]);
  });

  it('gives host-only cookies without a line when the browser keeps no cookie at all', () => {
    const { domain, sink } = setup({
      cookieDomain: 'rubicon.test',
      prepare: (jar) => {
        jar.blockWrites = true;
      },
    });
    expect(domain.domain()).toBeUndefined();
    expect(sink.messages).toEqual([]);
  });

  it('is logged once per page', () => {
    const { domain, sink, counted } = setup({ cookieDomain: 'example.com' });
    domain.domain();
    domain.domain();
    expect(sink.messages).toHaveLength(1);
    expect(counted).toEqual(['INVALID_COOKIE_DOMAIN']);
  });

  describe('as a developer error (Web Public API 4, Web Logging 1)', () => {
    it('with debug true the default sink writes it in the error form, and nothing throws', () => {
      const { domain, sink } = setup({ cookieDomain: 'example.com', debug: true, level: 'warn' });
      expect(() => domain.domain()).not.toThrow();
      expect(sink.lines).toEqual([
        {
          level: 'error',
          message: 'INVALID_COOKIE_DOMAIN: identity.cookieDomain is not a suffix of this host; cookies are host-only',
          developerErrorForm: true,
        },
      ]);
    });

    it('with debug false it is a WARN line', () => {
      const { domain, sink } = setup({ cookieDomain: 'example.com', debug: false, level: 'warn' });
      domain.domain();
      expect(sink.lines.map((line) => [line.level, line.developerErrorForm])).toEqual([['warn', false]]);
    });

    it('logging.level "off" silences it, with or without debug', () => {
      for (const debug of [true, false]) {
        const { domain, sink, counted } = setup({ cookieDomain: 'example.com', debug, level: 'off' });
        expect(domain.domain()).toBeUndefined();
        expect(sink.lines).toEqual([]);
        expect(counted).toEqual(['INVALID_COOKIE_DOMAIN']);
      }
    });
  });
});

describe('one scope per cookie name (plan section 15, step 7.2, answer 2)', () => {
  const NAME = 'rubicon_0123456789abcdef';
  const OTHER = 'rubicon_0123456789abcdef_s';

  function site(domain: string | undefined): { cookies: SiteCookies; jar: RecordingJar; domainAsked: () => number } {
    const memory = new MemoryCookieJar(new MemoryCookieStore(new TestClock()), { host: 'a.rubicon.test' });
    const jar = new RecordingJar(memory);
    let asked = 0;
    const cookies = new SiteCookies({
      cookies: jar,
      host: 'a.rubicon.test',
      domain: () => {
        asked += 1;
        return domain;
      },
      names: [NAME, OTHER],
    });
    return { cookies, jar, domainAsked: () => asked };
  }

  const write = (fields: Partial<CookieWrite>): CookieWrite => ({
    name: NAME,
    value: 'new',
    path: '/',
    maxAgeSeconds: 60,
    sameSite: 'Lax',
    secure: true,
    ...fields,
  });

  function scopes(jar: RecordingJar, name = NAME): [string, boolean, string][] {
    return jar.jar.store
      .cookies()
      .filter((cookie) => cookie.name === name)
      .map((cookie) => [cookie.domain, cookie.hostOnly, cookie.value]);
  }

  it('passes a write through with one read when the name is listed once', () => {
    const { cookies, jar, domainAsked } = site('rubicon.test');
    cookies.write(write({ domain: 'rubicon.test' }));
    expect(jar.writes).toHaveLength(1);
    expect(jar.reads).toBe(1);
    expect(domainAsked()).toBe(0);
    expect(cookies.readAll()).toBe(`${NAME}=new`);
  });

  it('after writing the name for the domain, deletes it in the other scopes, so reads see the write', () => {
    const { cookies, jar } = site('rubicon.test');
    // Host-only from an earlier configuration, listed once before the write.
    jar.jar.write(write({ value: 'old' }));

    cookies.write(write({ domain: 'rubicon.test' }));

    expect(scopes(jar)).toEqual([['rubicon.test', false, 'new']]);
    expect(cookies.readAll()).toBe(`${NAME}=new`);
    // The write, then host-only and each Domain from the host name up, the written scope left out.
    expect(jar.writes.map((cookie) => [cookie.domain ?? 'host-only', cookie.maxAgeSeconds])).toEqual([
      ['rubicon.test', 60],
      ['host-only', 0],
      ['a.rubicon.test', 0],
      ['test', 0],
    ]);
  });

  it('replaces both values when the name was already listed twice', () => {
    const { cookies, jar } = site('rubicon.test');
    jar.jar.write(write({ value: 'old' }));
    jar.jar.write(write({ value: 'stale', domain: 'rubicon.test' }));
    expect(jar.jar.readAll()).toBe(`${NAME}=old; ${NAME}=stale`);

    cookies.write(write({ domain: 'rubicon.test' }));

    expect(cookies.readAll()).toBe(`${NAME}=new`);
  });

  it('after writing the name host-only, deletes the domain cookie', () => {
    const { cookies, jar } = site(undefined);
    jar.jar.write(write({ value: 'old', domain: 'rubicon.test' }));

    cookies.write(write({}));

    expect(scopes(jar)).toEqual([['a.rubicon.test', true, 'new']]);
  });

  it('a delete that leaves the name listed deletes it in every scope', () => {
    const { cookies, jar } = site('rubicon.test');
    jar.jar.write(write({ value: 'old' }));

    cookies.write(write({ value: '', domain: 'rubicon.test', maxAgeSeconds: 0 }));

    expect(scopes(jar)).toEqual([]);
  });

  it('a delete of a name listed nowhere else writes only the delete', () => {
    const { cookies, jar } = site('rubicon.test');
    cookies.write(write({ value: '', domain: 'rubicon.test', maxAgeSeconds: 0 }));
    expect(jar.writes).toHaveLength(1);
  });

  it('at first use leaves each name in the current scope only, asking the domain only then', () => {
    const { cookies, jar, domainAsked } = site('rubicon.test');
    jar.jar.write(write({ value: 'old' }));
    jar.jar.write(write({ value: 'current', domain: 'rubicon.test' }));
    jar.jar.write(write({ name: OTHER, value: 'only' }));

    cookies.cleanUp(true);

    expect(scopes(jar)).toEqual([['rubicon.test', false, 'current']]);
    expect(scopes(jar, OTHER)).toEqual([['a.rubicon.test', true, 'only']]);
    expect(domainAsked()).toBe(1);
  });

  it('at first use asks nothing and writes nothing when no name is listed twice', () => {
    const { cookies, jar, domainAsked } = site('rubicon.test');
    jar.jar.write(write({ value: 'one' }));
    cookies.cleanUp(true);
    expect(jar.writes).toEqual([]);
    expect(domainAsked()).toBe(0);
  });

  it('writes once when the jar cannot be read, and throws as the jar does', () => {
    const { cookies, jar } = site('rubicon.test');
    const original = jar.jar.readAll.bind(jar.jar);
    jar.jar.readAll = () => {
      throw new Error('unreadable');
    };
    cookies.write(write({ domain: 'rubicon.test' }));
    expect(jar.writes).toHaveLength(1);
    jar.jar.readAll = original;
    jar.jar.failAccess = true;
    expect(() => {
      cookies.write(write({}));
    }).toThrow();
    expect(() => {
      cookies.cleanUp(true);
    }).not.toThrow();
  });
});
