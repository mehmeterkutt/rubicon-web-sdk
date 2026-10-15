import type { PageScheme, ParsedUrl, UrlParser } from 'rubicon-analytics-core';

/**
 * The WHATWG parser of the browser, `new URL(text)`, for the host checks of Web Configuration 4.
 * `URL` is inside the floor (Chrome 19, Edge 12, Firefox 26, Safari 6), so no fallback is needed.
 */
export function createBrowserUrls(): UrlParser {
  return { parse: parseUrl };
}

function parseUrl(text: string): ParsedUrl | undefined {
  try {
    const url = new URL(text);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      search: url.search,
      hash: url.hash,
      username: url.username,
      password: url.password,
    };
  } catch {
    return undefined;
  }
}

/**
 * The page's scheme from `location.protocol`, read once when the platform is made (Web Configuration
 * 4, Web HTTP 3); `other` for any other scheme, such as `file:`, and when it cannot be read.
 */
export function readPageScheme(): PageScheme {
  try {
    return pageSchemeOf(location.protocol);
  } catch {
    return 'other';
  }
}

/** The scheme of a `location.protocol` value, such as `https:`. */
export function pageSchemeOf(protocol: string): PageScheme {
  if (protocol === 'https:') return 'https';
  if (protocol === 'http:') return 'http';
  return 'other';
}

/**
 * The page's host name in lower case from `location.hostname`, read once when the platform is made:
 * the domain probe tries its labels and `identity.cookieDomain` is checked against it (Web Identity
 * 2); `""` when it cannot be read, which gives host-only cookies.
 */
export function readPageHost(): string {
  try {
    return location.hostname.toLowerCase();
  } catch {
    return '';
  }
}
