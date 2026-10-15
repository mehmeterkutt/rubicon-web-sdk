import type { Clock } from 'rubicon-analytics-core';

/**
 * A wall clock that moves only when the test moves it, forwards or backwards. A `TestScheduler`
 * built with it moves it along with virtual time, as `Date.now()` moves while the browser waits for a
 * timer.
 */
export class TestClock implements Clock {
  /** 2025-09-29T12:00:00.000Z, the start of the Android `FakeClock`. */
  static readonly DEFAULT_START = 1_759_147_200_000;

  private current: number;

  constructor(start: number = TestClock.DEFAULT_START) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  set(millis: number): void {
    this.current = millis;
  }

  /** A negative `millis` moves the clock back, as a user changing the computer's time does. */
  advanceBy(millis: number): void {
    this.current += millis;
  }
}
