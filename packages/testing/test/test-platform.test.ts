import type { Platform } from 'rubicon-analytics-core';
import { describe, expect, it } from 'vitest';
import { ScriptedRandom, SeededRandom, TestClock, TestPlatform } from '../src';

describe('TestClock', () => {
  it('starts at the Android FakeClock start and moves only when told, also backwards', () => {
    const clock = new TestClock();
    expect(clock.now()).toBe(1_759_147_200_000);
    clock.advanceBy(-1_000);
    expect(clock.now()).toBe(1_759_147_199_000);
    clock.set(5);
    expect(clock.now()).toBe(5);
  });
});

describe('SeededRandom', () => {
  it('gives the same 32-bit sequence for the same seed and another for another seed', () => {
    const draw = (random: SeededRandom): number[] => Array.from({ length: 1_000 }, () => random.nextUint32());
    const first = draw(new SeededRandom(7));
    expect(draw(new SeededRandom(7))).toEqual(first);
    expect(draw(new SeededRandom(8))).not.toEqual(first);
    for (const value of first) {
      expect(Number.isInteger(value) && value >= 0 && value < 2 ** 32).toBe(true);
    }
    expect(new Set(first).size).toBeGreaterThan(990);
  });
});

describe('ScriptedRandom', () => {
  it('returns its words in order, counts them and throws when they run out', () => {
    const random = new ScriptedRandom([0, 0xffff_ffff, 7]);
    expect([random.nextUint32(), random.nextUint32(), random.nextUint32()]).toEqual([0, 0xffff_ffff, 7]);
    expect(random.drawn).toBe(3);
    expect(() => random.nextUint32()).toThrow('all 3 words drawn');
  });

  it('refuses a word that is not a 32-bit unsigned integer', () => {
    for (const word of [-1, 2 ** 32, 1.5, Number.NaN]) {
      expect(() => new ScriptedRandom([word])).toThrow(RangeError);
    }
  });
});

describe('TestPlatform', () => {
  it('assembles a Platform from its fakes', () => {
    const test = new TestPlatform();
    const platform: Platform = test.platform;
    expect(platform.clock).toBe(test.clock);
    expect(platform.random).toBe(test.random);
    expect(platform.storage).toBe(test.storage);
    expect(platform.cookies).toBe(test.cookies);
    expect(platform.transport).toBe(test.transport);
    expect(platform.lifecycle).toBe(test.lifecycle);
    expect(platform.network).toBe(test.network);
    expect(platform.context).toBe(test.context);
    expect(platform.scheduler).toBe(test.scheduler);
  });

  it('applies its options', () => {
    const test = new TestPlatform({
      now: 1_000,
      seed: 3,
      storage: { quotaChars: 100 },
      page: { host: 'localhost', secure: false },
      visible: false,
      online: false,
    });
    expect(test.clock.now()).toBe(1_000);
    expect(test.random.seed).toBe(3);
    expect(test.storage.area.quotaChars).toBe(100);
    expect(test.cookies.host).toBe('localhost');
    expect(test.cookies.secure).toBe(false);
    expect(test.lifecycle.isVisible()).toBe(false);
    expect(test.network.isOnline()).toBe(false);
  });

  it('moves the clock with the scheduler', () => {
    const test = new TestPlatform();
    const start = test.clock.now();
    let seen = 0;
    test.scheduler.after(5_000, () => (seen = test.clock.now()));
    test.scheduler.advanceBy(5_000);
    expect(seen).toBe(start + 5_000);
  });

  describe('a second page shares the browser', () => {
    it('sees the first page’s storage writes and cookies', () => {
      const first = new TestPlatform();
      const second = first.otherPage({ page: { host: 'b.rubicon.test' } });
      first.storage.setItem('rubicon.k.device', '{"v":1}');
      expect(second.storage.getItem('rubicon.k.device')).toBe('{"v":1}');
      first.cookies.write({
        name: 'rubicon_k',
        value: 'id',
        domain: 'rubicon.test',
        path: '/',
        maxAgeSeconds: 60,
        sameSite: 'Lax',
        secure: true,
      });
      expect(second.cookies.readAll()).toBe('rubicon_k=id');
      expect(second.cookies.host).toBe('b.rubicon.test');
    });

    it('shares the clock, virtual time and the network state', () => {
      const first = new TestPlatform();
      const second = first.otherPage();
      expect(second.clock).toBe(first.clock);
      expect(second.scheduler).toBe(first.scheduler);
      first.network.goOffline();
      expect(second.network.isOnline()).toBe(false);
    });

    it('has its own visibility, transport, context and random sequence', () => {
      const first = new TestPlatform();
      const second = first.otherPage({ visible: false });
      expect(first.lifecycle.isVisible()).toBe(true);
      expect(second.lifecycle.isVisible()).toBe(false);
      expect(second.transport).not.toBe(first.transport);
      expect(second.context).not.toBe(first.context);
      expect(second.random.seed).toBe(first.random.seed + 1);
      expect(second.random.nextUint32()).not.toBe(first.random.nextUint32());
    });

    it('keeps the first page’s host by default', () => {
      const first = new TestPlatform({ page: { host: 'localhost', secure: false } });
      const second = first.otherPage();
      expect(second.cookies.host).toBe('localhost');
      expect(second.cookies.secure).toBe(false);
    });
  });
});
