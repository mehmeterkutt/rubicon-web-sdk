import type { Autocapture } from './config/types';
import type { Log } from './log/log';

/**
 * How `web` sends the events it captures itself, the port of the Android `AutomaticCapture`
 * (Lifecycle 1, 5): `Page Viewed` (step 7.6) and `Network Request` (step 7.7), both track events with
 * `source: "auto"`. Session events and `SDK Diagnostics` are the core's own and do not pass here.
 * Nothing here throws.
 */
export interface AutomaticCapture {
  /**
   * An automatic track event, created only while collecting, allowed by consent and while `gate` is
   * in the configuration the page runs with: the code's restricted by the saved remote values, so a
   * remote switch-off applies from the next page load, and `network_requests` also at once through
   * the runtime flag (Web Lifecycle 8). Dropped silently otherwise, as Android's writer drops an
   * event whose type is not effective. A bad name is a WARN, never a developer error: the SDK made
   * it, not the developer.
   */
  track(gate: Autocapture, name: string, properties: Readonly<Record<string, unknown>>): void;

  /**
   * Whether a network request is captured now: `network_requests` in the configuration the page runs
   * with, not switched off remotely (at once, Web Lifecycle 8), collecting and allowed by consent.
   * Read on every request; cheap.
   */
  readonly capturesNetworkRequests: boolean;

  /** The host name the SDK sends to, never captured (Web Lifecycle 6). */
  readonly sdkHost: string;

  /** The instance's log, for the lines of the browser's own capture code. */
  readonly log: Log;
}
