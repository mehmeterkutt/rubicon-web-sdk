import { captureOf, REPLAYED_VERBS } from 'rubicon-analytics-core';
import type { Analytics, AutomaticCapture, CaptureMoment, Log, ReplayedVerb } from 'rubicon-analytics-core';
import { campaignOf } from '../autocapture/page-views';
import type { LoadView } from '../autocapture/page-views';
import { createAnalytics, createAnalyticsFromSnippet, factoryLog } from '../create-analytics';

// The snippet's adapter (Web Public API 2 and its Changed on note, Web HTTP 6): the script build
// calls `adoptSnippet` when it loads. The snippet is two tags; the first, the stub
// (`src/snippet/stub.js`, ES5, frozen, its hash published), installs `window.rubicon` with:
//
// - `__SV`, the stub's format version, `1`: what tells the adapter that `window.rubicon` is a stub
//   it can read. The stub does nothing when `window.rubicon` already exists, so a snippet pasted
//   twice keeps the first stub and its queue.
// - `_q`, the queue: one entry per call, `[verb, arguments, record]`, the record being what Web
//   Context 4 and Web Session 5 ask the stub to record at the call, `{ t, o, p, w, h, v }`: the time
//   (`Date.now()`), `location.origin` and `location.pathname` (never the query or the fragment), the
//   viewport (`innerWidth`, `innerHeight`) and `document.visibilityState`.
// - one method per verb: `init(config)`, which carries the configuration, and the ten methods of
//   `Analytics`; the two reads `isOptedOut` and `deviceId` are not calls and exist only once the
//   library has loaded.
// - a first entry `pageViewed`, queued when the stub runs, whose argument holds only the five `utm_*`
//   pairs of the URL, as raw `name=value` text joined by `&` (Web Lifecycle 2, 5).
//
// The stub keeps the arguments of a queued call by reference: they are read and copied only at
// replay, so a page must not change an object it passed before the library loads (the user's answer
// of 2026-10-15, plan section 15, step 7.8; an ES5 stub cannot apply the conversion of Web
// Serialization 2, and a JSON copy would break it). An entry the adapter does not know, or cannot
// read, is skipped with a DEBUG line (the same answer).
//
// When the library loads, the first `init` makes the instance through the same factory, with the
// load's `Page Viewed` taken from the `pageViewed` record; every other call is replayed in order,
// with its recorded time, visibility, URL and viewport; message ids are made at replay (Web Context
// 4). Then `window.rubicon` is the instance: the stub object itself, its methods replaced by ones
// that call the instance, the two reads added, and its queue replaced by one that replays at once
// whatever a function taken from the stub earlier still pushes. Without an `init` yet, the stub keeps
// queueing until `init` is called. Nothing here throws into the page.

/** The stub's format version this adapter reads. */
export const STUB_FORMAT = 1;

/** The verb of the stub's own load record (Web Lifecycle 2). */
const PAGE_VIEWED_ENTRY = 'pageViewed';

/** What the stub records with each call; any field may be missing or of another type. */
interface StubRecord {
  readonly t?: unknown;
  readonly o?: unknown;
  readonly p?: unknown;
  readonly w?: unknown;
  readonly h?: unknown;
  readonly v?: unknown;
}

/** One entry of the stub's queue, read defensively. */
interface QueuedEntry {
  readonly verb: string;
  readonly args: readonly unknown[];
  readonly record: StubRecord;
}

/** The stub as the adapter reads it: an object whose `_q` is an array. */
type Stub = Record<string, unknown> & { _q: unknown[] };

/**
 * Takes over the snippet's stub, when `window.rubicon` is one: at once when an `init` is queued,
 * else at the first `init`. Called once, by the script build when it loads.
 */
export function adoptSnippet(): void {
  try {
    const stub = readStub();
    if (stub === undefined) return;
    const entries = stub._q.map(readEntry);
    if (entries.some((entry) => entry?.verb === 'init')) {
      load(stub, undefined);
      return;
    }
    // No `init` yet: the stub goes on queueing, and its `init` loads.
    stub['init'] = (...args: unknown[]): void => {
      load(stub, { config: args[0] });
    };
  } catch (error) {
    reportFailure(undefined, error);
  }
}

// `window.rubicon` when it is a stub of the format this adapter reads.
function readStub(): Stub | undefined {
  const value: unknown = Reflect.get(window, 'rubicon');
  if (typeof value !== 'object' || value === null) return undefined;
  if (Reflect.get(value, '__SV') !== STUB_FORMAT) return undefined;
  const queue: unknown = Reflect.get(value, '_q');
  return Array.isArray(queue) ? (value as Stub) : undefined;
}

// Creates the instance from the first `init` (queued, or the one called now), replays the queue and
// makes the stub the instance.
function load(stub: Stub, late: { readonly config: unknown } | undefined): void {
  let log: Log | undefined;
  try {
    const entries = stub._q.map(readEntry);
    stub._q = [];
    const initIndex = entries.findIndex((entry) => entry?.verb === 'init');
    const config = late === undefined ? entries[initIndex]?.args[0] : late.config;
    log = factoryLog(config);
    const viewIndex = entries.findIndex((entry) => entry?.verb === PAGE_VIEWED_ENTRY);
    const view = entries[viewIndex];
    const analytics = createAnalyticsFromSnippet(config, (capture) =>
      view === undefined ? undefined : loadViewOf(view, capture),
    );
    const replay = replayer(analytics, log);
    entries.forEach((entry, index) => {
      if (index === initIndex && late === undefined) return;
      if (index === viewIndex) return;
      replay(entry);
    });
    becomeInstance(stub, analytics, replay);
  } catch (error) {
    reportFailure(log, error);
  }
}

// How one queued entry is run: with its recorded moment through the instance's own replay, or as a
// plain call on an instance of another copy of the SDK, which this copy cannot reach (step 7.7 row).
function replayer(analytics: Analytics, log: Log): (entry: QueuedEntry | undefined) => void {
  const capture = captureOf(analytics);
  return (entry) => {
    try {
      if (entry === undefined) {
        log.debug(() => 'A queued call of the snippet could not be read; it was skipped');
        return;
      }
      const { verb, args } = entry;
      if (verb === 'init') {
        // A second `init`: the factory returns the first instance with `SECOND_INSTANCE`.
        createAnalytics(args[0] as Parameters<typeof createAnalytics>[0]);
        return;
      }
      if (!isReplayedVerb(verb)) {
        log.debug(() => 'The snippet queued a call the library does not know; it was skipped');
        return;
      }
      const moment = capture === undefined ? undefined : momentOf(entry.record, capture);
      if (capture !== undefined && moment !== undefined) capture.replay(verb, args, moment);
      else callOn(analytics, verb, args);
    } catch (error) {
      reportFailure(log, error);
    }
  };
}

// The stub becomes the instance: its methods call the instance, the two reads are added, `init`
// makes a second instance (`SECOND_INSTANCE`), and its queue replays at once what a function taken
// from the stub before still pushes (Web Public API 2: the stub is replaced by the instance).
function becomeInstance(stub: Stub, analytics: Analytics, replay: (entry: QueuedEntry | undefined) => void): void {
  for (const verb of REPLAYED_VERBS) {
    stub[verb] = (...args: unknown[]): void => {
      callOn(analytics, verb, args);
    };
  }
  stub['init'] = (config: unknown): void => {
    createAnalytics(config as Parameters<typeof createAnalytics>[0]);
  };
  Object.defineProperty(stub, 'isOptedOut', { configurable: true, enumerable: true, get: () => analytics.isOptedOut });
  Object.defineProperty(stub, 'deviceId', { configurable: true, enumerable: true, get: () => analytics.deviceId });
  stub._q = forwardingQueue(replay);
}

// A queue whose `push` replays each entry at once; typed as the array the stub knows.
function forwardingQueue(replay: (entry: QueuedEntry | undefined) => void): unknown[] {
  const queue = {
    push: (...entries: unknown[]): number => {
      entries.forEach((entry) => {
        replay(readEntry(entry));
      });
      return 0;
    },
  };
  return queue as unknown as unknown[];
}

// A method of the instance; the instance's own methods never throw, another copy's are guarded.
function callOn(analytics: Analytics, verb: ReplayedVerb, args: readonly unknown[]): void {
  const method: unknown = Reflect.get(analytics, verb);
  if (typeof method === 'function') Reflect.apply(method, analytics, args);
}

function isReplayedVerb(verb: string): verb is ReplayedVerb {
  return (REPLAYED_VERBS as readonly string[]).includes(verb);
}

// `[verb, arguments, record]`; anything else is unreadable.
function readEntry(value: unknown): QueuedEntry | undefined {
  if (!Array.isArray(value)) return undefined;
  const entry = value as readonly unknown[];
  const verb = entry[0];
  const args = entry[1];
  const record = entry[2];
  if (typeof verb !== 'string') return undefined;
  return {
    verb,
    args: Array.isArray(args) ? args : [],
    record: typeof record === 'object' && record !== null ? record : {},
  };
}

/**
 * The moment of a queued call (Web Context 4, Web Session 5): its recorded time and visibility, and
 * the context of its recorded URL and viewport with the rest read now (the referrer, the locale, the
 * time zone, the title when enabled). `page.query` is empty: the stub keeps no query. A value the
 * stub did not record, or recorded as another type, is read now instead.
 */
export function momentOf(record: StubRecord, capture: AutomaticCapture): CaptureMoment | undefined {
  const { t, o, p, w, h, v } = record;
  const page = typeof o === 'string' && typeof p === 'string' ? { origin: o, pathname: p, search: '' } : undefined;
  const viewport = isSize(w) && isSize(h) ? { width: w, height: h } : undefined;
  const now = capture.moment(page, viewport);
  if (now === undefined) return undefined;
  return {
    time: typeof t === 'number' && Number.isFinite(t) ? Math.floor(t) : now.time,
    visible: typeof v === 'string' ? v === 'visible' : now.visible,
    callTime: now.callTime,
  };
}

// The load's `Page Viewed` from the stub's record: its URL, moment and campaign (Web Lifecycle 2, 5).
function loadViewOf(entry: QueuedEntry, capture: AutomaticCapture): LoadView | undefined {
  const { o, p } = entry.record;
  if (typeof o !== 'string' || typeof p !== 'string') return undefined;
  const pairs = entry.args[0];
  return {
    location: { origin: o, pathname: p, search: '' },
    moment: momentOf(entry.record, capture),
    campaign: campaignOf(typeof pairs === 'string' ? `?${pairs}` : ''),
  };
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function reportFailure(log: Log | undefined, error: unknown): void {
  try {
    (log ?? factoryLog(undefined)).error('WORKER_FAILED', () => 'The snippet could not be taken over', { error });
  } catch {
    // The log itself failed: nothing more can be said without risking the page.
  }
}
