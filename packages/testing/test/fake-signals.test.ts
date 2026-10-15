import type { LifecycleEvent } from 'rubicon-analytics-core';
import { describe, expect, it } from 'vitest';
import { FakeLifecycleSource, FakeNetworkSignal } from '../src';

describe('FakeLifecycleSource', () => {
  it('starts visible unless told otherwise', () => {
    expect(new FakeLifecycleSource().isVisible()).toBe(true);
    expect(new FakeLifecycleSource(false).isVisible()).toBe(false);
  });

  it('reports only real visibility changes, as visibilitychange does', () => {
    const lifecycle = new FakeLifecycleSource();
    const events: LifecycleEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));
    lifecycle.show();
    lifecycle.hide();
    lifecycle.hide();
    lifecycle.show();
    expect(events).toEqual(['hidden', 'visible']);
  });

  it('reports pagehide while still visible and a restore from the back/forward cache as visible', () => {
    const lifecycle = new FakeLifecycleSource();
    const events: LifecycleEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));
    lifecycle.pagehide();
    expect(lifecycle.isVisible()).toBe(true);
    lifecycle.hide();
    lifecycle.pageshowPersisted();
    expect(lifecycle.isVisible()).toBe(true);
    expect(events).toEqual(['pagehide', 'hidden', 'pageshow-persisted']);
  });

  it('stops calling a listener once unsubscribed, also during a dispatch', () => {
    const lifecycle = new FakeLifecycleSource();
    const events: string[] = [];
    const unsubscribeSecond = lifecycle.subscribe(() => events.push('second'));
    const unsubscribeFirst = lifecycle.subscribe(() => {
      events.push('first');
      unsubscribeSecond();
    });
    lifecycle.pagehide();
    lifecycle.pagehide();
    unsubscribeFirst();
    unsubscribeFirst();
    lifecycle.pagehide();
    expect(events).toEqual(['second', 'first', 'first']);
    expect(lifecycle.listenerCount).toBe(0);
  });
});

describe('FakeNetworkSignal', () => {
  it('reports only real changes of navigator.onLine', () => {
    const network = new FakeNetworkSignal();
    const seen: boolean[] = [];
    network.subscribe((online) => seen.push(online));
    network.goOnline();
    network.goOffline();
    network.goOffline();
    expect(network.isOnline()).toBe(false);
    network.goOnline();
    expect(seen).toEqual([false, true]);
    expect(network.listenerCount).toBe(1);
  });

  it('starts offline when told', () => {
    expect(new FakeNetworkSignal(false).isOnline()).toBe(false);
  });
});
