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
  TrackEvent,
} from '../../src';

// The public types of step 3.2 as a developer meets them through `rubicon-analytics` (Web Event
// Model 1, 5; Web Public API 5; Web Logging 1): the hooks of the page examples compile against them,
// and the only runtime value the package exports is createNoOpAnalytics (step 3.3).

describe('the public types of rubicon-analytics', () => {
  it('exports createNoOpAnalytics as its only runtime value; everything else is a type', () => {
    expect(Object.keys(rubicon)).toEqual(['createNoOpAnalytics']);
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
