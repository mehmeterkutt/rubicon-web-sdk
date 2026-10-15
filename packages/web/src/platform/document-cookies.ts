import type { CookieJar, CookieWrite } from 'rubicon-analytics-core';

/** What the jar needs of `document`: its `cookie` accessor. */
export interface CookieDocument {
  cookie: string;
}

/**
 * `document.cookie` behind the core's {@link CookieJar} (Web Identity 1, Web Session 2, Web Privacy
 * 2). `readAll` is the raw text, which the core parses; `write` adds the attributes the core asks
 * for: `Path`, `Max-Age` (zero deletes), `SameSite`, `Domain` when the cookie is not host-only and
 * `Secure` on an `https` page. The browser refuses silently (a public suffix or a foreign `Domain`,
 * blocked cookies, a cookie over its size limit), which is why the core reads back; both members may
 * throw a `SecurityError` in a sandboxed iframe, and the core catches. `document` is read at every
 * access, never at import.
 */
export function createDocumentCookieJar(source: () => CookieDocument = () => document): CookieJar {
  return {
    readAll: () => source().cookie,
    write: (cookie) => {
      source().cookie = serializeCookie(cookie);
    },
  };
}

/**
 * One `document.cookie` assignment. The core gives the value in cookie-safe characters; `Max-Age`
 * is inside the floor (Chrome 55, Edge 15, Firefox 52, Safari 10.1), so no `Expires` is computed.
 */
export function serializeCookie(cookie: CookieWrite): string {
  const maxAge = cookie.maxAgeSeconds > 0 ? Math.floor(cookie.maxAgeSeconds) : 0;
  let text = `${cookie.name}=${cookie.value}; Path=${cookie.path}; Max-Age=${String(maxAge)}; SameSite=${cookie.sameSite}`;
  if (cookie.domain !== undefined) text += `; Domain=${cookie.domain}`;
  if (cookie.secure) text += '; Secure';
  return text;
}
