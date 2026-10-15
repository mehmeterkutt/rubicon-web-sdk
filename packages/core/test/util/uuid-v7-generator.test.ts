import { ScriptedRandom, SeededRandom, TestClock } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { UuidV7Generator } from '../../src';
import { ANDROID_UUID_V7_SCENARIOS } from './android-uuid-v7-vectors';

// The Android UuidV7GeneratorTest, ported (Web Event Model 3): its property tests with a seeded
// source, and its scenarios replayed through the words of Android's draws, which give Android's ids.
// The many-threads test has no counterpart: the page has one thread.

const START = 1_759_147_200_123;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup() {
  const clock = new TestClock(START);
  return { clock, generator: new UuidV7Generator(clock, new SeededRandom(1)) };
}

const make = (generator: UuidV7Generator, count: number): string[] =>
  Array.from({ length: count }, () => generator.next());

// Lowercase hex of fixed width: string order is numeric order.
function expectAscending(ids: readonly string[]): void {
  for (let i = 1; i < ids.length; i += 1) {
    expect(ids[i - 1]! < ids[i]!, `${ids[i - 1]!} should sort before ${ids[i]!}`).toBe(true);
  }
}

// The 48 bits of milliseconds: the first 12 hex digits.
const timestampOf = (id: string): number => parseInt(id.replace(/-/g, '').slice(0, 12), 16);

// The 42-bit counter: 12 bits after the version digit, then 30 bits after the variant bits.
function counterOf(id: string): number {
  const hex = id.replace(/-/g, '');
  return parseInt(hex.slice(13, 16), 16) * 2 ** 30 + (parseInt(hex.slice(16, 24), 16) % 2 ** 30);
}

describe('UuidV7Generator', () => {
  describe('bit layout', () => {
    it('is a version 7, RFC variant UUID in lowercase', () => {
      const { generator } = setup();
      const id = generator.next();

      expect(id).toMatch(UUID_V7);
      expect(id).toHaveLength(36);
    });

    it("the timestamp field is the clock's time", () => {
      const { clock, generator } = setup();
      expect(timestampOf(generator.next())).toBe(clock.now());
      clock.advanceBy(5_000);
      expect(timestampOf(generator.next())).toBe(clock.now());
    });

    it('the same seed and clock give the same ids', () => {
      const a = new UuidV7Generator(new TestClock(0), new SeededRandom(9));
      const b = new UuidV7Generator(new TestClock(0), new SeededRandom(9));

      expect(make(a, 3)).toEqual(make(b, 3));
    });

    it('a fresh counter has its top bit clear', () => {
      const clock = new TestClock(START);
      // All ones: the seed is the largest the mask lets through, 2^41 - 1.
      const generator = new UuidV7Generator(clock, new ScriptedRandom([0xffff_ffff, 0xffff_ffff, 0]));

      expect(counterOf(generator.next())).toBe(2 ** 41 - 1);
    });

    it('writes the largest timestamp and the largest seed without losing a bit', () => {
      // 2^48 - 1 milliseconds, the seed 2^41 - 1 split over rand_a and rand_b, a tail of all ones.
      const generator = new UuidV7Generator(
        new TestClock(2 ** 48 - 1),
        new ScriptedRandom([0x1ff, 0xffff_ffff, 0xffff_ffff]),
      );

      expect(generator.next()).toBe('ffffffff-ffff-77ff-bfff-ffffffffffff');
    });

    it('the counter and tail come from the random source in order', () => {
      // Seed 5 (high word 0, low word 5), tail 0xDEADBEEF; the second id increments the counter and
      // draws a new tail (the iOS vector).
      const random = new ScriptedRandom([0, 5, 0xdead_beef, 0xcafe_babe]);
      const generator = new UuidV7Generator(new TestClock(0x0192_e4a1_7c3f), random);

      expect(generator.next()).toBe('0192e4a1-7c3f-7000-8000-0005deadbeef');
      expect(generator.next()).toBe('0192e4a1-7c3f-7000-8000-0006cafebabe');
      expect(random.drawn).toBe(4);
    });

    it("a clock before 1970 is written as the 48-bit two's complement, as Android masks it", () => {
      const generator = new UuidV7Generator(new TestClock(-1), new ScriptedRandom([0, 0, 0]));

      expect(generator.next()).toBe('ffffffff-ffff-7000-8000-000000000000');
    });
  });

  describe('sort order', () => {
    it('10 000 ids in one millisecond are unique and ordered', () => {
      const { clock, generator } = setup();
      const ids = make(generator, 10_000);

      expect(new Set(ids).size).toBe(10_000);
      expectAscending(ids);
      expect(ids.every((id) => timestampOf(id) === clock.now())).toBe(true);
    });

    it('ids of a later millisecond sort after', () => {
      const { clock, generator } = setup();
      const first = make(generator, 100);
      clock.advanceBy(1);
      const second = make(generator, 100);

      expectAscending([...first, ...second]);
    });

    it('order holds when the clock moves back', () => {
      const { clock, generator } = setup();
      const before = make(generator, 50);
      clock.advanceBy(-86_400_000);
      const after = make(generator, 50);

      expectAscending([...before, ...after]);
      expect(timestampOf(after[after.length - 1]!)).toBe(timestampOf(before[before.length - 1]!));
    });

    it('a full counter moves the timestamp one millisecond ahead', () => {
      // A 3-bit counter: seeds 0 to 3, at most 7, so a few ids overflow it.
      const clock = new TestClock(START);
      const small = new UuidV7Generator(clock, new SeededRandom(1), 7);
      const ids = make(small, 40);

      expectAscending(ids);
      expect(new Set(ids).size).toBe(40);
      expect(timestampOf(ids[ids.length - 1]!)).toBeGreaterThan(clock.now());
    });
  });

  describe('the Android ids, replayed', () => {
    it.each(ANDROID_UUID_V7_SCENARIOS)('$name', (scenario) => {
      const clock = new TestClock(scenario.start);
      const random = new ScriptedRandom(scenario.words);
      const generator = new UuidV7Generator(clock, random, scenario.counterMax);
      const ids: string[] = [];
      for (const step of scenario.steps) {
        clock.advanceBy(step.advanceBy);
        ids.push(...make(generator, step.ids));
      }

      expect(ids).toEqual(scenario.ids);
      expect(random.drawn).toBe(scenario.words.length);
    });
  });
});
