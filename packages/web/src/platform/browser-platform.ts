import type { Platform } from 'rubicon-analytics-core';
import { createBrowserClock } from './clock';
import { createCryptoRandom } from './random';
import { createBrowserScheduler } from './scheduler';
import { createDocumentCookieJar } from './document-cookies';
import { createLocalStorage } from './local-storage';
import { createFetchTransport } from './fetch-transport';
import { emptyContext, navigatorNetwork, silentStorageSignal, visibleLifecycle } from './stand-ins';
import { createBrowserUrls, readPageHost, readPageScheme } from './urls';

/**
 * The browser's {@link Platform} (Configuration 5), made by `createAnalytics` for its one instance,
 * never at import (Web Public API 7). Reads nothing but `location.protocol` and `location.hostname`:
 * `localStorage` and `document.cookie` are first touched when the instance starts (Web Identity 1).
 * The parts of steps 7.4 and 7.5 are stand-ins until those steps (`stand-ins.ts`).
 */
export function createBrowserPlatform(): Platform {
  const scheduler = createBrowserScheduler();
  return {
    clock: createBrowserClock(),
    random: createCryptoRandom(),
    storage: createLocalStorage(),
    storageEvents: silentStorageSignal(),
    cookies: createDocumentCookieJar(),
    transport: createFetchTransport(scheduler),
    lifecycle: visibleLifecycle(),
    network: navigatorNetwork(),
    context: emptyContext(),
    scheduler,
    pageScheme: readPageScheme(),
    pageHost: readPageHost(),
    urls: createBrowserUrls(),
  };
}
