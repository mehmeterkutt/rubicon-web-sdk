import type { Autocapture } from './config/types';
import type { Log } from './log/log';
import type { CallTimeContextValues, PageLocation } from './platform/context-provider';
import type { Unsubscribe } from './platform/lifecycle-source';

/**
 * The moment an automatic event belongs to when it is made later than that moment: its time `t`,
 * the page's visibility then and the call-time context read then (Web Context 4, Web Session 5). The
 * load's `Page Viewed` is read when `createAnalytics` is called and sent when the instance starts
 * (Web Lifecycle 2); the snippet's queued record (step 7.8) gives one too.
 */
export interface CaptureMoment {
  readonly time: number;
  readonly visible: boolean;
  readonly callTime: CallTimeContextValues;
}

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
   * it, not the developer. With `moment`, the event has that moment's time, visibility and context
   * instead of the call's.
   */
  track(gate: Autocapture, name: string, properties: Readonly<Record<string, unknown>>, moment?: CaptureMoment): void;

  /**
   * The moment of now for an event made later (see {@link CaptureMoment}), with `page.url` and
   * `page.query` of `page` when given. Reads only the clock, the visibility and the call-time
   * context; never starts the instance, so it may be called while `createAnalytics` runs.
   * `undefined` when reading failed (logged as `WORKER_FAILED`).
   */
  moment(page?: PageLocation): CaptureMoment | undefined;

  /**
   * Whether `gate` is in the code's configuration, known without starting the instance; the saved
   * remote values may still switch it off for this page load (Web Lifecycle 8).
   */
  configures(gate: Autocapture): boolean;

  /**
   * Calls `start` once when the instance starts, only when `gate` is in the configuration the page
   * runs with (Web Lifecycle 8: `page_views` off wraps nothing at that load), right after that
   * configuration is known and before the core listens to the page's lifecycle, so what `start`
   * subscribes hears a hiding before the writer's drain (Web Queue 1) and its events reach it. What it
   * returns is called when the instance is shut down. A throw costs this capture only.
   */
  onStart(gate: Autocapture, start: () => Unsubscribe | undefined): void;

  /**
   * Whether a network request is captured now: `network_requests` in the configuration the page runs
   * with, not switched off remotely (at once, Web Lifecycle 8), collecting and allowed by consent.
   * Read on every request; cheap.
   */
  readonly capturesNetworkRequests: boolean;

  /**
   * The platform clock's time now, for the duration of a captured request (`duration_ms`, step 7.7);
   * the clock is `Date.now()`, so a duration may come out negative when the clock is set back, which
   * the caller clamps.
   */
  now(): number;

  /** The host name the SDK sends to, never captured (Web Lifecycle 6). */
  readonly sdkHost: string;

  /** The instance's log, for the lines of the browser's own capture code. */
  readonly log: Log;
}
