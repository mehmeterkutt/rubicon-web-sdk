/**
 * Replaced at build time with the version in `packages/web/package.json` (D5): by Rollup in the
 * published builds and by Vitest's `define` in tests.
 */
declare const __VERSION__: string;

/** Semantic version of this build of the SDK, sent as `context.library.version`. */
export const SDK_VERSION: string = __VERSION__;
