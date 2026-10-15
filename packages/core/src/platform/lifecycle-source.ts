/** Removes a listener added by a `subscribe`; calling it again does nothing. */
export type Unsubscribe = () => void;

/**
 * What the page reports about itself (Web Session 1, Web Queue 1 and 3, Web Lifecycle 2):
 *
 * - `visible`: the tab became visible, the user's return (`visibilitychange`);
 * - `hidden`: the tab became hidden, the web's background (`visibilitychange`);
 * - `pagehide`: the page is being left, possibly into the back/forward cache;
 * - `pageshow-persisted`: the page came back from the back/forward cache (`pageshow` with
 *   `persisted` true), a live page again.
 *
 * The browser implementation joins `visibilitychange` with `pagehide` and `pageshow` below Safari
 * 14.1; the core only sees these four. Never `unload`, `beforeunload` or `freeze` (Web Queue 3).
 */
export type LifecycleEvent = 'visible' | 'hidden' | 'pagehide' | 'pageshow-persisted';

/**
 * The page's visibility, the browser's counterpart of the foreground (Web Session 1). Listeners are
 * added by the SDK instance inside the factory, never at import (Web Public API 7), and run
 * synchronously inside the browser's event, so the drain on hiding can finish there (Web Queue 1).
 */
export interface LifecycleSource {
  /** `document.visibilityState` is `visible`, read at the time of the call. */
  isVisible(): boolean;

  subscribe(listener: (event: LifecycleEvent) => void): Unsubscribe;
}
