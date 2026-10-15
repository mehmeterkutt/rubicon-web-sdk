// A CommonJS module of a `node16` project (step 8.2): the import compiles to `require` and resolves
// the exports map's `require` condition and its declarations.
import { createNoOpAnalytics } from 'rubicon-analytics';
import type { Analytics } from 'rubicon-analytics';

export const analytics: Analytics = createNoOpAnalytics();
analytics.track('Consumer Loaded', { module: 'commonjs' });
