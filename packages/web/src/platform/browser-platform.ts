import type { Platform } from 'rubicon-analytics-core';
import { createBrowserClock } from './clock';
import { createBrowserContext } from './browser-context';
import { createCryptoRandom } from './random';
import { createBrowserScheduler } from './scheduler';
import { createDocumentCookieJar } from './document-cookies';
import { createLocalStorage } from './local-storage';
import { createFetchTransport } from './fetch-transport';
import { createNavigatorNetwork } from './network-signal';
import { createPageLifecycle } from './page-lifecycle';
import { createStorageEvents } from './storage-events';
import { createBrowserUrls, readPageHost, readPageScheme } from './urls';

/**
 * The browser's {@link Platform} (Configuration 5), made by `createAnalytics` for its one instance,
 * never at import (Web Public API 7). Reads nothing but `location.protocol` and `location.hostname`:
 * `localStorage` and `document.cookie` are first touched when the instance starts (Web Identity 1),
 * and no listener is added before it subscribes; the context provider reads nothing before the
 * first event (Web Context 4).
 */
export function createBrowserPlatform(): Platform {
  const scheduler = createBrowserScheduler();
  return {
    clock: createBrowserClock(),
    random: createCryptoRandom(),
    storage: createLocalStorage(),
    storageEvents: createStorageEvents(),
    cookies: createDocumentCookieJar(),
    transport: createFetchTransport(scheduler),
    lifecycle: createPageLifecycle(),
    network: createNavigatorNetwork(),
    context: createBrowserContext(),
    scheduler,
    pageScheme: readPageScheme(),
    pageHost: readPageHost(),
    urls: createBrowserUrls(),
  };
}
