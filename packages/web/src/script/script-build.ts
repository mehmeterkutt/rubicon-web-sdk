import { SDK_VERSION } from 'rubicon-analytics-core';
import { factoryLog } from '../create-analytics';
import { adoptSnippet } from './snippet-adapter';

// The script build (Web Public API 2, 7; Web HTTP 6): `dist/rubicon.min.js`, an IIFE that installs
// `window.Rubicon`, holding the package's runtime exports (the same `createAnalytics`), and no other
// global, then takes over the snippet's stub when the page has one (`snippet-adapter.ts`).
//
// A second load of the library on the page (the tag pasted twice, a tag manager adding it again) is
// refused (Web Public API 2): it finds `window.Rubicon` already there and changes nothing, neither
// `window.Rubicon` nor `window.rubicon`, and logs `SECOND_INSTANCE`, the code of a second copy of
// the SDK on a page (Web Configuration 3). A page whose own script already uses the name `Rubicon` is
// refused the same way: the SDK never overwrites a global it did not make.

/** The global the script build installs (Web Public API 2). */
const NAMESPACE = 'Rubicon';

/**
 * Installs `window.Rubicon` with `api`, a plain copy of the package's runtime exports, and adopts
 * the snippet; or refuses a second load. Called once, when the script build runs. Never throws.
 */
export function installScriptBuild(api: Readonly<Record<string, unknown>>): void {
  try {
    if (typeof window === 'undefined') return;
    if (Reflect.get(window, NAMESPACE) !== undefined) {
      refuseSecondLoad();
      return;
    }
    const namespace: Record<string, unknown> = {};
    for (const name of Object.keys(api)) namespace[name] = api[name];
    Reflect.set(window, NAMESPACE, namespace);
    adoptSnippet();
  } catch (error) {
    try {
      factoryLog(undefined).error('WORKER_FAILED', () => 'The script build could not be installed', { error });
    } catch {
      // The log itself failed: nothing more can be said without risking the page.
    }
  }
}

// A developer error under the default logging settings: the second load carries no configuration.
function refuseSecondLoad(): void {
  factoryLog(undefined).error(
    'SECOND_INSTANCE',
    () =>
      `The script build was loaded again on this page (SDK ${SDK_VERSION}); window.Rubicon is already defined, ` +
      'so this load does nothing and the first one stays in force',
    { developerError: true },
  );
}
