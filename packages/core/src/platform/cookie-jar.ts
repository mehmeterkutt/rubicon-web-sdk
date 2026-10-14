/** The `SameSite` attribute of a cookie the SDK writes; it writes only `Lax` (Web Identity 1). */
export type CookieSameSite = 'Lax' | 'Strict' | 'None';

/**
 * One cookie to write (Web Identity 1, Web Session 2, Web Privacy 2). The value is written as given:
 * the core encodes it into cookie-safe characters, the jar adds the attributes.
 */
export interface CookieWrite {
  readonly name: string;
  readonly value: string;
  /** The `Domain` attribute, for example `rubicon.test`; absent for a host-only cookie. */
  readonly domain?: string;
  readonly path: string;
  /** The `Max-Age` attribute in seconds; zero or less deletes the cookie. */
  readonly maxAgeSeconds: number;
  readonly sameSite: CookieSameSite;
  readonly secure: boolean;
}

/**
 * The page's cookies, `document.cookie` in the browser. The browser decides silently: a write it
 * refuses (cookies blocked, a `Domain` that is a public suffix or not the page's, `Secure` on an
 * `http` page, a cookie over the size limit) leaves no trace but its absence, which is why the core
 * reads back after writing (Web Identity 1, Web Session 2). Both members may throw a `SecurityError`
 * where cookies cannot be used, such as a sandboxed iframe.
 */
export interface CookieJar {
  /**
   * Every cookie the page can see as one string, `name=value` pairs joined by `"; "`, the form of
   * `document.cookie`; `""` when there is none. Parsing is the core's, so it can skip a parse when
   * the text has not changed (Web Identity 3).
   */
  readAll(): string;

  /** Writes or, with `maxAgeSeconds` zero or less, deletes one cookie. */
  write(cookie: CookieWrite): void;
}
