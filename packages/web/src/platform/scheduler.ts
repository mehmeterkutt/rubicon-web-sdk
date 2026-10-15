import type { ScheduledTask, Scheduler } from 'rubicon-analytics-core';

// The longest delay `setTimeout` keeps: a larger one fires at once in every engine. A deadline
// beyond it fires early here and the work checks its own deadline against the clock, as it does for
// any timer (Web Retry 3).
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The browser's {@link Scheduler} over `setTimeout` (Web Queue 1, Web Retry 3). `yield` is a timer of
 * zero: a new task of the event loop, so the browser may paint and handle input between two writer
 * slices, where a microtask would run before the paint (Web Queue 1). It works in a hidden tab as
 * well, unlike `requestAnimationFrame`, and needs no feature detection. `setTimeout` is read at
 * every call, never at import.
 */
export function createBrowserScheduler(): Scheduler {
  return {
    after: (delayMs, task) => schedule(Math.min(Math.max(delayMs, 0), MAX_TIMEOUT_MS), task),
    yield: (task) => schedule(0, task),
  };
}

function schedule(delayMs: number, task: () => void): ScheduledTask {
  const id = setTimeout(task, delayMs);
  return {
    cancel: () => {
      clearTimeout(id);
    },
  };
}
