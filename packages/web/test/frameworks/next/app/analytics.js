'use client';
// The SDK created once on the client, as a Next.js app does in a client module of its root layout
// (step 8.1); during the static export's prerender there is no window and nothing is created.
import { createAnalytics } from 'rubicon-analytics';

if (typeof window !== 'undefined' && window.__rubiconTest !== undefined && window.__analytics === undefined) {
  window.__analytics = createAnalytics(window.__rubiconTest);
}

export default function Analytics() {
  return null;
}
