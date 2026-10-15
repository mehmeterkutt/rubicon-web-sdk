// Node, CommonJS (step 8.2): the installed tarball through the exports map's `require` condition. The
// report goes to stdout as one JSON line for the test to read.
const sdk = require('rubicon-analytics');

const lines = [];
const analytics = sdk.createAnalytics({
  apiKey: 'rk_consumer',
  logging: { level: 'debug', logger: (level, message) => lines.push([level, message]) },
});
analytics.track('Consumer Loaded');
let internal = 'resolved';
try {
  require('rubicon-analytics/dist/index.cjs');
} catch (error) {
  internal = error.code;
}
console.log(
  JSON.stringify({
    resolved: require.resolve('rubicon-analytics'),
    exports: Object.keys(sdk).sort(),
    lines,
    isOptedOut: analytics.isOptedOut,
    deviceId: analytics.deviceId,
    internal,
  }),
);
