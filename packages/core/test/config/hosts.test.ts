import { WhatwgUrlParser } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { checkHost, hostSecurity } from '../../src';
import type { HostProblem, PageScheme } from '../../src';

// The host table of Web Configuration 4: the Android rows of ConfigValidatorTest (host url), the
// readings of the WHATWG parser measured on the page, and the cases where `new URL` is more lenient
// than `java.net.URI` (plan section 15, step 3.1). Node's `URL` is the WHATWG parser of the browsers.

const urls = new WhatwgUrlParser();

describe('checkHost', () => {
  it.each([
    // The Android table, word for word.
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://intranet.example.com/analytics', 'https://intranet.example.com/analytics'],
    ['https://intranet.example.com/analytics/', 'https://intranet.example.com/analytics'],
    ['https://api.example.com:8443', 'https://api.example.com:8443'],
    ['HTTPS://api.example.com', 'HTTPS://api.example.com'],
    ['https://10.0.0.5', 'https://10.0.0.5'],
    // Web additions: every trailing slash goes, the text is otherwise kept as given.
    ['https://api.example.com///', 'https://api.example.com'],
    ['HTTP://API.Example.com/Path', 'HTTP://API.Example.com/Path'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['https://[::1]:8443/a', 'https://[::1]:8443/a'],
    ['https://api.example.com/a@b', 'https://api.example.com/a@b'],
  ])('accepts %j as %j', (text, host) => {
    const check = checkHost(text, urls);
    expect(check.valid && check.host).toBe(host);
  });

  it.each<[string, HostProblem]>([
    // The Android table, word for word.
    ['', 'empty'],
    ['api.example.com', 'not-http'],
    ['ftp://api.example.com', 'not-http'],
    ['https://', 'no-host'],
    ['https:///path', 'no-host'],
    ['https://api.example.com?key=1', 'query'],
    ['https://api.example.com/#part', 'fragment'],
    ['https://user:pass@api.example.com', 'user-info'],
    [' https://api.example.com', 'white-space'],
    ['https://api.example.com ', 'white-space'],
    ['not a url', 'not-http'],
    ['https://exa mple.com', 'no-host'],
    // What `new URL` strips or rewrites silently (Web Configuration 4).
    ['https://api.example.com\n', 'white-space'],
    ['https://api.\texample.com', 'white-space'],
    ['https://api.example.com\u007f', 'white-space'],
    [' https://api.example.com', 'white-space'],
    ['http:api.example.com', 'not-http'],
    ['https:/api.example.com', 'not-http'],
    // Accepted by `new URL` with an empty part, rejected by `java.net.URI` (Android log 3.1).
    ['https://api.example.com?', 'query'],
    ['https://api.example.com/v?#', 'query'],
    ['https://api.example.com#', 'fragment'],
    ['https://@api.example.com', 'user-info'],
    ['https://:@api.example.com', 'user-info'],
    ['https:///', 'no-host'],
    ['https://exa%20mple.com', 'no-host'],
  ])('rejects %j: %s', (text, problem) => {
    expect(checkHost(text, urls)).toEqual({ valid: false, problem });
  });

  it('checks the parsed URL as well as the text (Web Configuration 4)', () => {
    const parts = { protocol: 'https:', hostname: 'h', search: '', hash: '', username: '', password: '' };
    const parser = (extra: object) => ({ parse: () => ({ ...parts, ...extra }) });
    const text = 'https://api.example.com';

    expect(checkHost(text, parser({ hostname: '' }))).toEqual({ valid: false, problem: 'no-host' });
    expect(checkHost(text, parser({ search: '?q' }))).toEqual({ valid: false, problem: 'query' });
    expect(checkHost(text, parser({ hash: '#f' }))).toEqual({ valid: false, problem: 'fragment' });
    expect(checkHost(text, parser({ username: 'u' }))).toEqual({ valid: false, problem: 'user-info' });
    expect(checkHost(text, parser({ password: 'p' }))).toEqual({ valid: false, problem: 'user-info' });
    expect(checkHost(text, { parse: () => undefined })).toEqual({ valid: false, problem: 'no-host' });
  });

  it('never changes the case or the encoding of an accepted text', () => {
    const check = checkHost('https://Ünicode.example.com/Analytics', urls);
    expect(check.valid && check.host).toBe('https://Ünicode.example.com/Analytics');
  });
});

describe('hostSecurity', () => {
  const of = (text: string, page: PageScheme) => {
    const check = checkHost(text, urls);
    if (!check.valid) throw new Error(`invalid ${text}`);
    return hostSecurity(check.url, page);
  };

  it('an https host is encrypted on every page', () => {
    for (const page of ['https', 'http', 'other'] as const)
      expect(of('https://api.example.com', page)).toBe('encrypted');
  });

  it('an http host is blocked as mixed content from an https page, unless it is localhost or 127.0.0.1', () => {
    expect(of('http://api.example.com', 'https')).toBe('blocked');
    expect(of('http://10.0.2.2:8080', 'https')).toBe('blocked');
    expect(of('HTTP://LOCALHOST:8080', 'https')).toBe('cleartext');
    expect(of('http://127.0.0.1:8080/x', 'https')).toBe('cleartext');
  });

  it('an http host is cleartext from an http page and from a page of another scheme', () => {
    expect(of('http://api.example.com', 'http')).toBe('cleartext');
    expect(of('http://api.example.com', 'other')).toBe('cleartext');
  });
});
