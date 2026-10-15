import type { ContextProvider, LifecycleSource, NetworkSignal, StorageSignal } from 'rubicon-analytics-core';

// The parts of the browser `Platform` that later steps of phase 7 build, standing in until then as
// Android's and iOS's step 7.1 did (Android log 7.1, iOS log 7.1). Storage and cookies are the
// browser's since step 7.2 and the transport since step 7.3. Each is replaced by the step
// named in it, and this file goes with the last of them. Never published: nothing is released before
// step 8.6.

/**
 * No `storage` event is reported yet, so a pending page learns of another tab's decision when it
 * becomes visible or at its next call (Web Privacy 2, point 3).
 */
export function silentStorageSignal(): StorageSignal {
  // TODO(step 7.4): the `storage` event on `window` (Web Privacy 2).
  return { subscribe: () => () => undefined };
}

/** A page that is always visible and never hides. */
export function visibleLifecycle(): LifecycleSource {
  // TODO(step 7.4): `visibilitychange`, `pagehide` and `pageshow` (Web Session 1, Web Queue 3).
  return { isVisible: () => true, subscribe: () => () => undefined };
}

/**
 * Connected as Web Retry 2 reads it, `navigator.onLine !== false`, a browser without the property
 * counting as connected; read at every call. The `online` and `offline` events are step 7.4's: until
 * then the uploader learns of a returned network at its next trigger. Step 7.3 needs the reading for
 * the classification of Web HTTP 3 (`connect` against `io`, plan section 15, step 7.3).
 */
export function navigatorNetwork(): NetworkSignal {
  // TODO(step 7.4): the `online` and `offline` events (Web Retry 2, Web Queue 3).
  return {
    isOnline: () => {
      try {
        const onLine: unknown = navigator.onLine;
        return onLine !== false;
      } catch {
        return true;
      }
    },
    subscribe: () => () => undefined,
  };
}

/** A context without browser values; `app` and `library` still come from the configuration. */
export function emptyContext(): ContextProvider {
  // TODO(step 7.5): the user agent, screen and page values of Web Context 1 to 4.
  return { staticValues: () => ({}), callTimeValues: () => ({}) };
}
