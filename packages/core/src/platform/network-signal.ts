import type { Unsubscribe } from './lifecycle-source';

/**
 * The browser's view of the network (Web Retry 2, Web Queue 3). `false` is a reliable "no network",
 * `true` proves nothing, so connected means `navigator.onLine !== false`. The `online` event is a
 * local hint for one early attempt and never a write; `offline` only updates the state, and a request
 * in flight is not cancelled.
 */
export interface NetworkSignal {
  /** `navigator.onLine !== false`, read at the time of the call. */
  isOnline(): boolean;

  /** Called with `true` on `online` and `false` on `offline`. */
  subscribe(listener: (online: boolean) => void): Unsubscribe;
}
