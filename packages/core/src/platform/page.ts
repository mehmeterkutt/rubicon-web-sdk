/**
 * The scheme of the page the SDK runs in, from `location.protocol` in the browser, read once by the
 * factory. It decides the level and the message of `CLEARTEXT_HOST` and whether an `http` host is
 * blocked as mixed content (Web Configuration 4, Web HTTP 3, Web Logging 3); `other` covers the
 * schemes that are neither, such as `file:`.
 */
export type PageScheme = 'https' | 'http' | 'other';

/**
 * The parts of a URL the core checks, named and valued as the WHATWG `URL` gives them: `protocol`
 * with its colon and in lower case, `hostname` without the port, `search` and `hash` with their `?`
 * and `#` and empty when there is nothing after them.
 */
export interface ParsedUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly search: string;
  readonly hash: string;
  readonly username: string;
  readonly password: string;
}

/**
 * The WHATWG URL parser, `new URL(text)` in the browser. The core's library is ES2017 without the
 * DOM, so it parses through the platform (Web Configuration 4).
 */
export interface UrlParser {
  /** The parsed absolute URL, or `undefined` where `new URL(text)` throws; never throws itself. */
  parse(text: string): ParsedUrl | undefined;
}
