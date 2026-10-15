import { jsonObjectFromEntries, mergeJsonObject } from '../json';
import type { JsonObject, JsonValue } from '../json';
import { ISSUE_CODES } from '../log';
import type { DailyLogLimit, DropReason, IssueCode, IssueCounter, Log } from '../log';
import type { Clock, KeyValueStorage } from '../platform';
import { MAX_COUNT } from './store-fields';
import type { StrictFields } from './store-fields';
import { StoreRecord } from './store-record';
import type { StoreAccess, StoreChange, StoreCodec, StoreRead, WriteResult } from './store-record';

/**
 * What belongs to the device and survives `reset()` (Identity 5), in `rubicon.<keyHash>.device`
 * (Web Identity 4, Web Disk 2). The consent decision has its own records (Web Disk 3, Web Privacy
 * 2), server pauses theirs (Web Retry 1), and the web keeps no app version (Web Lifecycle 4).
 * `device-store.test.ts` pins the exact keys.
 */
export interface DeviceState {
  /** The mirror of the identity cookie's id (Web Identity 1); `undefined` while there is none. */
  readonly deviceId: string | undefined;
  readonly retry: RetryState;
  readonly diagnostics: DiagnosticsState;
  /** The time of the last line of each `per_24h` code on this device, epoch ms (Web Logging 2). */
  readonly lastLogged: ReadonlyMap<string, number>;
}

/**
 * The transient retry state shared by every page of the origin (Web Retry 1); server pauses are in
 * `.pause`. Times are wall-clock epoch milliseconds (Web Retry 3).
 */
export interface RetryState {
  /** Before this time no upload starts (group B). */
  readonly pausedUntil: number | undefined;
  /** The position in the backoff table (Retry 2). */
  readonly step: number;
  /** The kind of the last failure, such as `io`. */
  readonly lastFailure: string | undefined;
  /** Raised by every failure write, so a success resets only what it saw (Web Retry 1). */
  readonly rev: number;
  /** When a page started the attempt that ends a wait (Web Retry 1). */
  readonly probeAt: number | undefined;
  /** The poison-batch counters by chunk, `<pageId>.<seq>` (Web Retry 1). */
  readonly suspects: ReadonlyMap<string, SuspectState>;
}

/** The poison-batch counters of one chunk (Web Retry 1, point 6). */
export interface SuspectState {
  readonly f: number;
  readonly alone: number;
  readonly clearedBy: number;
}

/** The counters of `SDK Diagnostics` (Logging 5, Web Logging 5). */
export interface DiagnosticsState {
  /** When counting began, epoch ms; `undefined` while nothing was counted. */
  readonly periodStart: number | undefined;
  /** When the last `SDK Diagnostics` checkpoint was written, epoch ms. */
  readonly lastSentAt: number | undefined;
  /** Drop counts by reason, such as `queue_full`. */
  readonly dropped: ReadonlyMap<string, number>;
  /** Counts by issue code, such as `QUEUE_FULL`. */
  readonly issues: ReadonlyMap<string, number>;
}

export const NO_RETRY: RetryState = {
  pausedUntil: undefined,
  step: 0,
  lastFailure: undefined,
  rev: 0,
  probeAt: undefined,
  suspects: /*#__PURE__*/ new Map(),
};

export const NO_DIAGNOSTICS: DiagnosticsState = {
  periodStart: undefined,
  lastSentAt: undefined,
  dropped: /*#__PURE__*/ new Map(),
  issues: /*#__PURE__*/ new Map(),
};

const INITIAL: DeviceState = {
  deviceId: undefined,
  retry: NO_RETRY,
  diagnostics: NO_DIAGNOSTICS,
  lastLogged: /*#__PURE__*/ new Map(),
};

/** The 24 hours of the `per_24h` frequency (Web Logging 2). */
export const DAILY_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

// Field names of the record. `last_logged` and its shape were named by the user, not the pages
// (plan section 15, step 4.1).
const DEVICE_ID = 'device_id';
const RETRY = 'retry';
const PAUSED_UNTIL = 'paused_until';
const STEP = 'step';
const LAST_FAILURE = 'last_failure';
const REV = 'rev';
const PROBE_AT = 'probe_at';
const SUSPECTS = 'suspects';
const F = 'f';
const ALONE = 'alone';
const CLEARED_BY = 'cleared_by';
const DIAGNOSTICS = 'diagnostics';
const PERIOD_START = 'period_start';
const LAST_SENT_AT = 'last_sent_at';
const DROPPED = 'dropped';
const ISSUES = 'issues';
const LAST_LOGGED = 'last_logged';

/** The record's fields, in the order they are written. */
export const DEVICE_FIELDS = [DEVICE_ID, RETRY, DIAGNOSTICS, LAST_LOGGED] as const;
export const RETRY_FIELDS = [PAUSED_UNTIL, STEP, LAST_FAILURE, REV, PROBE_AT, SUSPECTS] as const;
export const SUSPECT_FIELDS = [F, ALONE, CLEARED_BY] as const;
export const DIAGNOSTICS_FIELDS = [PERIOD_START, LAST_SENT_AT, DROPPED, ISSUES] as const;

function deviceCodec(): StoreCodec<DeviceState> {
  return {
    name: 'device',
    initial: INITIAL,
    decode(fields) {
      const retry = fields.optionalFields(RETRY);
      const diagnostics = fields.optionalFields(DIAGNOSTICS);
      return {
        // A blank id is invalid, as on Android; whether it is a UUID is the identity's check (6.1).
        deviceId: fields.optionalNonBlankString(DEVICE_ID),
        retry: retry === undefined ? NO_RETRY : decodeRetry(retry),
        diagnostics:
          diagnostics === undefined
            ? NO_DIAGNOSTICS
            : {
                periodStart: diagnostics.optionalInteger(PERIOD_START),
                lastSentAt: diagnostics.optionalInteger(LAST_SENT_AT),
                dropped: diagnostics.counts(DROPPED),
                issues: diagnostics.counts(ISSUES),
              },
        lastLogged: fields.counts(LAST_LOGGED),
      };
    },
    encode(state, stored) {
      const storedSuspects = stored?.fields.fields(RETRY)?.fields(SUSPECTS);
      const retry = state.retry;
      return {
        [DEVICE_ID]: state.deviceId,
        [RETRY]: mergeJsonObject(stored?.fields.object(RETRY) ?? {}, {
          [PAUSED_UNTIL]: retry.pausedUntil,
          [STEP]: retry.step,
          [LAST_FAILURE]: retry.lastFailure,
          [REV]: retry.rev,
          [PROBE_AT]: retry.probeAt,
          [SUSPECTS]: jsonObjectFromEntries(
            mapEntries(retry.suspects, (id, suspect) =>
              mergeJsonObject(storedSuspects?.object(id) ?? {}, {
                [F]: suspect.f,
                [ALONE]: suspect.alone,
                [CLEARED_BY]: suspect.clearedBy,
              }),
            ),
          ),
        }),
        [DIAGNOSTICS]: mergeJsonObject(stored?.fields.object(DIAGNOSTICS) ?? {}, {
          [PERIOD_START]: state.diagnostics.periodStart,
          [LAST_SENT_AT]: state.diagnostics.lastSentAt,
          [DROPPED]: countsObject(state.diagnostics.dropped),
          [ISSUES]: countsObject(state.diagnostics.issues),
        }),
        [LAST_LOGGED]: countsObject(state.lastLogged),
      };
    },
  };
}

function decodeRetry(retry: StrictFields): RetryState {
  return {
    pausedUntil: retry.optionalInteger(PAUSED_UNTIL),
    step: retry.optionalInteger(STEP) ?? 0,
    lastFailure: retry.optionalString(LAST_FAILURE),
    rev: retry.optionalInteger(REV) ?? 0,
    probeAt: retry.optionalInteger(PROBE_AT),
    suspects: retry.records(SUSPECTS, (suspect) => ({
      f: suspect.optionalInteger(F) ?? 0,
      alone: suspect.optionalInteger(ALONE) ?? 0,
      clearedBy: suspect.optionalInteger(CLEARED_BY) ?? 0,
    })),
  };
}

function mapEntries<V>(map: ReadonlyMap<string, V>, value: (key: string, item: V) => JsonValue): [string, JsonValue][] {
  const entries: [string, JsonValue][] = [];
  map.forEach((item, key) => entries.push([key, value(key, item)]));
  return entries;
}

function countsObject(counts: ReadonlyMap<string, number>): JsonObject {
  return jsonObjectFromEntries(mapEntries(counts, (_key, n) => n));
}

/** `counts` plus `delta`, saturating at {@link MAX_COUNT} (Android log 4.1). */
function addCounts(counts: ReadonlyMap<string, number>, delta: ReadonlyMap<string, number>): Map<string, number> {
  const sum = new Map(counts);
  delta.forEach((n, key) => sum.set(key, Math.min(MAX_COUNT, (sum.get(key) ?? 0) + n)));
  return sum;
}

/** `counts` less `reported`, keeping only what is left above zero (Web Logging 5: subtraction). */
function subtractCounts(
  counts: ReadonlyMap<string, number>,
  reported: ReadonlyMap<string, number>,
): Map<string, number> {
  const left = new Map<string, number>();
  counts.forEach((n, key) => {
    const rest = n - (reported.get(key) ?? 0);
    if (rest > 0) left.set(key, rest);
  });
  return left;
}

/** This page's counts not yet written: one pending change that later counts join while it waits. */
interface CountDelta {
  readonly dropped: Map<string, number>;
  readonly issues: Map<string, number>;
  /** When this page first counted, the period's start if none is stored (Android `addTo`). */
  readonly firstAt: number;
  readonly change: StoreChange<DeviceState>;
}

/**
 * `rubicon.<keyHash>.device` (Web Identity 4, Web Disk 3): the `device_id` mirror, the transient
 * retry state (Web Retry 1), the `SDK Diagnostics` counters (Web Logging 5) and the times of the
 * `per_24h` lines (Web Logging 2). The port of the Android `DeviceStore`, with storage as the
 * source of truth: every read is fresh, every write a merge of this page's changes, and counters
 * are increments added to what is stored, so two pages counting at once both count.
 *
 * A missing record has no id: the identity cookie is the authority and the identity code (step 6.1)
 * generates and mirrors it, so this store never makes one.
 */
export class DeviceStore {
  /** Counts every WARN and ERROR by code; the instance's `Log` counts through it (Logging 5). */
  readonly issueCounter: IssueCounter;
  /** The device-wide half of `per_24h`; the instance's `Log` asks it (Web Logging 2). */
  readonly dailyLogLimit: DailyLogLimit;

  private readonly record: StoreRecord<DeviceState>;
  private delta: CountDelta | undefined;

  constructor(
    keyHash: string,
    storage: KeyValueStorage,
    private readonly access: StoreAccess,
    log: Log,
    private readonly clock: Clock,
  ) {
    this.record = new StoreRecord(keyHash, storage, access, log, deviceCodec());
    this.issueCounter = {
      increment: (code) => {
        this.count('issues', code, 1);
      },
    };
    this.dailyLogLimit = { claim: (code) => this.claim(code) };
  }

  get key(): string {
    return this.record.key;
  }

  /** A fresh read, for the identity matrix (Web Identity 1). */
  read(): StoreRead<DeviceState> {
    return this.record.read();
  }

  /** The fresh record with this page's pending changes. */
  get state(): DeviceState {
    return this.record.state;
  }

  /** Queues a change for the next {@link persist}. */
  update(change: StoreChange<DeviceState>): void {
    this.record.update(change);
  }

  /** Writes the pending changes in one fresh read, merge and `setItem`. */
  persist(): WriteResult {
    return this.record.persist();
  }

  /** Writes the pending changes and `change` now; see {@link StoreRecord.write}. */
  write(change: StoreChange<DeviceState>): WriteResult {
    return this.record.write(change);
  }

  /**
   * Drops the counts this page made that are not yet written: while consent is refused they live in
   * memory and are never stored (Web Logging 5 point 5), so an `optIn()` starts without them. Other
   * waiting changes, such as the retry state, stay.
   */
  discardCounts(): void {
    const delta = this.delta;
    this.delta = undefined;
    if (delta !== undefined) this.record.discard(delta.change);
  }

  /** Deletes the record also without full access and drops every change of this page; see {@link StoreRecord.erase}. */
  erase(): boolean {
    this.delta = undefined;
    return this.record.erase();
  }

  /** Drops every change of this page not yet written: `clearLocalData()` in the memory-only mode. */
  discardPending(): void {
    this.delta = undefined;
    this.record.discardPending();
  }

  /** Counts `count` events dropped for `reason` (Queue 5, Logging 5). */
  countDropped(reason: DropReason, count = 1): void {
    if (count > 0) this.count('dropped', reason, count);
  }

  /**
   * The checkpoint of `SDK Diagnostics` (Web Logging 5): written now, after the event's chunk, as a
   * fresh read with `reported` subtracted from the counters and `at` as the time of the last report
   * and the start of the next period, in one `setItem`. A failed write changes nothing, so the next
   * flush reports again.
   */
  checkpointDiagnostics(reported: DiagnosticsState, at: number): WriteResult {
    return this.record.write((state) => ({
      ...state,
      diagnostics: {
        periodStart: at,
        lastSentAt: at,
        dropped: subtractCounts(state.diagnostics.dropped, reported.dropped),
        issues: subtractCounts(state.diagnostics.issues, reported.issues),
      },
    }));
  }

  private count(kind: 'dropped' | 'issues', key: string, n: number): void {
    let delta = this.delta;
    if (delta === undefined || !this.record.isPending(delta.change)) {
      const dropped = new Map<string, number>();
      const issues = new Map<string, number>();
      const firstAt = this.clock.now();
      const change: StoreChange<DeviceState> = (state) => ({
        ...state,
        diagnostics: {
          ...state.diagnostics,
          periodStart: state.diagnostics.periodStart ?? firstAt,
          dropped: addCounts(state.diagnostics.dropped, dropped),
          issues: addCounts(state.diagnostics.issues, issues),
        },
      });
      delta = { dropped, issues, firstAt, change };
      this.delta = delta;
      this.record.update(change);
    }
    const counts = delta[kind];
    counts.set(key, Math.min(MAX_COUNT, (counts.get(key) ?? 0) + n));
  }

  /**
   * One line per device per sliding 24 hours, best-effort (Web Logging 2): `true`, with now written
   * as the code's time, when its last line on this device is 24 hours old or more, or unknown. Per
   * page, always `true`, while consent is pending or refused, in the memory-only mode and while the
   * record is unreadable. A stored time later than now means the clock was set back and does not
   * hold the line back. The write is quiet: a failure leaves only this page's per-page limit.
   */
  private claim(code: IssueCode): boolean {
    if (this.access.level !== 'full' || ISSUE_CODES[code].frequency !== 'per_24h') return true;
    const read = this.record.read();
    if (read.status === 'unreadable') return true;
    const now = this.clock.now();
    const last = read.status === 'present' ? read.state.lastLogged.get(code) : undefined;
    if (last !== undefined && last <= now && now - last < DAILY_LOG_WINDOW_MS) return false;
    this.record.write(
      (state) => {
        const lastLogged = new Map(state.lastLogged);
        lastLogged.set(code, now);
        return { ...state, lastLogged };
      },
      { quiet: true },
    );
    return true;
  }
}
