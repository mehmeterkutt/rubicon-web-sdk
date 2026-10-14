import type { Analytics } from './analytics';

// The no-op instance (Android `NoOpAnalytics`, Web Public API 3): returned for an unusable
// configuration (Configuration 3) and outside a browser (Web Public API 7), and public so that host
// tests build fakes from it. A fresh object literal on every call, never a class instance or a
// shared object: spread copies own properties only, and a test that replaces a method on its copy
// must not change another's. It reads none of its arguments, so any input from JavaScript is
// accepted, and it logs nothing (no page asks it to). `isOptedOut` is `true` and `deviceId` empty
// (Android log 3.3).

/**
 * Returns an {@link Analytics} that does nothing: every method accepts any input, sends and stores
 * nothing, and returns `undefined`; `isOptedOut` is `true`, since nothing is collected, and
 * `deviceId` is the empty string, since there is no id. Each call returns a new object whose
 * methods are its own properties.
 *
 * Build test fakes by spreading it and replacing the methods you check. A fake built this way keeps
 * compiling when a method is added to {@link Analytics} in a minor version, since the no-op has it;
 * a class that `implements Analytics` does not.
 *
 * @example
 * ```ts
 * const tracked: string[] = [];
 * const analytics: Analytics = {
 *   ...createNoOpAnalytics(),
 *   track: (name) => {
 *     tracked.push(name);
 *   },
 * };
 * checkout(analytics);
 * expect(tracked).toEqual(['Purchase Completed']);
 * ```
 */
export function createNoOpAnalytics(): Analytics {
  return {
    track() {},
    screen() {},
    identify() {},
    reset() {},
    register() {},
    unregister() {},
    flush() {},
    optOut() {},
    optIn() {},
    isOptedOut: true,
    clearLocalData() {},
    deviceId: '',
  };
}
