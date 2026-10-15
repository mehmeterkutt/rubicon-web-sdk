import { describe, expect, expectTypeOf, it } from 'vitest';
import * as rubicon from '../../src';
import type {
  Analytics,
  AnalyticsConfig,
  Autocapture,
  BeforeSend,
  Consent,
  ContextField,
  DropReason,
  Event,
  EventObserver,
  EventSource,
  EventUpdate,
  LogLevel,
  PropertyValue,
  RubiconLogger,
  TrackedFetchOptions,
  TrackEvent,
} from '../../src';

// The public types of step 3.2 as a developer meets them through `rubicon-analytics` (Web Event
// Model 1, 5; Web Public API 5; Web Logging 1): the hooks of the page examples compile against them,
// and the only runtime values the package exports are createNoOpAnalytics (step 3.3),
// createAnalytics (step 7.1) and createTrackedFetch (step 7.7).

describe('the public types of rubicon-analytics', () => {
  it('exports createAnalytics, createNoOpAnalytics and createTrackedFetch as its only runtime values', () => {
    expect(Object.keys(rubicon).sort()).toEqual(['createAnalytics', 'createNoOpAnalytics', 'createTrackedFetch']);
  });

  it('createTrackedFetch gives a function with the signature of fetch (Web Lifecycle 6)', () => {
    const options: TrackedFetchOptions = { hosts: ['api.shop.example.com', '*.shop.example.com'] };
    const trackedFetch = rubicon.createTrackedFetch(rubicon.createNoOpAnalytics(), options);
    // Where a client takes a custom fetch, such as axios's `env.fetch`.
    const env: { fetch: typeof fetch } = { fetch: trackedFetch };

    expectTypeOf(rubicon.createTrackedFetch).returns.toEqualTypeOf<typeof fetch>();
    expectTypeOf<TrackedFetchOptions['fetch']>().toEqualTypeOf<typeof fetch | undefined>();
    // @ts-expect-error the hosts are required
    const withoutHosts: TrackedFetchOptions = { maskPathIds: false };
    expect([env.fetch, withoutHosts]).toHaveLength(2);
  });

  it('a host fake spread from createNoOpAnalytics type-checks as Analytics (Web Public API 3)', () => {
    const tracked: string[] = [];
    const fake: Analytics = {
      ...rubicon.createNoOpAnalytics(),
      track: (name) => {
        tracked.push(name);
      },
    };
    fake.track('Purchase Completed', { amount: 49.9 });
    fake.identify('user');
    expect(tracked).toEqual(['Purchase Completed']);
    expect(fake.isOptedOut).toBe(true);
    expect(fake.deviceId).toBe('');
    expectTypeOf(rubicon.createNoOpAnalytics).returns.toEqualTypeOf<Analytics>();
  });

  it('the hooks of Web Public API 5 and Web Event Model 1 compile against the configuration', () => {
    const tenants = { current: () => 'acme' };
    const config: AnalyticsConfig = {
      apiKey: 'api-key',
      beforeSend: [
        (event) => (event.type === 'track' && event.name.startsWith('debug_') ? null : event),
        (event) => {
          switch (event.type) {
            case 'track':
              return { ...event, properties: { ...event.properties, tenant: tenants.current() } };
            default:
              return event;
          }
        },
      ],
    };
    expect(config.beforeSend).toHaveLength(2);
    expectTypeOf<NonNullable<AnalyticsConfig['beforeSend']>[number]>().toEqualTypeOf<BeforeSend>();
  });

  it('a hook cannot return a Promise or undefined, or assign to an event, at compile time', () => {
    // @ts-expect-error an async hook (Web Public API 5)
    const asyncHook: BeforeSend = async (event) => Promise.resolve(event);
    // @ts-expect-error a forgotten return (Web Public API 5)
    const forgotten: BeforeSend = () => undefined;
    const assigning: BeforeSend = (event) => {
      // @ts-expect-error events are readonly (Web Event Model 1)
      event.timestamp = 0;
      return event;
    };
    expect([asyncHook, forgotten, assigning]).toHaveLength(3);
  });

  it('an exhaustive switch over Event compiles', () => {
    const kind = (event: Event): string => {
      switch (event.type) {
        case 'track':
        case 'screen':
          return event.name;
        case 'identify':
          return Object.keys(event.traits).join(',');
        default: {
          const unknownKind: never = event;
          return String(unknownKind);
        }
      }
    };
    expect(kind).toBeTypeOf('function');
  });

  it('closed sets are unions of their wire names', () => {
    expectTypeOf<EventSource>().toEqualTypeOf<'app' | 'auto'>();
    expectTypeOf<LogLevel>().toEqualTypeOf<'debug' | 'info' | 'warn' | 'error' | 'off'>();
    expectTypeOf<Consent>().toEqualTypeOf<'granted' | 'pending'>();
    expectTypeOf<Autocapture>().toEqualTypeOf<'sessions' | 'page_views' | 'network_requests'>();
    expectTypeOf<'page.viewport_width'>().toExtend<ContextField>();
    expectTypeOf<'os.version'>().not.toExtend<ContextField>();
    expectTypeOf<'page_closed'>().toExtend<DropReason>();
    expectTypeOf<'api_key_changed'>().not.toExtend<DropReason>();
  });

  it('the logger and the observer are plain functions over the event union', () => {
    const seen: Event[] = [];
    const observer: EventObserver = (update: EventUpdate) => {
      if (update.type === 'queued') seen.push(update.event);
    };
    const logger: RubiconLogger = (level, message) => {
      expect(typeof level === 'string' && typeof message === 'string').toBe(true);
    };
    expect([observer, logger]).toHaveLength(2);
    expectTypeOf<TrackEvent['properties']>().toEqualTypeOf<Readonly<Record<string, PropertyValue>>>();
  });
});
