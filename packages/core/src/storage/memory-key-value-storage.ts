import type { KeyValueStorage } from '../platform';

/**
 * A page's own `KeyValueStorage` in memory, for the chunks of the memory-only mode (Web Disk 4) and
 * of a page whose consent is pending (Web Privacy 1): the same keys and rules as in `localStorage`,
 * seen by this page only and gone with it. It never throws and has no quota; the capacity rule
 * bounds it (Web Queue 6).
 */
export class MemoryKeyValueStorage implements KeyValueStorage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    let i = 0;
    for (const key of this.entries.keys()) {
      if (i === index) return key;
      i += 1;
    }
    return null;
  }

  getItem(key: string): string | null {
    const value = this.entries.get(key);
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  /** Every key, in insertion order. */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Removes every key. */
  clear(): void {
    this.entries.clear();
  }
}
