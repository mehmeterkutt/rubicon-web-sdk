import type { LifecycleEvent } from 'rubicon-analytics-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createNavigatorNetwork, isNavigatorOnline } from '../../src/platform/network-signal';
import { createPageLifecycle, isPageVisible } from '../../src/platform/page-lifecycle';
import { createStorageEvents } from '../../src/platform/storage-events';
import { Subscribers } from '../../src/platform/subscribers';

// The browser signals of step 7.4 in jsdom: the lifecycle over `visibilitychange`, `pagehide` and
// `pageshow` (Web Session 1, Web Queue 3, Web Lifecycle 2), the network over `navigator.onLine` and
// `online` and `offline` (Web Retry 2), and the `storage` event (Web Privacy 2). Events are dispatched
// by hand with the browser's names; what the engines do is the Playwright suite's
// (test/browser/page-lifecycle.spec.ts). Every replaced property is restored after each test.

const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

/** Replaces `name` on `target` with `descriptor` until the end of the test. */
function replaceProperty(target: object, name: string, descriptor: PropertyDescriptor): void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  restores.push(() => {
    if (own) Object.defineProperty(target, name, own);
    else Reflect.deleteProperty(target, name);
  });
}

let visibility: unknown = 'visible';

function controlVisibility(initial: unknown = 'visible'): void {
  visibility = initial;
  replaceProperty(document, 'visibilityState', { get: () => visibility });
}

function changeVisibility(state: string): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function pageshow(persisted: boolean): void {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

/** Counts the listeners added and removed on `target` for each event type until the end of the test. */
function countListeners(target: EventTarget): Map<string, number> {
  const counts = new Map<string, number>();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  replaceProperty(target, 'addEventListener', {
    value: (type: string, listener: EventListener) => {
      counts.set(type, (counts.get(type) ?? 0) + 1);
      add(type, listener);
    },
  });
  replaceProperty(target, 'removeEventListener', {
    value: (type: string, listener: EventListener) => {
      counts.set(type, (counts.get(type) ?? 0) - 1);
      remove(type, listener);
    },
  });
  return counts;
}

describe('the page lifecycle', () => {
  it('reports hidden and visible from visibilitychange, only when the visibility changed', () => {
    controlVisibility();
    const events: LifecycleEvent[] = [];
    const unsubscribe = createPageLifecycle().subscribe((event) => events.push(event));
    changeVisibility('hidden');
    changeVisibility('hidden');
    changeVisibility('visible');
    changeVisibility('visible');
    changeVisibility('hidden');
    unsubscribe();
    expect(events).toEqual(['hidden', 'visible', 'hidden']);
  });

  it('starts from the visibility read at the first subscribe', () => {
    controlVisibility('hidden');
    const events: LifecycleEvent[] = [];
    const unsubscribe = createPageLifecycle().subscribe((event) => events.push(event));
    changeVisibility('hidden');
    changeVisibility('visible');
    unsubscribe();
    expect(events).toEqual(['visible']);
  });

  it('reads visibilityState at every call', () => {
    controlVisibility();
    const lifecycle = createPageLifecycle();
    expect(lifecycle.isVisible()).toBe(true);
    visibility = 'hidden';
    expect(lifecycle.isVisible()).toBe(false);
    visibility = 'prerender';
    expect(lifecycle.isVisible()).toBe(false);
    visibility = 'visible';
    expect(lifecycle.isVisible()).toBe(true);
  });

  it('counts a document without visibilityState, or one whose read throws, as visible', () => {
    controlVisibility(undefined);
    expect(isPageVisible()).toBe(true);
    replaceProperty(document, 'visibilityState', {
      get: () => {
        throw new Error('no document');
      },
    });
    expect(isPageVisible()).toBe(true);
  });

  it('always reports pagehide, also while the page is still visible', () => {
    controlVisibility();
    const events: LifecycleEvent[] = [];
    const unsubscribe = createPageLifecycle().subscribe((event) => events.push(event));
    window.dispatchEvent(new Event('pagehide'));
    changeVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    unsubscribe();
    expect(events).toEqual(['pagehide', 'hidden', 'pagehide']);
  });

  it('reports a pageshow with persisted as a restore, never the pageshow of a first load', () => {
    controlVisibility();
    const events: LifecycleEvent[] = [];
    const unsubscribe = createPageLifecycle().subscribe((event) => events.push(event));
    pageshow(false);
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('pagehide'));
    changeVisibility('hidden');
    // The engine makes the page visible again before pageshow (HTML "reactivate"), so the core
    // hears the return and then the restore.
    changeVisibility('visible');
    pageshow(true);
    unsubscribe();
    expect(events).toEqual(['pagehide', 'hidden', 'visible', 'pageshow-persisted']);
  });

  it('below Safari 14.1, a restore after pagehide alone takes the visibility read at the pageshow', () => {
    // No visibilitychange when the page is left: pagehide is the only signal, and pageshow the return.
    controlVisibility();
    const events: LifecycleEvent[] = [];
    const unsubscribe = createPageLifecycle().subscribe((event) => events.push(event));
    window.dispatchEvent(new Event('pagehide'));
    visibility = 'hidden';
    pageshow(true);
    changeVisibility('visible');
    unsubscribe();
    expect(events).toEqual(['pagehide', 'pageshow-persisted', 'visible']);
  });

  it('adds its listeners at the first subscribe and removes them with the last', () => {
    controlVisibility();
    const onDocument = countListeners(document);
    const onWindow = countListeners(window);
    const lifecycle = createPageLifecycle();
    expect([...onDocument.values(), ...onWindow.values()]).toEqual([]);

    const first = lifecycle.subscribe(() => undefined);
    const second = lifecycle.subscribe(() => undefined);
    expect(Object.fromEntries(onDocument)).toEqual({ visibilitychange: 1 });
    expect(Object.fromEntries(onWindow)).toEqual({ pagehide: 1, pageshow: 1 });

    first();
    first();
    expect(Object.fromEntries(onWindow)).toEqual({ pagehide: 1, pageshow: 1 });
    second();
    expect(Object.fromEntries(onDocument)).toEqual({ visibilitychange: 0 });
    expect(Object.fromEntries(onWindow)).toEqual({ pagehide: 0, pageshow: 0 });
  });

  it('never listens to unload, beforeunload or freeze (Web Queue 3)', () => {
    controlVisibility();
    const onDocument = countListeners(document);
    const onWindow = countListeners(window);
    const unsubscribe = createPageLifecycle().subscribe(() => undefined);
    unsubscribe();
    expect([...onDocument.keys(), ...onWindow.keys()].sort()).toEqual(['pagehide', 'pageshow', 'visibilitychange']);
  });

  it('a listener that throws neither stops the others nor reaches the event dispatch', () => {
    controlVisibility();
    const events: LifecycleEvent[] = [];
    const lifecycle = createPageLifecycle();
    const throwing = lifecycle.subscribe(() => {
      throw new Error('listener failed');
    });
    const recording = lifecycle.subscribe((event) => events.push(event));
    const reported: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      reported.push(event.error);
    };
    window.addEventListener('error', onError);
    window.dispatchEvent(new Event('pagehide'));
    changeVisibility('hidden');
    window.removeEventListener('error', onError);
    throwing();
    recording();
    expect(events).toEqual(['pagehide', 'hidden']);
    expect(reported).toEqual([]);
  });
});

describe('the network signal', () => {
  function navigatorWith(onLine: PropertyDescriptor): void {
    const stub = {};
    Object.defineProperty(stub, 'onLine', onLine);
    replaceProperty(globalThis, 'navigator', { value: stub, writable: true });
  }

  it('is connected unless navigator.onLine is false, read at every call', () => {
    const network = createNavigatorNetwork();
    let onLine: unknown = true;
    navigatorWith({ get: () => onLine });
    expect(network.isOnline()).toBe(true);
    onLine = false;
    expect(network.isOnline()).toBe(false);
    onLine = undefined;
    expect(network.isOnline()).toBe(true);
  });

  it('a browser without the property, or one whose read throws, counts as connected', () => {
    replaceProperty(globalThis, 'navigator', { value: {}, writable: true });
    expect(isNavigatorOnline()).toBe(true);
    navigatorWith({
      get: () => {
        throw new Error('no navigator');
      },
    });
    expect(isNavigatorOnline()).toBe(true);
  });

  it('reports online as true and offline as false, each time the browser fires them', () => {
    const changes: boolean[] = [];
    const unsubscribe = createNavigatorNetwork().subscribe((online) => changes.push(online));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    unsubscribe();
    window.dispatchEvent(new Event('offline'));
    expect(changes).toEqual([false, true, true]);
  });

  it('adds its listeners at the first subscribe and removes them with the last', () => {
    const onWindow = countListeners(window);
    const network = createNavigatorNetwork();
    expect([...onWindow.values()]).toEqual([]);
    const first = network.subscribe(() => undefined);
    const second = network.subscribe(() => undefined);
    expect(Object.fromEntries(onWindow)).toEqual({ online: 1, offline: 1 });
    first();
    second();
    expect(Object.fromEntries(onWindow)).toEqual({ online: 0, offline: 0 });
  });
});

describe('the storage signal', () => {
  function storageEvent(key: unknown): Event {
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: key });
    return event;
  }

  it('reports the changed key, and null for a cleared area', () => {
    const keys: (string | null)[] = [];
    const unsubscribe = createStorageEvents().subscribe((key) => keys.push(key));
    window.dispatchEvent(storageEvent('rubicon.0123456789abcdef.consent'));
    window.dispatchEvent(storageEvent(null));
    window.dispatchEvent(storageEvent('host.key'));
    unsubscribe();
    window.dispatchEvent(storageEvent('after'));
    expect(keys).toEqual(['rubicon.0123456789abcdef.consent', null, 'host.key']);
  });

  it('reports an event whose key cannot be read as a cleared area', () => {
    const keys: (string | null)[] = [];
    const unsubscribe = createStorageEvents().subscribe((key) => keys.push(key));
    const unreadable = new Event('storage');
    Object.defineProperty(unreadable, 'key', {
      get: () => {
        throw new Error('unreadable');
      },
    });
    window.dispatchEvent(unreadable);
    unsubscribe();
    expect(keys).toEqual([null]);
  });

  it('adds its listener at the first subscribe and removes it with the last', () => {
    const onWindow = countListeners(window);
    const events = createStorageEvents();
    const first = events.subscribe(() => undefined);
    const second = events.subscribe(() => undefined);
    expect(Object.fromEntries(onWindow)).toEqual({ storage: 1 });
    second();
    first();
    expect(Object.fromEntries(onWindow)).toEqual({ storage: 0 });
  });
});

describe('the subscribers of a signal', () => {
  it('calls listeners in the order they were added, the same function once per subscription', () => {
    const calls: string[] = [];
    const subscribers = new Subscribers<number>();
    const listener = (value: number): void => {
      calls.push(`a${String(value)}`);
    };
    const first = subscribers.add(listener, noop, noop);
    subscribers.add((value) => calls.push(`b${String(value)}`), noop, noop);
    subscribers.add(listener, noop, noop);
    subscribers.emit(1);
    first();
    subscribers.emit(2);
    expect(calls).toEqual(['a1', 'b1', 'a1', 'b2', 'a2']);
    expect(subscribers.count).toBe(2);
  });

  it('lets a listener removed during a dispatch still hear it', () => {
    const calls: string[] = [];
    const subscribers = new Subscribers<string>();
    const second: { remove?: () => void } = {};
    subscribers.add(
      (value) => {
        calls.push(`first ${value}`);
        second.remove?.();
      },
      noop,
      noop,
    );
    second.remove = subscribers.add((value) => calls.push(`second ${value}`), noop, noop);
    subscribers.emit('x');
    subscribers.emit('y');
    expect(calls).toEqual(['first x', 'second x', 'first y']);
  });
});

function noop(): void {
  // Nothing to attach in these tests.
}
