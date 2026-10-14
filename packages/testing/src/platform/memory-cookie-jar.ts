import type { Clock, CookieJar, CookieSameSite, CookieWrite } from 'rubicon-analytics-core';
import { securityError } from './dom-exception';

/** A cookie as the browser keeps it. */
export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  /** The page's host for a host-only cookie, else the `Domain` attribute without a leading dot. */
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  /** Epoch milliseconds on the store's clock. */
  readonly expiresAt: number;
  readonly sameSite: CookieSameSite;
  readonly secure: boolean;
  readonly createdAt: number;
}

/** Options of a {@link MemoryCookieStore}. */
export interface MemoryCookieStoreOptions {
  /**
   * Public suffixes with more than one label, such as `co.uk` or `github.io`. A single-label domain
   * (`test`, `com`, `localhost`) is always one. A `Domain` attribute naming a public suffix is
   * refused, which is how the domain probe finds the registrable domain (Web Identity 2).
   */
  readonly publicSuffixes?: readonly string[];
}

/**
 * The browser's cookie store, shared by every page of every host of the browser profile, with
 * expiry on the given clock. Pages see it through a {@link MemoryCookieJar} each.
 */
export class MemoryCookieStore {
  /** The size limit browsers apply to a cookie's name and value together (RFC 6265 section 6.1). */
  static readonly MAX_NAME_AND_VALUE = 4096;

  private stored: StoredCookie[] = [];
  private readonly publicSuffixes: ReadonlySet<string>;

  constructor(
    readonly clock: Clock,
    options: MemoryCookieStoreOptions = {},
  ) {
    this.publicSuffixes = new Set((options.publicSuffixes ?? []).map((suffix) => suffix.toLowerCase()));
  }

  /** Every cookie that has not expired, for assertions. */
  cookies(): readonly StoredCookie[] {
    const now = this.clock.now();
    this.stored = this.stored.filter((cookie) => cookie.expiresAt > now);
    return this.stored.slice();
  }

  isPublicSuffix(domain: string): boolean {
    return !domain.includes('.') || this.publicSuffixes.has(domain);
  }

  /** Stores, replaces or (an expiry not after now) deletes a cookie, keeping a replaced one's age. */
  put(cookie: Omit<StoredCookie, 'createdAt'>): void {
    const live: StoredCookie[] = this.cookies().slice();
    const same = (other: StoredCookie): boolean =>
      other.name === cookie.name &&
      other.domain === cookie.domain &&
      other.hostOnly === cookie.hostOnly &&
      other.path === cookie.path;
    const index = live.findIndex(same);
    const previous = live[index];
    const replacement: StoredCookie[] =
      cookie.expiresAt > this.clock.now() ? [{ ...cookie, createdAt: previous?.createdAt ?? this.clock.now() }] : [];
    // A replaced cookie keeps its place, as it keeps its creation time (RFC 6265 section 5.3 step 11).
    if (previous === undefined) live.push(...replacement);
    else live.splice(index, 1, ...replacement);
    this.stored = live;
  }
}

/** The page a {@link MemoryCookieJar} belongs to. */
export interface CookiePage {
  /** The page's host name, lower case. */
  readonly host?: string;
  /** An `https` page: `Secure` cookies are written and read only there. */
  readonly secure?: boolean;
  /** The page's path, for the cookies' `Path` match. */
  readonly path?: string;
}

const IP_ADDRESS = /^(\d{1,3}\.){3}\d{1,3}$|:/;

/** RFC 6265 section 5.1.3: the host is the domain, or a subdomain of it unless it is an address. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !IP_ADDRESS.test(host));
}

/** RFC 6265 section 5.1.4. */
function pathMatches(pagePath: string, cookiePath: string): boolean {
  if (pagePath === cookiePath) return true;
  if (!pagePath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pagePath.charAt(cookiePath.length) === '/';
}

/**
 * `CookieJar` in memory, one page's `document.cookie` over a {@link MemoryCookieStore}, deciding as
 * a browser does and as silently: a `Domain` that is a public suffix or not the page's, `Secure` on
 * an `http` page, or a name and value over 4096 characters leave no cookie and no error (Web
 * Identity 1 and 2). Injected failures:
 *
 * - `failAccess`: both members throw a `SecurityError`, as in a sandboxed iframe;
 * - `blockWrites`: writes are ignored, as with cookies blocked in the browser's settings.
 *
 * {@link otherPage} opens a page on another host or scheme over the same store, for the subdomain
 * tests (D15: `a.rubicon.test` and `b.rubicon.test`).
 */
export class MemoryCookieJar implements CookieJar {
  failAccess = false;
  blockWrites = false;

  readonly host: string;
  readonly secure: boolean;
  readonly path: string;

  constructor(
    readonly store: MemoryCookieStore,
    page: CookiePage = {},
  ) {
    this.host = (page.host ?? 'a.rubicon.test').toLowerCase();
    this.secure = page.secure ?? true;
    this.path = page.path ?? '/';
  }

  otherPage(page: CookiePage = {}): MemoryCookieJar {
    return new MemoryCookieJar(this.store, { host: this.host, secure: this.secure, path: this.path, ...page });
  }

  readAll(): string {
    if (this.failAccess) throw securityError();
    return this.store
      .cookies()
      .filter((cookie) => (cookie.hostOnly ? cookie.domain === this.host : domainMatches(this.host, cookie.domain)))
      .filter((cookie) => pathMatches(this.path, cookie.path) && (this.secure || !cookie.secure))
      .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  write(cookie: CookieWrite): void {
    if (this.failAccess) throw securityError();
    if (this.blockWrites) return;
    // `document.cookie = "a=b; c"` stores `b`: the value ends at the first semicolon.
    const value = cookie.value.split(';')[0] ?? '';
    if (cookie.name.length + value.length > MemoryCookieStore.MAX_NAME_AND_VALUE) return;
    if (cookie.secure && !this.secure) return;
    let domain = this.host;
    let hostOnly = true;
    if (cookie.domain !== undefined) {
      const given = cookie.domain.toLowerCase().replace(/^\./, '');
      // RFC 6265 section 5.3 steps 5 and 6.
      if (this.store.isPublicSuffix(given)) {
        if (given !== this.host) return;
      } else {
        if (!domainMatches(this.host, given)) return;
        domain = given;
        hostOnly = false;
      }
    }
    this.store.put({
      name: cookie.name,
      value,
      domain,
      hostOnly,
      path: cookie.path,
      expiresAt: cookie.maxAgeSeconds > 0 ? this.store.clock.now() + cookie.maxAgeSeconds * 1000 : -Infinity,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
    });
  }
}
