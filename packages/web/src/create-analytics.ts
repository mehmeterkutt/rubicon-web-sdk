import {
  coreOf,
  createCore,
  createNoOpAnalytics,
  Log,
  SDK_VERSION,
  shutdown,
  storageReadable,
  storageWritable,
  validateConfig,
} from 'rubicon-analytics-core';
import type { Analytics, ConfigEnvironment } from 'rubicon-analytics-core';
import type { AnalyticsConfig } from './analytics-config';
import { createBrowserPlatform } from './platform/browser-platform';
import { createConsoleSink } from './platform/console-sink';

// The factory of the browser SDK (Web Public API 1, 7; Web Configuration 2, 3), the port of the
// Android `AnalyticsFactory.kt`. One instance per page: a module registry for this copy of the SDK
// and the page marker `globalThis[Symbol.for("rubicon.analytics")]` for every copy, both read and
// written only inside `createAnalytics`, never at import. The marker holds `{ version, analytics }`;
// any copy, of any version, reads these two fields, so they never change. It is reached as `window`,
// which is `globalThis` in a page: `globalThis` itself is ES2020 (Chrome 71, Safari 12.1), above the
// floor of Web Public API 6, and the factory touches the marker only once it knows it is in a browser.

const MARKER = 'rubicon.analytics';

/** What the module registry and the page marker hold: the first instance and the version that made it. */
interface Registration {
  readonly version: string;
  readonly analytics: Analytics;
}

// The first instance this copy made, or `undefined`. Never filled with the no-op.
let registered: Registration | undefined;
// Whether this copy logged `SECOND_INSTANCE` at its level; later ones are DEBUG lines (`per_page`,
// Web Logging 2).
let secondInstanceReported = false;

// The factory's own log validates the configuration only for its logging settings, so it needs no
// URL parser and no page scheme: the host is not looked at.
const LOG_ONLY: ConfigEnvironment = { urls: { parse: () => undefined }, pageScheme: 'other' };

/**
 * Creates the SDK's instance for this page. Call it once, early, and hold the result: pass it to the
 * code that tracks, or put it where your application keeps shared services. There is no global
 * instance.
 *
 * - One instance per page: a second call, from this or any other copy of the SDK on the page,
 *   returns the first instance, whose configuration stays in force, and logs the error
 *   `SECOND_INSTANCE`.
 * - With a missing or blank `apiKey` or an invalid `host` it returns an instance that does nothing
 *   (see {@link createNoOpAnalytics}) and logs an error; other mistakes in the configuration are
 *   corrected with a warning.
 * - Outside a browser (server-side rendering, a web worker, Node) it returns an instance that does
 *   nothing, with one `info` line.
 * - It never throws, `debug` included: `debug: true` only writes a developer mistake to the console
 *   as `console.error(new Error(...))`, with a stack. Set it from your build, it is `false` unless
 *   given: `debug: import.meta.env.DEV` with Vite, `debug: process.env.NODE_ENV !== "production"`
 *   with webpack or Next.js.
 * - It reads no storage and no cookie; the instance starts at its first use.
 *
 * @example
 * ```ts
 * import { createAnalytics } from 'rubicon-analytics';
 *
 * export const analytics = createAnalytics({ apiKey: 'your-publishable-key', debug: import.meta.env.DEV });
 *
 * analytics.track('Purchase Completed', { amount: 49.9 });
 * ```
 */
export function createAnalytics(config: AnalyticsConfig): Analytics {
  try {
    if (!isBrowser()) {
      factoryLog(config).info(() => 'Not running in a browser; analytics does nothing here');
      return createNoOpAnalytics();
    }
    const first = registered ?? readMarker();
    if (first !== undefined) return secondInstance(config, first);
    const platform = createBrowserPlatform();
    const analytics = createCore(config, platform, {
      sink: createConsoleSink(),
      // The start probe of Web Disk 4: a read in every consent state, a write only for a page that
      // starts with consent granted (plan section 15, step 7.2).
      storageUsable: () => storageReadable(platform.storage),
      storageWritable: (key) => storageWritable(platform.storage, key),
    });
    // The no-op of an unusable configuration is never registered (Web Configuration 3).
    if (coreOf(analytics) !== undefined) register({ version: SDK_VERSION, analytics });
    return analytics;
  } catch (error) {
    reportFailure(config, error);
    return createNoOpAnalytics();
  }
}

/**
 * Stops the instance this copy made and clears the module registry and the page marker, so the next
 * `createAnalytics` makes a new instance. For tests only: reached through `src/testing.ts`, outside
 * the `exports` map (Web Configuration 3).
 */
export function resetForTests(): void {
  const current = registered;
  registered = undefined;
  secondInstanceReported = false;
  try {
    Reflect.deleteProperty(window, Symbol.for(MARKER));
  } catch {
    // A global that refuses the delete keeps the marker; the test that needs it gone fails there.
  }
  if (current !== undefined) shutdown(current.analytics);
}

// A browser, as Web Public API 7 reads it: a window with a document and `localStorage`, and
// `crypto.getRandomValues`. `'localStorage' in window` does not run the getter, which throws in a
// sandboxed iframe: that page is a browser whose storage is unusable, and the start probe gives it
// the memory-only mode (Web Disk 4).
function isBrowser(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof document !== 'undefined' &&
      'localStorage' in window &&
      typeof crypto !== 'undefined' &&
      typeof crypto.getRandomValues === 'function'
    );
  } catch {
    return false;
  }
}

// Another copy's marker is read field by field; anything else under the key is not an instance.
function readMarker(): Registration | undefined {
  try {
    const value: unknown = Reflect.get(window, Symbol.for(MARKER));
    if (typeof value !== 'object' || value === null) return undefined;
    const version: unknown = Reflect.get(value, 'version');
    const analytics: unknown = Reflect.get(value, 'analytics');
    if (typeof version !== 'string' || typeof analytics !== 'object' || analytics === null) return undefined;
    return { version, analytics: analytics as Analytics };
  } catch {
    return undefined;
  }
}

// Not enumerable, so a script listing the global's properties does not see it; configurable, so the
// test helper can delete it. A global that refuses it leaves the module registry as the guard.
function register(registration: Registration): void {
  registered = registration;
  try {
    Reflect.defineProperty(window, Symbol.for(MARKER), {
      value: { version: registration.version, analytics: registration.analytics },
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    // The module registry still guards this copy.
  }
}

// Android `RubiconCore.second`: the second configuration is not validated beyond its logging
// settings, which carry the line to the developer who made the second call.
function secondInstance(config: unknown, first: Registration): Analytics {
  const log = factoryLog(config);
  const message = (): string =>
    `createAnalytics was called again on this page (SDK ${SDK_VERSION}); the first instance, made by SDK ` +
    `${first.version}, is returned and its configuration stays in force`;
  if (secondInstanceReported) {
    log.debug(() => `SECOND_INSTANCE: ${message()}`);
  } else {
    log.error('SECOND_INSTANCE', message, { developerError: true });
    // A level that wrote nothing claims nothing, as the core's repeat limit does.
    secondInstanceReported = log.isEnabled('error');
  }
  return first.analytics;
}

// The factory's lines before an instance exists, through the developer's logger and level, else the
// console sink (Android `factoryLog`).
function factoryLog(config: unknown): Log {
  return new Log({ ...validateConfig(config, LOG_ONLY).logSettings, sink: createConsoleSink() });
}

function reportFailure(config: unknown, error: unknown): void {
  try {
    factoryLog(config).error('WORKER_FAILED', () => 'The SDK could not start; it does nothing on this page', {
      error,
    });
  } catch {
    // The log itself failed: nothing more can be said without risking the page.
  }
}
