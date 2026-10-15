import type { Unsubscribe } from './lifecycle-source';

/**
 * Changes another page of the origin made to `localStorage`: the browser's `storage` event, which
 * fires in every other document of the origin, never in the one that wrote (Web Privacy 2, point
 * 3). A pending page listens for the consent mirror's key to pick up a decision made in another tab.
 * The listener is added inside the factory, never at import (Web Public API 7).
 */
export interface StorageSignal {
  /** `key` is the changed key, or `null` when the other page cleared the whole area. */
  subscribe(listener: (key: string | null) => void): Unsubscribe;
}
