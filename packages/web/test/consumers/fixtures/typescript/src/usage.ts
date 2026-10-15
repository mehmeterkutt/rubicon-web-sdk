// A TypeScript consumer of the installed tarball (step 8.2), compiled with TypeScript 5.0 (the
// consumer floor, plan section 15) and the newest TypeScript, with `moduleResolution` `bundler` and
// `node16`, `strict` and `skipLibCheck: false`, so the declaration rollup itself is checked. It uses
// the public API the way the documentation shows it; nothing here runs.
import { createAnalytics, createNoOpAnalytics, createTrackedFetch } from 'rubicon-analytics';
import type {
  Analytics,
  AnalyticsConfig,
  BeforeSend,
  DropReason,
  Event,
  EventUpdate,
  PropertyValue,
  RubiconLogger,
  TrackedFetchOptions,
} from 'rubicon-analytics';

const logger: RubiconLogger = (level, message) => {
  if (level !== 'off') console.info(message);
};

const redact: BeforeSend = (event: Event): Event | null => {
  switch (event.type) {
    case 'track':
      return event.name === 'Secret' ? null : { ...event, properties: { ...event.properties, redacted: true } };
    case 'screen':
    case 'identify':
      return event;
    default:
      // The union may grow in a minor version (Web Event Model 5): an unknown kind passes unchanged.
      return event;
  }
};

function describeDrop(reason: DropReason): string {
  return `dropped: ${reason}`;
}

const config: AnalyticsConfig = {
  apiKey: 'rk_consumer',
  beforeSend: [redact],
  logging: {
    level: 'warn',
    logger,
    eventObserver: (update: EventUpdate) => {
      if (update.type === 'dropped') logger('warn', describeDrop(update.reason));
    },
  },
  privacy: { defaultConsent: 'pending' },
  context: { disabledFields: ['page.referrer'], page: { queryParams: ['ref'], title: true } },
  identity: { crossSubdomain: true },
  session: { inactivityTimeoutMs: 30 * 60 * 1000 },
};

export const analytics: Analytics = createAnalytics(config);
const cart: Record<string, PropertyValue> = { items: [{ sku: 'A-1', quantity: 2 }], total: 49.9 };
analytics.track('Checkout Started', cart);
analytics.screen('Checkout');
analytics.identify('user-1', { plan: 'pro' });
analytics.register('tenant', 'acme');
analytics.unregister('tenant');
analytics.flush();
analytics.optIn();
export const optedOut: boolean = analytics.isOptedOut;
export const deviceId: string = analytics.deviceId;

// A test fake as the documentation recommends: the no-op spread, one verb replaced.
export const tracked: string[] = [];
export const fake: Analytics = { ...createNoOpAnalytics(), track: (name: string) => void tracked.push(name) };

const options: TrackedFetchOptions = { hosts: ['api.example.com', '*.example.com'], maskPathIds: true };
export const trackedFetch: typeof fetch = createTrackedFetch(analytics, options);

// @ts-expect-error -- `track` returns nothing (Web Public API 3).
analytics.track('Chained').track('Again');
// @ts-expect-error -- the device id is read-only.
analytics.deviceId = 'other';
