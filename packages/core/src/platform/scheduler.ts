/** Scheduled work that has not run yet; cancelling it after it ran, or twice, does nothing. */
export interface ScheduledTask {
  cancel(): void;
}

/**
 * Runs the SDK's deferred work on the page's one thread (Web Queue 1): the writer's slices and every
 * timer. In the browser `after` is `setTimeout`; tests use the virtual-time `TestScheduler` of
 * `rubicon-analytics-testing`, so no unit test waits in real time.
 *
 * Timers are hints (Web Retry 3): a hidden tab's timer may fire minutes late and a page in the
 * back/forward cache fires none until it is restored, so the work they start checks its own
 * deadline against the `Clock`, and catch-up runs on becoming visible and on a restore. A task is
 * never run synchronously inside the call that schedules it and is not expected to throw.
 */
export interface Scheduler {
  /** Runs `task` once `delayMs` have passed, not earlier; a delay below zero counts as zero. */
  after(delayMs: number, task: () => void): ScheduledTask;

  /**
   * Runs `task` in a later turn of the event loop, after the browser had the chance to paint and to
   * handle input: how the writer yields between slices (Web Queue 1).
   */
  yield(task: () => void): ScheduledTask;
}
