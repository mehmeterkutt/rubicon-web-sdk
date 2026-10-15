import type { EventContext, IdentifyEvent, ScreenEvent, TrackEvent } from '../../src';
import { SDK_VERSION } from '../../src';

// The events of the golden files, as the web SDK would hold them (the port of the Android
// `SampleEvents`): the file's ids, times, properties and Android-side context values as test data,
// `app.*` as a test configuration would give them (Web Context 5), the web's own `browser` and
// `page` groups, and the web library.

export const DEVICE_ID = '0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f';

const library = { name: 'rubicon-web', version: SDK_VERSION };

/** Every group filled, the browser's own groups included. */
export const fullContext: EventContext = {
  app: { name: 'Rubicon', version: '1.4.0', namespace: 'com.rubicon.demo' },
  device: { type: 'phone' },
  os: { name: 'Android' },
  browser: { name: 'Chrome', version: '141' },
  screen: { width: 1080, height: 2400, density: 2.625 },
  page: {
    url: 'https://shop.example.com/orders/:id',
    referrer: 'https://www.example.com/',
    viewportWidth: 412,
    viewportHeight: 915,
    query: { page: '2' },
    title: 'Checkout',
  },
  locale: 'tr-TR',
  timezone: 'Europe/Istanbul',
  session: { id: '0192e49f-0b1c-7d2e-8f3a-4b5c6d7e8f90', startedAt: 1_759_147_082_000 },
  library,
};

/** Everything unknown except the OS: empty groups and missing values are left out. */
export const sparseContext: EventContext = {
  app: {},
  device: {},
  os: { name: 'Android' },
  browser: {},
  screen: {},
  page: {},
  library,
};

export const track: TrackEvent = {
  type: 'track',
  name: 'Purchase Completed',
  source: 'app',
  messageId: '0192e4a1-7c3f-7a2b-8d4e-1f2a3b4c5d6e',
  timestamp: 1_759_147_200_123,
  userId: 'user-42',
  deviceId: DEVICE_ID,
  properties: {
    amount: 9.99,
    currency: 'USD',
    trial_ends_at: '2026-10-13T00:00:00.000Z',
    ab_group: 'B',
    items: [{ sku: 'A1', qty: 2 }],
    coupon: null,
  },
  context: fullContext,
};

export const screen: ScreenEvent = {
  type: 'screen',
  name: 'Checkout',
  source: 'auto',
  messageId: '0192e4a1-6b2e-7f10-9a3b-2c4d6e8f0a1b',
  timestamp: 1_759_147_190_000,
  userId: null,
  deviceId: DEVICE_ID,
  properties: { name_source: 'annotation' },
  context: fullContext,
};

export const identify: IdentifyEvent = {
  type: 'identify',
  source: 'app',
  messageId: '0192e4a1-5a1d-7e0f-8b2c-1d3e5f7a9b0c',
  timestamp: 1_759_147_100_000,
  userId: 'user-42',
  deviceId: DEVICE_ID,
  traits: { plan: 'pro', signup_at: '2026-09-01T12:00:00.000Z' },
  context: sparseContext,
};

/** An automatic track event, as `Session Started` of the golden file. */
export const sessionStarted: TrackEvent = {
  type: 'track',
  name: 'Session Started',
  source: 'auto',
  messageId: '0192e4a3-1000-7000-8000-000000000001',
  timestamp: 1_759_147_200_000,
  userId: null,
  deviceId: DEVICE_ID,
  properties: {},
  context: { ...fullContext, session: { id: '0192e49f-0b1c-7d2e-8f3a-4b5c6d7e8f90', startedAt: 1_759_147_200_000 } },
};
