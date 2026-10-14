import type { LifecycleEvent, LifecycleSource, NetworkSignal, Unsubscribe } from 'rubicon-analytics-core';

/** Listeners called in the order they were added; one removed during a dispatch still hears it. */
class Listeners<T> {
  private readonly list: ((value: T) => void)[] = [];

  get count(): number {
    return this.list.length;
  }

  add(listener: (value: T) => void): Unsubscribe {
    // A wrapper per subscription, so the same function added twice is removed one at a time.
    const entry = (value: T): void => {
      listener(value);
    };
    this.list.push(entry);
    return () => {
      const index = this.list.indexOf(entry);
      if (index !== -1) this.list.splice(index, 1);
    };
  }

  emit(value: T): void {
    for (const listener of this.list.slice()) listener(value);
  }
}

/**
 * The page's visibility as the test switches it. `hide` and `show` report only real changes, as
 * `visibilitychange` does; `pagehide` and `pageshowPersisted` always report. In every engine
 * `pagehide` arrives while the page is still visible, before `visibilitychange` (plan section 15,
 * step 1.4), so a test of a page being left calls `pagehide()` and then `hide()`.
 */
export class FakeLifecycleSource implements LifecycleSource {
  private readonly listeners = new Listeners<LifecycleEvent>();

  constructor(private visible: boolean = true) {}

  get listenerCount(): number {
    return this.listeners.count;
  }

  isVisible(): boolean {
    return this.visible;
  }

  subscribe(listener: (event: LifecycleEvent) => void): Unsubscribe {
    return this.listeners.add(listener);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.listeners.emit('hidden');
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.listeners.emit('visible');
  }

  pagehide(): void {
    this.listeners.emit('pagehide');
  }

  /** A restore from the back/forward cache: the page is visible and live again. */
  pageshowPersisted(): void {
    this.visible = true;
    this.listeners.emit('pageshow-persisted');
  }
}

/** `navigator.onLine` and its events as the test switches them; only real changes are reported. */
export class FakeNetworkSignal implements NetworkSignal {
  private readonly listeners = new Listeners<boolean>();

  constructor(private online: boolean = true) {}

  get listenerCount(): number {
    return this.listeners.count;
  }

  isOnline(): boolean {
    return this.online;
  }

  subscribe(listener: (online: boolean) => void): Unsubscribe {
    return this.listeners.add(listener);
  }

  goOffline(): void {
    this.set(false);
  }

  goOnline(): void {
    this.set(true);
  }

  private set(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.listeners.emit(online);
  }
}
