import type { NetworkSignal, Unsubscribe } from 'rubicon-analytics-core';
import { Subscribers } from './subscribers';

/**
 * The browser's network state as the core's {@link NetworkSignal} (Web Retry 2, Web Queue 3).
 * Connected is `navigator.onLine !== false`, read at every call; a browser without the property, or
 * one whose read throws, counts as connected. The `online` and `offline` events on `window` are
 * reported as `true` and `false`: `online` is the local hint for one early attempt after a short
 * delay (the uploader's), never a write; `offline` changes nothing in flight. The two listeners are
 * added at the first `subscribe`, inside the instance's start, never at import (Web Public API 7).
 */
export function createNavigatorNetwork(): NetworkSignal {
  const subscribers = new Subscribers<boolean>();
  const onOnline = (): void => {
    subscribers.emit(true);
  };
  const onOffline = (): void => {
    subscribers.emit(false);
  };
  const attach = (): void => {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  };
  const detach = (): void => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
  return {
    isOnline: isNavigatorOnline,
    subscribe: (listener): Unsubscribe => subscribers.add(listener, attach, detach),
  };
}

/** `navigator.onLine !== false` (Web Retry 2): `false` is a reliable "no network", `true` proves nothing. */
export function isNavigatorOnline(): boolean {
  try {
    const onLine: unknown = navigator.onLine;
    return onLine !== false;
  } catch {
    return true;
  }
}
