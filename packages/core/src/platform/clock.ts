/**
 * Wall-clock time in epoch milliseconds, `Date.now()` in the browser. Event timestamps, session
 * times and every retry deadline come from here, never from `Date` directly, so tests control them.
 *
 * There is only the wall clock: deadlines and the last activity are shared by pages with different
 * time origins, and `performance.now()` stops while the computer sleeps on most systems (Web Session
 * 4, Web Retry 3). A clock that moves back is handled where the time is compared, never here.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch; may move back or jump forward between two reads. */
  now(): number;
}
