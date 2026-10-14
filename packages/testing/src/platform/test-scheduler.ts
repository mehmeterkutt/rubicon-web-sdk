import type { ScheduledTask, Scheduler } from 'rubicon-analytics-core';
import type { TestClock } from './test-clock';

interface Item {
  readonly sequence: number;
  readonly due: number;
  readonly task: () => void;
  cancelled: boolean;
}

/**
 * A `Scheduler` with virtual time, the counterpart of the Android `TestDispatcher` and the iOS
 * `TestScheduler`: nothing runs until the test asks, and due work runs in order of its due time,
 * then of its submission, never early. `yield` queues at the current time, behind everything already
 * due, so a test can stop between two writer slices with `runNext`.
 *
 * ```ts
 * const clock = new TestClock();
 * const scheduler = new TestScheduler(clock);
 * scheduler.after(5_000, flush);
 * scheduler.runUntilIdle();  // runs what is due now
 * scheduler.advanceBy(5_000); // runs the timer, with the clock moved by 5 s at that moment
 * ```
 *
 * A task that throws is a bug in the code under test: the error reaches the test, after the task
 * was removed, so the scheduler stays usable.
 */
export class TestScheduler implements Scheduler {
  /** `runAll` gives up after this many tasks: work that keeps rescheduling itself never idles. */
  static readonly RUN_ALL_LIMIT = 100_000;

  private virtualNow = 0;
  private sequence = 0;
  private items: Item[] = [];

  /** With a clock, moving virtual time forward moves the clock by the same amount. */
  constructor(private readonly clock?: TestClock) {}

  /** Virtual milliseconds since the scheduler was created; never moves back. */
  get nowMs(): number {
    return this.virtualNow;
  }

  /** Tasks that have not run and were not cancelled. */
  get pendingCount(): number {
    return this.items.filter((item) => !item.cancelled).length;
  }

  /** Milliseconds until the next task is due, `0` when one is due now, `undefined` when idle. */
  get nextDueInMs(): number | undefined {
    const next = this.next();
    return next === undefined ? undefined : next.due - this.virtualNow;
  }

  after(delayMs: number, task: () => void): ScheduledTask {
    // setTimeout semantics: a negative or non-numeric delay is no delay.
    const delay = delayMs > 0 ? delayMs : 0;
    return this.enqueue(this.virtualNow + delay, task);
  }

  yield(task: () => void): ScheduledTask {
    return this.enqueue(this.virtualNow, task);
  }

  /** Runs the one task due first if it is due now; `false` when none is. */
  runNext(): boolean {
    const next = this.next();
    if (next === undefined || next.due > this.virtualNow) return false;
    this.run(next);
    return true;
  }

  /** Runs every task due now, including those they schedule with no delay. */
  runUntilIdle(): void {
    while (this.runNext()) {
      // each pass runs one task
    }
  }

  /**
   * Moves virtual time forward by `millis`, running every task that becomes due on the way in due
   * order, with time (and the clock) set to each task's due time while it runs.
   */
  advanceBy(millis: number): void {
    if (!(millis >= 0)) throw new RangeError('Virtual time never moves back');
    const target = this.virtualNow + millis;
    for (let next = this.next(); next !== undefined && next.due <= target; next = this.next()) {
      this.moveTo(next.due);
      this.run(next);
    }
    this.moveTo(target);
  }

  /** Runs everything, moving time to each task in turn, until nothing is pending. */
  runAll(): void {
    for (let count = 0; ; count += 1) {
      const next = this.next();
      if (next === undefined) return;
      if (count >= TestScheduler.RUN_ALL_LIMIT) {
        throw new Error(`TestScheduler.runAll: still busy after ${String(TestScheduler.RUN_ALL_LIMIT)} tasks`);
      }
      this.moveTo(next.due);
      this.run(next);
    }
  }

  private enqueue(due: number, task: () => void): ScheduledTask {
    this.sequence += 1;
    const item: Item = { sequence: this.sequence, due, task, cancelled: false };
    this.items.push(item);
    return {
      cancel: () => {
        item.cancelled = true;
      },
    };
  }

  private next(): Item | undefined {
    this.items = this.items.filter((item) => !item.cancelled);
    let best: Item | undefined;
    for (const item of this.items) {
      if (best === undefined || item.due < best.due || (item.due === best.due && item.sequence < best.sequence)) {
        best = item;
      }
    }
    return best;
  }

  private run(item: Item): void {
    this.items = this.items.filter((other) => other !== item);
    item.cancelled = true;
    item.task();
  }

  private moveTo(time: number): void {
    if (time <= this.virtualNow) return;
    this.clock?.advanceBy(time - this.virtualNow);
    this.virtualNow = time;
  }
}
