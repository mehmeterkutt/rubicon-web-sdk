import type { Unsubscribe } from 'rubicon-analytics-core';

/**
 * The listeners of one browser signal (lifecycle, network, `storage`), called in the order they were
 * added. The signal's DOM listeners are added by `attach` when the first listener arrives and
 * removed by `detach` when the last one leaves, so nothing is registered before the instance starts
 * (Web Public API 7) or after it stops. A listener that throws is skipped: the core guards its own
 * listeners and logs there, and nothing may reach the browser's event dispatch (root `CLAUDE.md`,
 * non-negotiable 1).
 */
export class Subscribers<T> {
  private readonly list: ((value: T) => void)[] = [];

  get count(): number {
    return this.list.length;
  }

  add(listener: (value: T) => void, attach: () => void, detach: () => void): Unsubscribe {
    // A wrapper per subscription, so the same function added twice is removed one at a time.
    const entry = (value: T): void => {
      listener(value);
    };
    if (this.list.length === 0) attach();
    this.list.push(entry);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const index = this.list.indexOf(entry);
      if (index !== -1) this.list.splice(index, 1);
      if (this.list.length === 0) detach();
    };
  }

  /** Calls every listener with `value`; one removed during the dispatch still hears it. */
  emit(value: T): void {
    for (const listener of this.list.slice()) {
      try {
        listener(value);
      } catch {
        // The core's listeners catch and log themselves; this only keeps the browser's dispatch safe.
      }
    }
  }
}
