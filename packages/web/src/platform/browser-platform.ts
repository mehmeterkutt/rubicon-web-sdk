import type { Platform } from 'rubicon-analytics-core';
import { createBrowserClock } from './clock';
import { createCryptoRandom } from './random';
import { createBrowserScheduler } from './scheduler';
import {
  emptyContext,
  memoryCookieJar,
  memoryStorage,
  offlineNetwork,
  silentStorageSignal,
  standInTransport,
  visibleLifecycle,
} from './stand-ins';
import { createBrowserUrls, readPageScheme } from './urls';

/**
 * The browser's {@link Platform} (Configuration 5), made by `createAnalytics` for its one instance,
 * never at import (Web Public API 7). Reads nothing but `location.protocol`: storage and cookies are
 * first touched when the instance starts (Web Identity 1). The parts of steps 7.2 to 7.5 are stand-ins
 * until those steps (`stand-ins.ts`).
 */
export function createBrowserPlatform(): Platform {
  const scheduler = createBrowserScheduler();
  return {
    clock: createBrowserClock(),
    random: createCryptoRandom(),
    storage: memoryStorage(),
    storageEvents: silentStorageSignal(),
    cookies: memoryCookieJar(),
    transport: standInTransport(scheduler),
    lifecycle: visibleLifecycle(),
    network: offlineNetwork(),
    context: emptyContext(),
    scheduler,
    pageScheme: readPageScheme(),
    urls: createBrowserUrls(),
  };
}
