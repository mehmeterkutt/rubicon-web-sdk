import type { KeyValueStorage } from 'rubicon-analytics-core';
import { quotaExceededError, securityError } from './dom-exception';

/** Options of a {@link MemoryStorageArea}. */
export interface MemoryStorageAreaOptions {
  /**
   * The origin's quota in UTF-16 code units of keys and values together: 5 MiB, how Chromium and
   * Firefox count it (plan section 15, step 1.4). `setItem` past it throws `QuotaExceededError`.
   */
  readonly quotaChars?: number;
  /**
   * The order `key(i)` lists keys in. Browsers promise none, so a test that must not depend on it
   * runs once with each (Web Disk 2).
   */
  readonly keyOrder?: 'insertion' | 'reverse';
}

/**
 * One origin's `localStorage`: the map every page of the origin shares, with the quota. Pages see it
 * through a {@link MemoryStorage} each.
 */
export class MemoryStorageArea {
  static readonly DEFAULT_QUOTA_CHARS = 5 * 1024 * 1024;

  readonly entries = new Map<string, string>();
  readonly quotaChars: number;
  readonly keyOrder: 'insertion' | 'reverse';

  constructor(options: MemoryStorageAreaOptions = {}) {
    this.quotaChars = options.quotaChars ?? MemoryStorageArea.DEFAULT_QUOTA_CHARS;
    this.keyOrder = options.keyOrder ?? 'insertion';
  }

  /** Code units of every key and value, the measure of the quota. */
  usedChars(): number {
    let used = 0;
    for (const [key, value] of this.entries) used += key.length + value.length;
    return used;
  }

  /** The keys in the order `key(i)` lists them. */
  orderedKeys(): string[] {
    const keys = Array.from(this.entries.keys());
    return this.keyOrder === 'reverse' ? keys.reverse() : keys;
  }

  /** A copy of the contents, for assertions. */
  snapshot(): Record<string, string> {
    const copy: Record<string, string> = {};
    for (const [key, value] of this.entries) copy[key] = value;
    return copy;
  }
}

/**
 * `KeyValueStorage` in memory, one page's view of a {@link MemoryStorageArea}, with the failures of
 * Web Disk 1 and 4 and Web Queue 6 injected as the browser produces them:
 *
 * - `failAccess`: every member throws a `SecurityError` (site data blocked, a sandboxed iframe);
 * - `failWrites`: `setItem` throws a `QuotaExceededError` and stores nothing; the same happens by
 *   itself when the area's quota would be exceeded;
 * - {@link vanishAfterListing}: another page deletes a key right after `key(i)` returned it, so the
 *   following `getItem` gives `null`.
 *
 * {@link otherPage} opens a second page on the same area: each sees the other's writes at once, as
 * two tabs of one origin do. Faults are per page, the quota per area.
 */
export class MemoryStorage implements KeyValueStorage {
  failAccess = false;
  failWrites = false;
  /** Successful `setItem` calls on this page, to check that writes are coalesced. */
  writeCount = 0;

  private readonly vanishing = new Set<string>();

  constructor(readonly area: MemoryStorageArea = new MemoryStorageArea()) {}

  /** A second page of the same origin over the same area. */
  otherPage(): MemoryStorage {
    return new MemoryStorage(this.area);
  }

  /** The next time `key(i)` returns `key`, the key is removed from the area right after. */
  vanishAfterListing(key: string): void {
    this.vanishing.add(key);
  }

  get length(): number {
    this.checkAccess();
    return this.area.entries.size;
  }

  key(index: number): string | null {
    this.checkAccess();
    const key = this.area.orderedKeys()[index];
    if (key === undefined) return null;
    if (this.vanishing.delete(key)) this.area.entries.delete(key);
    return key;
  }

  getItem(key: string): string | null {
    this.checkAccess();
    const value = this.area.entries.get(key);
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.checkAccess();
    if (this.failWrites) throw quotaExceededError();
    const previous = this.area.entries.get(key);
    const freed = previous === undefined ? 0 : key.length + previous.length;
    if (this.area.usedChars() - freed + key.length + value.length > this.area.quotaChars) throw quotaExceededError();
    this.area.entries.set(key, value);
    this.writeCount += 1;
  }

  removeItem(key: string): void {
    this.checkAccess();
    this.area.entries.delete(key);
  }

  private checkAccess(): void {
    if (this.failAccess) throw securityError();
  }
}
