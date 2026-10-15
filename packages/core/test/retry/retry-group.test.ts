import { describe, expect, it } from 'vitest';
import { retryGroupOf } from '../../src';
import type { FailureKind, HttpResult, RetryGroup } from '../../src';

function http(status: number, retryAfterMs?: number): HttpResult {
  return { kind: 'http-error', status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function network(failure: FailureKind): HttpResult {
  return { kind: 'network-failure', failure };
}

describe('the groups of Retry 1 (retryGroupOf)', () => {
  // The rows of the Android `RetryPolicyTest` "status codes", verbatim; 2xx as a success result.
  const STATUS_ROWS: readonly (readonly [number, string])[] = [
    [200, 'SUCCESS'],
    [201, 'SUCCESS'],
    [204, 'SUCCESS'],
    [100, 'TRANSIENT'],
    [199, 'TRANSIENT'],
    [408, 'TRANSIENT'],
    [500, 'TRANSIENT'],
    [502, 'TRANSIENT'],
    [503, 'TRANSIENT'],
    [504, 'TRANSIENT'],
    [599, 'TRANSIENT'],
    [600, 'TRANSIENT'],
    [-1, 'TRANSIENT'],
    [429, 'THROTTLE'],
    [400, 'BAD_BATCH'],
    [402, 'BAD_BATCH'],
    [405, 'BAD_BATCH'],
    [409, 'BAD_BATCH'],
    [422, 'BAD_BATCH'],
    [451, 'BAD_BATCH'],
    [401, 'CONFIG'],
    [403, 'CONFIG'],
    [404, 'CONFIG'],
    [410, 'CONFIG'],
    [413, 'CONFIG'],
    [501, 'CONFIG'],
    [505, 'CONFIG'],
    [301, 'CONFIG'],
    [302, 'CONFIG'],
    [304, 'CONFIG'],
    [307, 'CONFIG'],
    [308, 'CONFIG'],
  ];

  const WEB_NAMES: Readonly<Record<string, RetryGroup>> = {
    SUCCESS: 'success',
    TRANSIENT: 'transient',
    THROTTLE: 'throttle',
    BAD_BATCH: 'bad-batch',
    CONFIG: 'config',
  };

  it.each(STATUS_ROWS)('%i is %s', (status, group) => {
    const result: HttpResult = status >= 200 && status <= 299 ? { kind: 'success', status } : http(status);

    expect(retryGroupOf(result)).toBe(WEB_NAMES[group]);
  });

  it('a 2xx reported as an HTTP error is still a success', () => {
    expect(retryGroupOf(http(204))).toBe('success');
  });

  it('503 with Retry-After slows down, 429 does either way', () => {
    expect(retryGroupOf(http(503, 30_000))).toBe('throttle');
    expect(retryGroupOf(http(429, 30_000))).toBe('throttle');
    expect(retryGroupOf(http(429))).toBe('throttle');
    expect(retryGroupOf(http(503))).toBe('transient');
  });

  it('Retry-After does not move another status out of its group', () => {
    expect(retryGroupOf(http(500, 30_000))).toBe('transient');
    expect(retryGroupOf(http(401, 30_000))).toBe('config');
    expect(retryGroupOf(http(400, 30_000))).toBe('bad-batch');
  });

  it('an opaque redirect is a configuration problem (Web HTTP 3)', () => {
    expect(retryGroupOf({ kind: 'http-error', status: 0, redirect: true })).toBe('config');
  });

  it('every other 3xx, 300 and an unknown one included, is a configuration problem', () => {
    for (const status of [300, 303, 305, 306, 399]) expect(retryGroupOf(http(status))).toBe('config');
  });

  it('status 0 without a redirect is non-standard, so transient', () => {
    expect(retryGroupOf(http(0))).toBe('transient');
  });

  // The Android "failure kinds" rows the web has (Web HTTP 3: no DNS, TLS or BLOCKED in a browser).
  it.each([
    ['timeout', 'transient'],
    ['connect', 'transient'],
    ['io', 'transient'],
    ['unexpected', 'config'],
  ] as const)('the failure %s is %s', (failure, group) => {
    expect(retryGroupOf(network(failure))).toBe(group);
  });

  it('a refused keepalive request is an unknown outcome (Web Retry 4c)', () => {
    expect(retryGroupOf({ kind: 'keepalive-refused' })).toBe('unknown');
  });
});
