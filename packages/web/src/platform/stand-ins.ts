import type { ContextProvider } from 'rubicon-analytics-core';

// The part of the browser `Platform` that step 7.5 builds, standing in until then as Android's and
// iOS's step 7.1 did (Android log 7.1, iOS log 7.1). Storage and cookies are the browser's since step
// 7.2, the transport since step 7.3, the lifecycle, network and `storage` signals since step 7.4. This
// file goes with step 7.5. Never published: nothing is released before step 8.6.

/** A context without browser values; `app` and `library` still come from the configuration. */
export function emptyContext(): ContextProvider {
  // TODO(step 7.5): the user agent, screen and page values of Web Context 1 to 4.
  return { staticValues: () => ({}), callTimeValues: () => ({}) };
}
