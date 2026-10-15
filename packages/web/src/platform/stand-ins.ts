import type {
  ContextProvider,
  HttpCall,
  HttpOutcome,
  HttpRequest,
  HttpTransport,
  LifecycleSource,
  NetworkSignal,
  Scheduler,
  StorageSignal,
} from 'rubicon-analytics-core';

// The parts of the browser `Platform` that later steps of phase 7 build, standing in until then as
// Android's and iOS's step 7.1 did (Android log 7.1, iOS log 7.1). They keep a page working and quiet:
// nothing is sent; storage and cookies are the browser's since step 7.2. Each is replaced by the step
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

/**
 * Answers every request with a 404 on a later turn without sending it: the remote configuration
 * reads as absent and nothing is logged. Uploads never reach it, since the stand-in network is
 * offline.
 */
export function standInTransport(scheduler: Scheduler): HttpTransport {
  // TODO(step 7.3): `fetch` behind `HttpTransport` (Web HTTP 1 to 3).
  return {
    send(_request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void): HttpCall {
      const task = scheduler.yield(() => {
        onOutcome({ kind: 'response', status: 404 });
      });
      return {
        abort: () => {
          task.cancel();
        },
      };
    },
  };
}

/** A page that is always visible and never hides. */
export function visibleLifecycle(): LifecycleSource {
  // TODO(step 7.4): `visibilitychange`, `pagehide` and `pageshow` (Web Session 1, Web Queue 3).
  return { isVisible: () => true, subscribe: () => () => undefined };
}

/** A browser that is offline, so the uploader waits and nothing leaves the page. */
export function offlineNetwork(): NetworkSignal {
  // TODO(step 7.4): `navigator.onLine` and the `online` and `offline` events (Web Retry 2).
  return { isOnline: () => false, subscribe: () => () => undefined };
}

/** A context without browser values; `app` and `library` still come from the configuration. */
export function emptyContext(): ContextProvider {
  // TODO(step 7.5): the user agent, screen and page values of Web Context 1 to 4.
  return { staticValues: () => ({}), callTimeValues: () => ({}) };
}
