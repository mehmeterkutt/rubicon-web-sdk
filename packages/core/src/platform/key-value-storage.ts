/**
 * The origin's `localStorage`, as the core sees it (Web Disk 1): synchronous, shared by every page of
 * the origin, written by the host application as well. The methods are those of the Web Storage API
 * and fail the way it does, so the core is written against the browser's behaviour:
 *
 * - every member may throw a `SecurityError` when storage cannot be used (site data blocked, a
 *   sandboxed iframe); the start probe turns that into the memory-only mode (Web Disk 4);
 * - `setItem` may throw a `QuotaExceededError` and then stores nothing (Web Queue 6);
 * - `getItem` returns `null` for a key another page deleted after it was listed (Web Disk 1);
 * - `key(i)` follows no order the core may rely on, and the indexes shift when keys come and go, so
 *   a walk collects every key before it deletes anything (Web Disk 2).
 *
 * The web implementation forwards to `localStorage` without catching; the callers in the core catch,
 * because what a failure means depends on what was being done.
 */
export interface KeyValueStorage {
  /** The number of keys of the origin, the host's included. */
  readonly length: number;

  /** The key at `index`, or `null` when there is none (out of range, or the set changed). */
  key(index: number): string | null;

  /** The value of `key`, or `null` when it is missing. */
  getItem(key: string): string | null;

  /** Writes `value` under `key` whole, or throws and leaves the previous value as it was. */
  setItem(key: string, value: string): void;

  /** Removes `key`; removing a missing key does nothing. */
  removeItem(key: string): void;
}
