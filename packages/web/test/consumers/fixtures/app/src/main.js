// The app the Vite and webpack fixtures build from the installed tarball (step 8.2): it imports the
// three runtime exports by their public names, as an app's entry does, and creates the instance
// from the configuration the browser test puts on the page.
import { createAnalytics, createNoOpAnalytics, createTrackedFetch } from 'rubicon-analytics';

const config = window.__rubiconTest;
const analytics = config === undefined ? createNoOpAnalytics() : createAnalytics(config);
window.__analytics = analytics;
window.__trackedFetch = createTrackedFetch(analytics, { hosts: [location.hostname] });
analytics.track('Consumer Loaded', { bundler: document.documentElement.dataset.bundler });
