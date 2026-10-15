// Node, ESM (step 8.2): the installed tarball through the exports map's `import` condition. Outside a
// browser `createAnalytics` returns the no-op with one INFO line (Web Public API 7); the report goes
// to stdout as one JSON line for the test to read.
import * as sdk from 'rubicon-analytics';

const lines = [];
const analytics = sdk.createAnalytics({
  apiKey: 'rk_consumer',
  logging: { level: 'debug', logger: (level, message) => lines.push([level, message]) },
});
analytics.track('Consumer Loaded');
let internal = 'resolved';
try {
  await import('rubicon-analytics/dist/index.mjs');
} catch (error) {
  internal = error.code;
}
console.log(
  JSON.stringify({
    resolved: import.meta.resolve('rubicon-analytics'),
    exports: Object.keys(sdk).sort(),
    lines,
    isOptedOut: analytics.isOptedOut,
    deviceId: analytics.deviceId,
    internal,
  }),
);
