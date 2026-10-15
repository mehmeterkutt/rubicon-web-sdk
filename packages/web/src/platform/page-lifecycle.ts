import type { LifecycleEvent, LifecycleSource, Unsubscribe } from 'rubicon-analytics-core';
import { Subscribers } from './subscribers';

/**
 * The page's visibility as the core's {@link LifecycleSource} (Web Session 1, Web Queue 1 and 3, Web
 * Lifecycle 2):
 *
 * - `visibilitychange` on `document` is the background and foreground signal, reported only when the
 *   visibility read in it differs from the last one reported, so the core sees `hidden` and `visible`
 *   alternate;
 * - `pagehide` is always reported; in every engine it arrives while the page is still visible, before
 *   `visibilitychange` (plan section 15, step 1.4), and below Safari 14.1, where `visibilitychange`
 *   does not fire when a page is left, it is the only signal (the core joins the two into one flush);
 * - `pageshow` with `persisted` true is a return from the back/forward cache, a live page again; a
 *   `pageshow` of a first load is not reported.
 *
 * `visibilityState` is read inside every call and event, never kept as the truth (Web Session 1). The
 * three DOM listeners are added at the first `subscribe` and removed with the last, never at import
 * (Web Public API 7). Never `unload`, `beforeunload` or `freeze` (Web Queue 3).
 */
export function createPageLifecycle(): LifecycleSource {
  const subscribers = new Subscribers<LifecycleEvent>();
  // The visibility last reported, so a `visibilitychange` that changes nothing reports nothing.
  let reportedVisible = true;

  const onVisibilityChange = (): void => {
    const visible = isPageVisible();
    if (visible === reportedVisible) return;
    reportedVisible = visible;
    subscribers.emit(visible ? 'visible' : 'hidden');
  };
  const onPageHide = (): void => {
    subscribers.emit('pagehide');
  };
  const onPageShow = (event: Event): void => {
    if (!isPersisted(event)) return;
    reportedVisible = isPageVisible();
    subscribers.emit('pageshow-persisted');
  };

  const attach = (): void => {
    reportedVisible = isPageVisible();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
  };
  const detach = (): void => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  };

  return {
    isVisible: isPageVisible,
    subscribe: (listener): Unsubscribe => subscribers.add(listener, attach, detach),
  };
}

/**
 * `document.visibilityState` is `visible` at the time of the call. `hidden` and the old `prerender`
 * are not. A document without the property (below the floor of Web Public API 6, where every engine
 * has it) or one whose read throws counts as visible, the page the SDK assumed before it could tell.
 */
export function isPageVisible(): boolean {
  try {
    const state: unknown = document.visibilityState;
    return state === undefined || state === 'visible';
  } catch {
    return true;
  }
}

/** `pageshow` with `persisted` true; an event whose reading throws is not a restore. */
function isPersisted(event: Event): boolean {
  try {
    // Typed boolean, but read from whatever the page dispatched: only a real `true` is a restore.
    const persisted: unknown = (event as PageTransitionEvent).persisted;
    return persisted === true;
  } catch {
    return false;
  }
}
