import type {
  AutomaticCapture,
  CaptureMoment,
  Clock,
  LifecycleEvent,
  LifecycleSource,
  PageLocation,
  ScheduledTask,
  Scheduler,
  Unsubscribe,
} from 'rubicon-analytics-core';
import { queryValues } from '../platform/page-query';
import { historyRegistry } from './history-registry';
import type { HistoryMethod } from './history-registry';

// Automatic page views (Web Lifecycle 1, 2, 5, 8): `Page Viewed`, a track event with
// `source: "auto"`, for every navigation that shows a document or changes its path.
//
// - The load, once, when the page is first visible: its time, URL, viewport and visibility read when
//   `createAnalytics` is called, or with the snippet those its stub recorded when it ran (a
//   {@link LoadView}, step 7.8). It waits in a window of its own from that moment, as a navigation's
//   view does, so a router's redirect moves its URL, also one made before the instance started; its
//   time, visibility and campaign stay the load's (plan section 15, step 8.1, the user's answer). A
//   page loaded hidden waits for its first `visible` and takes that moment; a page never shown sends
//   none.
// - Single-page navigations through the history registry and `popstate`. Only a change of origin or
//   path counts. A `pushState` or `popstate` sends the pending view, with its own URL, and opens a new
//   one; a `replaceState` while one is pending moves it to the new URL, which collapses a router's
//   redirect into one view; one outside the window opens its own. The view is made when its window
//   of {@link PAGE_VIEW_WINDOW_MS} closes, with the context of that moment and its own URL; hiding
//   and `pagehide` send it at once.
// - A restore from the back/forward cache is a page view; a tab becoming visible is not.
// - Its properties are the five `utm_*` of its own URL, empty ones left out (Web Lifecycle 5).
//
// Nothing is wrapped or listened to unless `page_views` is in the configuration the page runs with
// (Web Lifecycle 8). Nothing here throws into the page: every listener and timer catches and logs.

/** The event's name (Web Lifecycle 1). */
export const PAGE_VIEWED = 'Page Viewed';

/**
 * How long a pending view waits for a `replaceState` of the same history entry (Web Lifecycle 2).
 * Internal and provisional: verified against router redirects in the demo and the framework fixtures
 * (step 8.1).
 */
export const PAGE_VIEW_WINDOW_MS = 500;

/** The campaign parameters a view takes from its URL; the list is closed (Web Lifecycle 5). */
export const UTM_PARAMETERS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
];

/** What the page views need of the browser `Platform`. */
export interface PageViewsPlatform {
  readonly lifecycle: LifecycleSource;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
}

/**
 * The load's values: read when `createAnalytics` is called, or recorded by the snippet's stub when it
 * ran (Web Lifecycle 2, 5). The snippet's `location` has no query (Web Context 4: never the raw query)
 * and its `campaign` holds the five `utm_*` the stub kept.
 */
export interface LoadView {
  readonly location: PageLocation | undefined;
  readonly moment: CaptureMoment | undefined;
  readonly campaign: Readonly<Record<string, string>>;
}

/** The view of a history entry that waits for its window to close. */
interface PendingView {
  location: PageLocation;
  readonly openedAt: number;
  readonly timer: ScheduledTask;
  /** The load's view: its moment and campaign, which a redirect does not move. */
  readonly load?: { readonly moment: CaptureMoment; readonly campaign: Readonly<Record<string, string>> };
}

/**
 * Attaches page views to a new instance (`CoreOptions.onCreated`): when `page_views` is in the code's
 * configuration the load's values are taken now, inside `createAnalytics` (from the snippet's record
 * through `recorded`, else read), and the capture starts with the instance, if the saved remote
 * values leave `page_views` on.
 */
export function attachPageViews(
  capture: AutomaticCapture,
  platform: PageViewsPlatform,
  recorded?: (capture: AutomaticCapture) => LoadView | undefined,
): void {
  if (!capture.configures('page_views')) return;
  // The snippet's record when it has one, else the values of now (Web Lifecycle 2).
  const load = recorded?.(capture) ?? readLoad(capture);
  capture.onStart('page_views', () => new PageViews(capture, platform).start(load));
}

// The load's values now, inside `createAnalytics` (npm, or the script build without the snippet).
function readLoad(capture: AutomaticCapture): LoadView {
  const location = readLocation();
  return { location, moment: capture.moment(location), campaign: campaignOf(location?.search ?? '') };
}

/** The page views of one instance, from its start to its shutdown. */
class PageViews {
  // The origin and path of the history entry last seen.
  private seen: string | undefined;
  private pending: PendingView | undefined;
  // The page has been visible since it loaded; until then nothing is sent.
  private shown = false;

  constructor(
    private readonly capture: AutomaticCapture,
    private readonly platform: PageViewsPlatform,
  ) {}

  start(load: LoadView): Unsubscribe {
    const onHistory = (method: HistoryMethod): void => {
      this.guarded(() => {
        this.navigated(method === 'pushState' ? 'push' : 'replace');
      });
    };
    const onPopState = (): void => {
      this.guarded(() => {
        this.navigated('push');
      });
    };
    // First, before the core's own subscriptions: a hiding sends the pending view into the drain.
    const unsubscribe = this.platform.lifecycle.subscribe((event) => {
      this.guarded(() => {
        this.onLifecycle(event);
      });
    });
    window.addEventListener('popstate', onPopState);
    const registry = historyRegistry();
    if (registry !== undefined) registry.current = onHistory;
    this.seen = keyOf(readLocation());
    this.sendLoad(load);
    return () => {
      if (registry !== undefined && registry.current === onHistory) registry.current = undefined;
      window.removeEventListener('popstate', onPopState);
      unsubscribe();
      this.pending?.timer.cancel();
      this.pending = undefined;
    };
  }

  // The load's view: of its record when the page was visible then, waiting in its window from the
  // load's moment, else of the first visible moment. A path changed before the instance started is a
  // redirect the window takes: the history was not wrapped yet, and only a router redirects that soon.
  private sendLoad(load: LoadView): void {
    if (load.moment?.visible === true && load.location !== undefined) {
      this.shown = true;
      const now = readLocation();
      const location = now !== undefined && keyOf(now) !== keyOf(load.location) ? now : load.location;
      this.open(location, load.moment.time, { moment: load.moment, campaign: load.campaign });
      this.closeElapsed();
    } else if (this.platform.lifecycle.isVisible()) {
      this.firstShown();
    }
  }

  // A page loaded hidden (a background tab, a prerender) sends its load's view now.
  private firstShown(): void {
    this.shown = true;
    const location = readLocation();
    this.seen = keyOf(location);
    if (location !== undefined) this.send(location, undefined);
  }

  private onLifecycle(event: LifecycleEvent): void {
    switch (event) {
      case 'hidden':
      case 'pagehide':
        this.sendPending();
        return;
      case 'visible':
        if (!this.shown) this.firstShown();
        else this.closeElapsed();
        return;
      case 'pageshow-persisted': {
        // A back navigation the cache served: without the cache the page would load again.
        this.sendPending();
        this.firstShown();
        return;
      }
    }
  }

  // A history change: only a new origin or path is a navigation (Web Lifecycle 2).
  private navigated(kind: 'push' | 'replace'): void {
    const location = readLocation();
    const key = keyOf(location);
    if (location === undefined || key === undefined || key === this.seen) return;
    this.seen = key;
    // A page never shown sends none; its load's view takes the URL of its first visible moment.
    if (!this.shown) return;
    this.closeElapsed();
    if (kind === 'replace' && this.pending !== undefined) {
      // The same history entry: the pending view moves to the new URL.
      this.pending.location = location;
      return;
    }
    this.sendPending();
    this.open(location);
  }

  private open(location: PageLocation, openedAt = this.platform.clock.now(), load?: PendingView['load']): void {
    const wait = Math.max(0, openedAt + PAGE_VIEW_WINDOW_MS - this.platform.clock.now());
    const timer = this.platform.scheduler.after(wait, () => {
      this.guarded(() => {
        this.sendPending();
      });
    });
    this.pending = { location, openedAt, timer, load };
  }

  // Timers are hints (Web Retry 3): a window that has closed by the clock is closed, fired or not.
  private closeElapsed(): void {
    const pending = this.pending;
    if (pending !== undefined && this.platform.clock.now() - pending.openedAt >= PAGE_VIEW_WINDOW_MS) {
      this.sendPending();
    }
  }

  private sendPending(): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    pending.timer.cancel();
    const load = pending.load;
    if (load === undefined) {
      this.send(pending.location, undefined);
      return;
    }
    // The load's time, visibility and campaign; the page it shows now: `page.url`, `page.query` and
    // `page.title` of the URL a redirect moved it to.
    const page = this.capture.moment(pending.location);
    const moment: CaptureMoment = {
      ...load.moment,
      callTime: {
        ...load.moment.callTime,
        pageUrl: page?.callTime.pageUrl,
        pageQuery: page?.callTime.pageQuery,
        pageTitle: page?.callTime.pageTitle ?? load.moment.callTime.pageTitle,
      },
    };
    this.send(pending.location, moment, load.campaign);
  }

  // A view always carries its own URL (path, query and campaign); the rest is of its moment.
  private send(
    location: PageLocation,
    moment: CaptureMoment | undefined,
    campaign: Readonly<Record<string, string>> = campaignOf(location.search),
  ): void {
    const at = moment ?? this.capture.moment(location);
    if (at === undefined) return;
    this.capture.track('page_views', PAGE_VIEWED, campaign, at);
  }

  private guarded(action: () => void): void {
    try {
      action();
    } catch (error) {
      try {
        this.capture.log.error('WORKER_FAILED', () => 'A page view could not be captured; it was ignored', { error });
      } catch {
        // The log itself failed: nothing more can be said without risking the page.
      }
    }
  }
}

/** The five `utm_*` of `search` that have a value (Web Lifecycle 5). */
export function campaignOf(search: string): Record<string, string> {
  const values = queryValues(search, UTM_PARAMETERS) ?? {};
  const campaign: Record<string, string> = {};
  for (const name of UTM_PARAMETERS) {
    const value = values[name];
    if (value !== undefined && value !== '') campaign[name] = value;
  }
  return campaign;
}

// The page's URL now, copied; `undefined` when `location` cannot be read.
function readLocation(): PageLocation | undefined {
  try {
    return { origin: location.origin, pathname: location.pathname, search: location.search };
  } catch {
    return undefined;
  }
}

// What a navigation changes: the origin and the path, never the query or the fragment.
function keyOf(location: PageLocation | undefined): string | undefined {
  return location === undefined ? undefined : `${location.origin} ${location.pathname}`;
}
