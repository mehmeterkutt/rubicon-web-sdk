import type { Clock } from 'rubicon-analytics-core';

/**
 * The browser's wall clock, `Date.now()` (Web Session 4, Web Retry 3): with the scheduler, the only
 * code of the SDK that reads the time (rule `clock`).
 */
export function createBrowserClock(): Clock {
  return { now: () => Date.now() };
}
