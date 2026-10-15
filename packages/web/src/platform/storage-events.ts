import type { StorageSignal, Unsubscribe } from 'rubicon-analytics-core';
import { Subscribers } from './subscribers';

/**
 * Another document of the origin changed `localStorage`: the `storage` event on `window`, which never
 * fires in the document that wrote (Web Privacy 2, point 3). A pending or refused page acts on the
 * consent mirror's key and on a cleared area (`key` `null`); every other key is ignored by the core.
 * The event's `storageArea` is not compared with `localStorage`: reading `localStorage` can throw
 * (Web Disk 4), and an event of another area can only cost the core one more read of the decision.
 * The listener is added at the first `subscribe`, inside the instance's start, never at import (Web
 * Public API 7).
 */
export function createStorageEvents(): StorageSignal {
  const subscribers = new Subscribers<string | null>();
  const onStorage = (event: Event): void => {
    subscribers.emit(changedKey(event));
  };
  const attach = (): void => {
    window.addEventListener('storage', onStorage);
  };
  const detach = (): void => {
    window.removeEventListener('storage', onStorage);
  };
  return { subscribe: (listener): Unsubscribe => subscribers.add(listener, attach, detach) };
}

/** The event's `key`, `null` for a cleared area; an event whose reading throws counts as a cleared one. */
function changedKey(event: Event): string | null {
  try {
    const key: unknown = (event as StorageEvent).key;
    return typeof key === 'string' ? key : null;
  } catch {
    return null;
  }
}
