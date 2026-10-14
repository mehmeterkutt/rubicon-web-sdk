import { describe, expect, it } from 'vitest';
import { TestClock, TestScheduler } from '../src';

describe('TestScheduler', () => {
  describe('the virtual scheduler runs due work in order and never early', () => {
    it('runs nothing until the test asks, not even work with no delay', () => {
      const scheduler = new TestScheduler();
      const ran: string[] = [];
      scheduler.after(0, () => ran.push('timer'));
      scheduler.yield(() => ran.push('slice'));
      expect(ran).toEqual([]);
      expect(scheduler.pendingCount).toBe(2);
    });

    it('runs a timer when its delay has passed and not a millisecond earlier', () => {
      const scheduler = new TestScheduler();
      const ran: number[] = [];
      scheduler.after(1_000, () => ran.push(scheduler.nowMs));
      scheduler.advanceBy(999);
      expect(ran).toEqual([]);
      scheduler.advanceBy(1);
      expect(ran).toEqual([1_000]);
    });

    it('runs due work by due time, then by submission', () => {
      const scheduler = new TestScheduler();
      const ran: string[] = [];
      scheduler.after(300, () => ran.push('c at 300'));
      scheduler.after(100, () => ran.push('a at 100'));
      scheduler.after(100, () => ran.push('b at 100'));
      scheduler.yield(() => ran.push('slice at 0'));
      scheduler.advanceBy(1_000);
      expect(ran).toEqual(['slice at 0', 'a at 100', 'b at 100', 'c at 300']);
    });

    it('runs each task with virtual time set to its due time', () => {
      const scheduler = new TestScheduler();
      const seen: number[] = [];
      scheduler.after(250, () => seen.push(scheduler.nowMs));
      scheduler.after(700, () => seen.push(scheduler.nowMs));
      scheduler.advanceBy(1_000);
      expect(seen).toEqual([250, 700]);
      expect(scheduler.nowMs).toBe(1_000);
    });

    it('runs work scheduled by a task when it falls due inside the same advance', () => {
      const scheduler = new TestScheduler();
      const ran: number[] = [];
      scheduler.after(100, () => {
        ran.push(scheduler.nowMs);
        scheduler.after(100, () => ran.push(scheduler.nowMs));
        scheduler.after(1_000, () => ran.push(scheduler.nowMs));
      });
      scheduler.advanceBy(500);
      expect(ran).toEqual([100, 200]);
      expect(scheduler.pendingCount).toBe(1);
      expect(scheduler.nextDueInMs).toBe(600);
    });

    it('treats a negative or non-numeric delay as no delay, as setTimeout does', () => {
      const scheduler = new TestScheduler();
      const ran: string[] = [];
      scheduler.after(-5, () => ran.push('negative'));
      scheduler.after(Number.NaN, () => ran.push('nan'));
      scheduler.runUntilIdle();
      expect(ran).toEqual(['negative', 'nan']);
      expect(scheduler.nowMs).toBe(0);
    });

    it('never moves virtual time back', () => {
      const scheduler = new TestScheduler();
      expect(() => {
        scheduler.advanceBy(-1);
      }).toThrow(RangeError);
    });
  });

  describe('yielding between writer slices', () => {
    it('queues a yielded slice behind the work already due', () => {
      const scheduler = new TestScheduler();
      const ran: string[] = [];
      scheduler.yield(() => {
        ran.push('slice 1');
        scheduler.yield(() => ran.push('slice 2'));
      });
      scheduler.after(0, () => ran.push('flush'));
      scheduler.runUntilIdle();
      expect(ran).toEqual(['slice 1', 'flush', 'slice 2']);
    });

    it('runs one task at a time with runNext, so a test can act between two slices', () => {
      const scheduler = new TestScheduler();
      const ran: string[] = [];
      scheduler.yield(() => {
        ran.push('slice 1');
        scheduler.yield(() => ran.push('slice 2'));
      });
      expect(scheduler.runNext()).toBe(true);
      expect(ran).toEqual(['slice 1']);
      ran.push('test acts');
      expect(scheduler.runNext()).toBe(true);
      expect(scheduler.runNext()).toBe(false);
      expect(ran).toEqual(['slice 1', 'test acts', 'slice 2']);
    });

    it('runNext does not run a timer that is not due yet', () => {
      const scheduler = new TestScheduler();
      scheduler.after(10, () => undefined);
      expect(scheduler.runNext()).toBe(false);
      expect(scheduler.pendingCount).toBe(1);
    });
  });

  describe('cancel', () => {
    it('keeps a cancelled task from running and from counting as pending', () => {
      const scheduler = new TestScheduler();
      const ran: string[] = [];
      const timer = scheduler.after(100, () => ran.push('cancelled'));
      scheduler.after(100, () => ran.push('kept'));
      timer.cancel();
      expect(scheduler.pendingCount).toBe(1);
      scheduler.advanceBy(100);
      expect(ran).toEqual(['kept']);
    });

    it('does nothing when the task already ran or was cancelled before', () => {
      const scheduler = new TestScheduler();
      let runs = 0;
      const timer = scheduler.after(0, () => (runs += 1));
      scheduler.runUntilIdle();
      timer.cancel();
      timer.cancel();
      expect(runs).toBe(1);
    });

    it('lets a task cancel a later one due at the same time', () => {
      const scheduler = new TestScheduler();
      const ran: string[] = [];
      let second = { cancel: (): void => undefined };
      scheduler.after(50, () => {
        ran.push('first');
        second.cancel();
      });
      second = scheduler.after(50, () => ran.push('second'));
      scheduler.advanceBy(50);
      expect(ran).toEqual(['first']);
    });
  });

  describe('the clock', () => {
    it('moves the clock with virtual time, at each task and to the end of the advance', () => {
      const clock = new TestClock(10_000);
      const scheduler = new TestScheduler(clock);
      const seen: number[] = [];
      scheduler.after(400, () => seen.push(clock.now()));
      scheduler.advanceBy(1_000);
      expect(seen).toEqual([10_400]);
      expect(clock.now()).toBe(11_000);
    });

    it('keeps virtual time when the test moves the clock back, as timers do in a browser', () => {
      const clock = new TestClock(10_000);
      const scheduler = new TestScheduler(clock);
      const ran: number[] = [];
      scheduler.after(1_000, () => ran.push(clock.now()));
      clock.advanceBy(-60_000);
      scheduler.advanceBy(1_000);
      expect(ran).toEqual([-49_000]);
      expect(scheduler.nowMs).toBe(1_000);
    });
  });

  describe('runAll', () => {
    it('runs every pending task, moving time to each in turn', () => {
      const scheduler = new TestScheduler();
      const ran: number[] = [];
      scheduler.after(60_000, () => ran.push(scheduler.nowMs));
      scheduler.after(5_000, () => ran.push(scheduler.nowMs));
      scheduler.runAll();
      expect(ran).toEqual([5_000, 60_000]);
      expect(scheduler.pendingCount).toBe(0);
      expect(scheduler.nextDueInMs).toBeUndefined();
    });

    it('gives up on work that reschedules itself for ever', () => {
      const scheduler = new TestScheduler();
      const again = (): void => {
        scheduler.after(1, again);
      };
      scheduler.after(1, again);
      expect(() => {
        scheduler.runAll();
      }).toThrow(/still busy/);
    });
  });

  it('lets an error of a task reach the test and stays usable', () => {
    const scheduler = new TestScheduler();
    const ran: string[] = [];
    scheduler.after(0, () => {
      throw new Error('bug under test');
    });
    scheduler.after(0, () => ran.push('next'));
    expect(() => {
      scheduler.runUntilIdle();
    }).toThrow('bug under test');
    scheduler.runUntilIdle();
    expect(ran).toEqual(['next']);
    expect(scheduler.pendingCount).toBe(0);
  });
});
