import type { PageScheme, ParsedUrl, UrlParser } from '../platform/page';

/** Why a `host` is not a valid base URL; the message names the reason, never the text. */
export type HostProblem = 'empty' | 'white-space' | 'not-http' | 'no-host' | 'query' | 'fragment' | 'user-info';

/** A valid `host`, normalized, or the reason it is not one. */
export type HostCheck =
  | { readonly valid: true; readonly host: string; readonly url: ParsedUrl }
  | { readonly valid: false; readonly problem: HostProblem };

const HTTP_SCHEME = /^https?:\/\//i;

/**
 * The `host` rules of Configuration 3 and Web Configuration 4: a base URL with an `http` or `https`
 * scheme, a host name and an optional path, such as `https://intranet.example.com/analytics`.
 *
 * Checked first on the raw text, since the WHATWG parser strips and rewrites what it accepts, then on
 * the parsed URL. The text keeps the Android rules (Android log 3.1) exact where the parser is more
 * lenient: a `?` or `#` with nothing after it, an empty authority (`https:///path`) and an `@` in
 * the authority are a query, a fragment, no host and user info, as `java.net.URI` reads them, even
 * though `new URL` reports them as empty (plan section 15, step 3.1).
 *
 * Trailing slashes are removed so the endpoints can be appended (`{host}/v1/batch`); otherwise the
 * text is kept as given, `HTTPS://` included.
 */
export function checkHost(text: string, urls: UrlParser): HostCheck {
  if (text === '') return { valid: false, problem: 'empty' };
  if (text.trim() !== text || hasControlCharacter(text)) return { valid: false, problem: 'white-space' };
  if (!HTTP_SCHEME.test(text)) return { valid: false, problem: 'not-http' };
  if (text.indexOf('?') >= 0) return { valid: false, problem: 'query' };
  if (text.indexOf('#') >= 0) return { valid: false, problem: 'fragment' };
  const afterScheme = text.slice(text.indexOf('//') + 2);
  const slash = afterScheme.indexOf('/');
  const authority = slash < 0 ? afterScheme : afterScheme.slice(0, slash);
  if (authority === '') return { valid: false, problem: 'no-host' };
  if (authority.indexOf('@') >= 0) return { valid: false, problem: 'user-info' };
  const url = urls.parse(text);
  if (url === undefined || url.hostname === '') return { valid: false, problem: 'no-host' };
  if (url.search !== '') return { valid: false, problem: 'query' };
  if (url.hash !== '') return { valid: false, problem: 'fragment' };
  if (url.username !== '' || url.password !== '') return { valid: false, problem: 'user-info' };
  let end = text.length;
  while (text.charAt(end - 1) === '/') end--;
  return { valid: true, host: text.slice(0, end), url };
}

// C0 controls and DEL, which the URL parser strips silently (tab and line breaks anywhere).
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** The log text of a {@link HostProblem}. */
export function hostProblemText(problem: HostProblem): string {
  switch (problem) {
    case 'empty':
      return 'is empty';
    case 'white-space':
      return 'has surrounding white space or a control character';
    case 'not-http':
      return 'does not start with http:// or https://';
    case 'no-host':
      return 'has no valid host name';
    case 'query':
      return 'has a query';
    case 'fragment':
      return 'has a fragment';
    case 'user-info':
      return 'has user info';
  }
}

/**
 * How a valid host is reached from this page (Web Configuration 4, Web HTTP 3):
 *
 * - `encrypted`: an `https` host;
 * - `cleartext`: an `http` host the browser lets this page reach; events travel unencrypted, a WARN;
 * - `blocked`: an `http` host other than `localhost` or `127.0.0.1` from an `https` page, which the
 *   browser blocks as mixed content: nothing is sent, an ERROR.
 */
export type HostSecurity = 'encrypted' | 'cleartext' | 'blocked';

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/** The {@link HostSecurity} of a valid host's parsed URL on a page of `pageScheme`. */
export function hostSecurity(url: ParsedUrl, pageScheme: PageScheme): HostSecurity {
  if (url.protocol !== 'http:') return 'encrypted';
  return pageScheme === 'https' && LOOPBACK_HOSTS.indexOf(url.hostname) < 0 ? 'blocked' : 'cleartext';
}
