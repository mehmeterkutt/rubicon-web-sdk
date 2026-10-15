import type { Log } from '../log/log';
import type { CookieJar, CookieWrite } from '../platform';
import { cookieValues } from './cookie-text';

/** The name of the domain probe's cookie before its uuid, as the storage declaration lists it (Web Privacy 5). */
export const DOMAIN_PROBE_PREFIX = '__rubicon_dmn_';

/** "A `max-age` of a few seconds" (Web Identity 2): the probe is deleted at once, this only bounds a failed delete. */
export const DOMAIN_PROBE_MAX_AGE_SECONDS = 10;

/** What a {@link CookieDomain} decides from. */
export interface CookieDomainOptions {
  readonly cookies: CookieJar;
  /** The page's host name in lower case (`Platform.pageHost`). */
  readonly host: string;
  /** An `https` page: the probe carries `Secure`, as the cookies it stands for do. */
  readonly secure: boolean;
  /** `identity.crossSubdomain`. */
  readonly crossSubdomain: boolean;
  /** `identity.cookieDomain` as given. */
  readonly cookieDomain?: string;
  /** A new UUID for the probe's name. */
  readonly probeId: () => string;
  readonly log: Log;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The `Domain` of the SDK's cookies (Web Identity 2, as changed on 2026-10-14 by Web Logging 3):
 *
 * - `identity.cookieDomain` given: used when it is the host or a suffix of it and the browser takes
 *   it, else host-only with `INVALID_COOKIE_DOMAIN`; discovery never runs. It wins over
 *   `crossSubdomain: false` (plan section 15, step 7.2).
 * - `crossSubdomain: false`, `localhost` or an IP address: host-only.
 * - Otherwise discovery: a probe cookie `__rubicon_dmn_<uuid>` for each candidate from the last label
 *   of the host upwards, deleted at once; the first the browser keeps is the registrable domain, the
 *   browser applying its Public Suffix List. None kept: host-only.
 *
 * Decided once per page, at the first cookie the SDK writes or deletes, never at import or in the
 * factory: a pending page writes no cookie, so it probes nothing (Web Privacy 1). `undefined` means
 * host-only. Nothing here throws.
 */
export class CookieDomain {
  private decided = false;
  private value: string | undefined;

  constructor(private readonly options: CookieDomainOptions) {}

  /** The `Domain` attribute for the SDK's cookies, `undefined` for host-only. */
  domain(): string | undefined {
    if (!this.decided) {
      this.decided = true;
      this.value = this.decide();
    }
    return this.value;
  }

  private decide(): string | undefined {
    const { cookieDomain, crossSubdomain, host } = this.options;
    if (cookieDomain !== undefined) return this.explicit(cookieDomain);
    if (!crossSubdomain || isLocalHost(host)) return undefined;
    return this.discover();
  }

  // An invalid domain gives the narrowest scope rather than discovery, which would usually widen
  // what a developer meant to narrow (Web Logging 3).
  private explicit(given: string): string | undefined {
    const domain = normalizeDomain(given);
    const { host } = this.options;
    if (domain === '' || !(host === domain || endsWith(host, `.${domain}`))) {
      this.warn('identity.cookieDomain is not a suffix of this host; cookies are host-only');
      return undefined;
    }
    const probe = this.newProbe();
    if (this.accepts(probe, domain)) return domain;
    // A browser that keeps no cookie at all refused nothing about the domain: no line, and the
    // cookie writes report the failure themselves (Web Identity 1).
    if (this.accepts(probe, undefined)) {
      this.warn('identity.cookieDomain was refused by the browser; cookies are host-only');
    }
    return undefined;
  }

  // From the last label upwards, as PostHog's `seekFirstNonPublicSubDomain` (`storage.ts:54-82`)
  // and Snowplow's `findRootDomain` (`helpers/index.ts:245-269`) do.
  private discover(): string | undefined {
    const labels = this.options.host.split('.');
    if (labels.some((label) => label === '')) return undefined;
    const probe = this.newProbe();
    for (let i = labels.length - 1; i >= 0; i -= 1) {
      const candidate = labels.slice(i).join('.');
      if (this.accepts(probe, candidate)) return candidate;
    }
    return undefined;
  }

  private newProbe(): string {
    return `${DOMAIN_PROBE_PREFIX}${this.options.probeId()}`;
  }

  // Writes the probe for `domain` (host-only when absent), reads it back and deletes it at once.
  private accepts(name: string, domain: string | undefined): boolean {
    const { cookies, secure } = this.options;
    const probe = { name, value: '', domain, path: '/', sameSite: 'Lax' as const, secure };
    let kept = false;
    try {
      cookies.write({ ...probe, maxAgeSeconds: DOMAIN_PROBE_MAX_AGE_SECONDS });
      kept = cookieValues(cookies.readAll(), name).length > 0;
    } catch {
      // Cookies that cannot be used keep no probe; the cookie writes report it themselves.
    }
    if (kept) {
      try {
        cookies.write({ ...probe, maxAgeSeconds: 0 });
      } catch {
        // The probe expires on its own within seconds.
      }
    }
    return kept;
  }

  private warn(message: string): void {
    this.options.log.warn('INVALID_COOKIE_DOMAIN', () => message, { developerError: true });
  }
}

// `Domain=.example.com` and `Domain=example.com` mean the same (RFC 6265 section 5.2.3); host names
// compare in lower case.
function normalizeDomain(given: string): string {
  const lower = given.toLowerCase();
  return lower.charAt(0) === '.' ? lower.slice(1) : lower;
}

// `localhost` and IP addresses take no `Domain` (Web Identity 2); `location.hostname` gives an IPv6
// address in brackets.
function isLocalHost(host: string): boolean {
  return host === 'localhost' || IPV4.test(host) || host.indexOf(':') >= 0 || host.charAt(0) === '[';
}

function endsWith(text: string, suffix: string): boolean {
  return text.length >= suffix.length && text.slice(text.length - suffix.length) === suffix;
}

/** What {@link SiteCookies} works over. */
export interface SiteCookiesOptions {
  /** The platform's jar. */
  readonly cookies: CookieJar;
  /** The page's host name in lower case (`Platform.pageHost`). */
  readonly host: string;
  /** The scope the SDK writes now, the {@link CookieDomain} decision. */
  readonly domain: () => string | undefined;
  /** The SDK's own cookie names: identity, session and consent. */
  readonly names: readonly string[];
}

/**
 * The SDK's cookies as the identity, the session and the consent decision write them, with one scope
 * per name (plan section 15, step 7.2, the user's answer 2). After `identity.crossSubdomain` or
 * `identity.cookieDomain` changes, a name can exist both host-only and for a domain; the browser lists
 * the older first (RFC 6265 section 5.4), so a read would keep returning it while every write went to
 * the other. `document.cookie` shows a name's scopes only by how often it lists the name, so the check
 * runs where a second scope becomes visible: right after each write of one of the names, when the
 * name is listed more than once (or at all after a delete), it is deleted in every scope but the one
 * just written (host-only and each `Domain` from the host name upwards); and once at the page's first
 * use ({@link cleanUp}). Reads pass through; both members throw as the jar does.
 */
export class SiteCookies implements CookieJar {
  constructor(private readonly options: SiteCookiesOptions) {}

  readAll(): string {
    return this.options.cookies.readAll();
  }

  write(cookie: CookieWrite): void {
    this.options.cookies.write(cookie);
    // A write leaves the name listed once, a delete not at all; anything more is another scope.
    const expected = cookie.maxAgeSeconds > 0 ? 1 : 0;
    if (this.listed(cookie.name) > expected) this.removeOtherScopes(cookie.name, cookie.domain, cookie.secure);
  }

  /**
   * Leaves each of the SDK's names listed twice in the current scope only, so the page's reads see
   * what its writes write. Called once when the page starts with storage it may write, never while
   * consent is pending or refused (Web Privacy 1, Web Logging 4). The domain decision runs only when
   * a name is listed twice (Web Identity 2).
   */
  cleanUp(secure: boolean): void {
    for (const name of this.options.names) {
      if (this.listed(name) > 1) this.removeOtherScopes(name, this.options.domain(), secure);
    }
  }

  private listed(name: string): number {
    try {
      return cookieValues(this.options.cookies.readAll(), name).length;
    } catch {
      return 0;
    }
  }

  private removeOtherScopes(name: string, keep: string | undefined, secure: boolean): void {
    for (const scope of cookieScopes(this.options.host)) {
      if (scope === keep) continue;
      try {
        this.options.cookies.write({
          name,
          value: '',
          domain: scope,
          path: '/',
          maxAgeSeconds: 0,
          sameSite: 'Lax',
          secure,
        });
      } catch {
        // A jar that cannot be written: the components report it at their own writes.
      }
    }
  }
}

// Every scope a cookie of this page can have: host-only (`undefined`) and each `Domain` from the
// whole host name up to its last label. A `Domain` the browser refuses deletes nothing.
function cookieScopes(host: string): (string | undefined)[] {
  const labels = host.split('.').filter((label) => label !== '');
  const scopes: (string | undefined)[] = [undefined];
  for (let i = 0; i < labels.length; i += 1) scopes.push(labels.slice(i).join('.'));
  return scopes;
}
