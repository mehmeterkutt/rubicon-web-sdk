import type { Log } from 'rubicon-analytics-core';

// The hosts `createTrackedFetch` captures (Privacy 5c, Web Lifecycle 6), the port of the Android
// `HostPatterns` (Android log 7.6): an exact host name, or `*.` followed by at least two labels for
// every subdomain of a domain (`*.shop.com` matches `api.shop.com`, never `shop.com`; `*.com` is
// invalid), ignoring case. No suffix matching: what is written is what is captured.

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The parsed host list of one `createTrackedFetch`. */
export interface HostPatterns {
  /** Whether `host`, a URL's host name, is one of the patterns. */
  matches(host: string): boolean;
}

/**
 * Parses `hosts`. An invalid pattern (a scheme, a path, a port, another wildcard, an empty or
 * non-string element) is ignored with `INVALID_CAPTURE_HOST`, a developer error that is never thrown
 * (Web Public API 4); a `hosts` that is not an array captures nothing, with the same code. The line
 * names the position, never the pattern, as the configuration's lines never name a value (plan
 * section 15, step 3.1). Without a `log` (an `Analytics` that is not the SDK's) nothing is logged.
 */
export function parseHostPatterns(hosts: unknown, log: Log | undefined): HostPatterns {
  const exact: string[] = [];
  // ".shop.com" for "*.shop.com".
  const suffixes: string[] = [];
  if (!Array.isArray(hosts)) {
    invalid(log, () => 'hosts of createTrackedFetch is not an array of host names; nothing is captured');
    return { matches: () => false };
  }
  const list: readonly unknown[] = hosts;
  for (let index = 0; index < list.length; index += 1) {
    const pattern = patternOf(list[index]);
    if (pattern !== undefined && pattern.startsWith('*.') && isDomain(pattern.slice(2), 2)) {
      suffixes.push(pattern.slice(1));
    } else if (pattern !== undefined && isDomain(pattern, 1)) {
      exact.push(pattern);
    } else {
      invalid(
        log,
        () =>
          `hosts[${String(index)}] of createTrackedFetch is invalid: use a host name such as api.shop.com ` +
          'or a wildcard such as *.shop.com; it is ignored',
      );
    }
  }
  return {
    matches(host) {
      const name = host.toLowerCase();
      return exact.indexOf(name) >= 0 || suffixes.some((suffix) => endsWith(name, suffix));
    },
  };
}

// Trimmed and in lower case, as Android reads a pattern; a hole or a value that is not a string is
// invalid.
function patternOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function isDomain(name: string, minLabels: number): boolean {
  const labels = name.split('.');
  return labels.length >= minLabels && labels.every((label) => LABEL.test(label));
}

function endsWith(name: string, suffix: string): boolean {
  return name.length > suffix.length && name.slice(name.length - suffix.length) === suffix;
}

function invalid(log: Log | undefined, message: () => string): void {
  log?.warn('INVALID_CAPTURE_HOST', message, { developerError: true });
}
