import { validateConfig } from 'rubicon-analytics-core';
import type { CoreConfig } from 'rubicon-analytics-core';
import { WhatwgUrlParser } from 'rubicon-analytics-testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AnalyticsConfig } from '../../src/analytics-config';

// The web's `AnalyticsConfig` against the core's validator (Web Configuration 6): the type extends
// the neutral core type with the browser-only settings, and the validator knows every one of them.
// The validation rows themselves are tested in `packages/core/test/config`.

/** Every setting of `T` required, down to the leaves; arrays, functions and records stay leaves. */
type EverySetting<T> = {
  readonly [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown
    ? NonNullable<T[K]>
    : NonNullable<T[K]> extends readonly unknown[]
      ? NonNullable<T[K]>
      : K extends 'headers'
        ? NonNullable<T[K]>
        : NonNullable<T[K]> extends object
          ? EverySetting<NonNullable<T[K]>>
          : NonNullable<T[K]>;
};

const hook = (event: Parameters<NonNullable<AnalyticsConfig['beforeSend']>[number]>[0]) => event;
const logger = (): void => undefined;
const observer = (): void => undefined;

// Adding a setting to `AnalyticsConfig` fails to compile here until the test sets it, so the
// assertions below see it reach the snapshot.
const everySetting = {
  apiKey: 'rk_test',
  host: 'https://api.example.com',
  debug: true,
  beforeSend: [hook],
  flush: { at: 20, intervalMs: 10_000, immediateEvents: ['Purchase Completed'] },
  session: { inactivityTimeoutMs: 600_000 },
  autocapture: { enabled: ['sessions', 'network_requests'] },
  context: {
    disabledFields: ['locale'],
    app: { name: 'Shop', version: '4.2.0', namespace: 'com.example.shop' },
    page: { queryParams: ['page'], title: true },
  },
  identity: { crossSubdomain: false, cookieDomain: 'shop.example.com' },
  privacy: { defaultConsent: 'pending', persistConsent: false },
  logging: { level: 'debug', logger, eventObserver: observer, sendDiagnostics: false },
  network: { headers: { 'X-Gateway-Token': 't' } },
} satisfies EverySetting<AnalyticsConfig>;

describe('AnalyticsConfig', () => {
  it('extends the core configuration (Web Configuration 6)', () => {
    expectTypeOf<AnalyticsConfig>().toExtend<CoreConfig>();
  });

  it('needs only apiKey', () => {
    const config: AnalyticsConfig = { apiKey: 'rk_test' };
    expect(config.apiKey).toBe('rk_test');
  });

  it('rejects at compile time what the validator rejects at run time', () => {
    // @ts-expect-error the Android and iOS key does not exist on the web (Web Session 3)
    const background: AnalyticsConfig = { apiKey: 'k', session: { backgroundTimeoutMs: 1 } };
    // @ts-expect-error a member the web lacks (Web Lifecycle 8)
    const lifecycle: AnalyticsConfig = { apiKey: 'k', autocapture: { enabled: ['app_lifecycle'] } };
    // @ts-expect-error a field the web never produces (Web Context 5)
    const field: AnalyticsConfig = { apiKey: 'k', context: { disabledFields: ['os.version'] } };
    // @ts-expect-error a wrong type (Web Configuration 1)
    const wrong: AnalyticsConfig = { apiKey: 'k', flush: { at: '20' } };
    expect([background, lifecycle, field, wrong]).toHaveLength(4);
  });

  it('every setting is known to the validator and reaches the snapshot', () => {
    const config: AnalyticsConfig = everySetting;
    const validation = validateConfig(config, { urls: new WhatwgUrlParser(), pageScheme: 'https' });
    const snapshot = validation.snapshot!;

    expect(validation.issues).toEqual([]);
    expect(snapshot.apiKey).toBe('rk_test');
    expect(snapshot.host).toBe('https://api.example.com');
    expect(snapshot.debug).toBe(true);
    expect(snapshot.beforeSend).toEqual([hook]);
    expect([snapshot.flushAt, snapshot.flushIntervalMs, [...snapshot.immediateEvents]]).toEqual([
      20,
      10_000,
      ['Purchase Completed'],
    ]);
    expect(snapshot.inactivityTimeoutMs).toBe(600_000);
    expect([...snapshot.autocapture]).toEqual(['sessions', 'network_requests']);
    expect([...snapshot.disabledFields]).toEqual(['locale']);
    expect(snapshot.app).toEqual({ name: 'Shop', version: '4.2.0', namespace: 'com.example.shop' });
    expect([snapshot.pageQueryParams, snapshot.pageTitle]).toEqual([['page'], true]);
    expect([snapshot.crossSubdomain, snapshot.cookieDomain]).toEqual([false, 'shop.example.com']);
    expect([snapshot.defaultConsent, snapshot.persistConsent]).toEqual(['pending', false]);
    expect(snapshot.logging).toEqual({ level: 'debug', debug: true, logger, eventObserver: observer });
    expect(snapshot.sendDiagnostics).toBe(false);
    expect({ ...snapshot.headers }).toEqual({ 'X-Gateway-Token': 't' });
  });

  it('a change to every group of the caller object after validation changes nothing', () => {
    const config = mutableConfig();
    const snapshot = validateConfig(config, { urls: new WhatwgUrlParser(), pageScheme: 'https' }).snapshot!;

    config.session.inactivityTimeoutMs = 60_000;
    config.context.app.name = 'Other';
    config.context.page.queryParams.push('token');
    config.identity.cookieDomain = 'example.com';

    expect(snapshot.inactivityTimeoutMs).toBe(600_000);
    expect(snapshot.app.name).toBe('Shop');
    expect(snapshot.pageQueryParams).toEqual(['page']);
    expect(snapshot.cookieDomain).toBe('shop.example.com');
  });
});

// A mutable copy of the browser-only groups of `everySetting`, for the mutation test.
function mutableConfig() {
  return {
    apiKey: 'rk_test',
    session: { inactivityTimeoutMs: 600_000 },
    context: { app: { name: 'Shop' }, page: { queryParams: ['page'] } },
    identity: { cookieDomain: 'shop.example.com' },
  };
}
