// The exports map closes every internal path (Web Public API 7): only the package itself resolves.
// @ts-expect-error -- `rubicon-analytics/dist/index.mjs` is not exported.
import * as internal from 'rubicon-analytics/dist/index.mjs';

export const reached: unknown = internal;
