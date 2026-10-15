import type { ConfigSnapshot } from '../config';
import type { HttpResult } from '../http';
import type { Log } from '../log';
import type { Clock, RandomSource } from '../platform';
import { MAX_COUNT } from '../storage';
import type { DeviceStore, PauseKind, PauseRecord, PauseStore, RetryState, SuspectState } from '../storage';
import { keyHash } from '../util';
import { retryGroupOf } from './retry-group';

/** Waits of group B, by consecutive failure (Retry 2). Internal (Configuration 2). */
export const BACKOFF_MS: readonly number[] = [2_000, 10_000, 30_000, 120_000, 300_000, 600_000];

/** The wait of group E, the cap of `Retry-After` and of group C (Retry 2, 3). */
export const MAX_WAIT_MS = 3_600_000;

/** `Retry-After` of zero or less counts as one second (Retry 3). */
export const MIN_RETRY_AFTER_MS = 1_000;

/** Counted failures after which a chunk is a suspect and left out of the next attempt (Web Retry 1.6). */
export const SUSPECT_AFTER = 5;

/** Counted failures, with lone failures and a clearing, before a chunk is deleted (Web Retry 1.6). */
export const EXHAUSTED_AFTER = 10;

/** Counted failures alone before a cleared suspect is deleted (Web Retry 1.6). */
export const ALONE_BEFORE_DELETE = 5;

/** How long another page's probe is waited for when a wait ends (Web Retry 1.5). */
export const PROBE_WINDOW_MS = 30_000;

/** What a wait is: group B in `.device`, or a server pause of group C or E. */
export type WaitKind = 'transient' | PauseKind;

/**
 * The longest wait of each kind, its largest jitter included (Web Retry 3): 10 minutes × 1.5 for
 * group B, one hour × 1.1 for group C, one hour × 1.2 for group E. A deadline further ahead means the
 * clock was set back.
 */
export const LONGEST_WAIT_MS: Readonly<Record<WaitKind, number>> = {
  transient: 900_000,
  throttle: 3_960_000,
  config: 4_320_000,
};

/** The failures a returning network may cut short (Retry 2, Web Retry 2). */
const NETWORK_FAILURES: readonly string[] = ['timeout', 'connect', 'io'];

/** One upload attempt the gate allowed, handed back with its result. */
export interface RetryAttempt {
  /** `retry.rev` as read before the request: a success resets only what it saw (Web Retry 1.4). */
  readonly rev: number;
  /** Whether this attempt is the probe that ends a wait (Web Retry 1.5). */
  readonly probe: boolean;
}

/** Why no request may start now. */
export type WaitReason = WaitKind | 'local' | 'probe';

/** What {@link RetryPolicy.gate} allows. */
export type UploadGate =
  | { readonly kind: 'go'; readonly attempt: RetryAttempt }
  /** No request before `until`, epoch ms; the timer to it is a hint (Web Retry 3). */
  | { readonly kind: 'wait'; readonly until: number; readonly reason: WaitReason }
  /** Mixed content: this page never uploads (Web Retry 4a, Web HTTP 3). */
  | { readonly kind: 'blocked' };

/** What the uploader does with the batch it just attempted. */
export type RetryDecision =
  /** Accepted: delete its chunks. */
  | 'delete-sent'
  /** Group D: delete its chunks, counting their events as `rejected`. */
  | 'delete-rejected'
  /** A poison chunk: delete it, counting its events as `retry_exhausted`. */
  | 'delete-exhausted'
  /** Keep its chunks for a later attempt. */
  | 'keep';

/** What a {@link RetryPolicy} is made of. */
export interface RetryPolicyOptions {
  readonly device: DeviceStore;
  readonly pause: PauseStore;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly log: Log;
  /** The normalized `host` names the pause scope; `hostSecurity` `blocked` stops this page. */
  readonly config: Pick<ConfigSnapshot, 'host' | 'hostSecurity'>;
}

/** Options of {@link RetryPolicy.onResult}. */
export interface ResultOptions {
  /** The request was started on the `pagehide` path, where a `TypeError` may be the page's own teardown. */
  readonly closing?: boolean;
}

interface LocalWait {
  readonly until: number;
  readonly kind: WaitKind;
}

/**
 * Decides what becomes of a batch after each attempt and whether the next attempt may start (Retry
 * 1 to 5, Web Retry 1 to 4): the port of the Android `RetryPolicy`, with the state shared by every
 * page of the origin instead of kept per process.
 *
 * - Before every attempt, the hiding path included, {@link gate} reads `.pause` and `.device` fresh;
 *   a wait in force means no request, the chunks stay (Web Retry 1.1).
 * - Group B advances `step` from the stored value, raises `rev` and keeps the later of the stored and
 *   the new end (Web Retry 1.2), with the table of Retry 2 and jitter × 0.5 to 1.5.
 * - Group C and the server's group E go to `.pause` with `keyHash(host)`: the later end wins, read
 *   back and written once more when the stored end is earlier; nothing else writes or shortens it
 *   (Web Retry 1.3). `Retry-After` is capped at one hour, at least one second, jittered × 1.0 to 1.1
 *   and never shortened; without it group C uses the table. Group E waits an hour × 0.8 to 1.2.
 * - A success resets `step` and the transient wait only when `rev` still is what was read before the
 *   request (Web Retry 1.4).
 * - When a wait ends one page probes through `probe_at`; another page's probe of the last 30 s is
 *   waited for (Web Retry 1.5).
 * - The poison rule per chunk, `f`, `alone`, `cleared_by` (Web Retry 1.6), counting only server
 *   answers: 408, 5xx and non-standard codes (Web Retry 4b).
 * - `unexpected` pauses this page only, in memory; mixed content stops this page only; an unknown
 *   outcome writes nothing (Web Retry 4a, 4c).
 * - `Date.now()` from the `Clock` only, with the clock guard on every read (Web Retry 3).
 *
 * The uploader (step 6.4) owns the loop, the timers, the network check and the drop counts; this
 * class owns the rules. Nothing here throws: the stores catch their storage errors.
 */
export class RetryPolicy {
  private readonly device: DeviceStore;
  private readonly pauseStore: PauseStore;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly log: Log;
  private readonly hostHash: string;
  private readonly blocked: boolean;

  // A wait of this page alone: `unexpected` (Web Retry 4a), or a server pause whose write failed.
  private local: LocalWait | undefined;
  // The `probe_at` this page wrote last, so that its own probe never holds it back.
  private ownProbeAt: number | undefined;

  constructor(options: RetryPolicyOptions) {
    this.device = options.device;
    this.pauseStore = options.pause;
    this.clock = options.clock;
    this.random = options.random;
    this.log = options.log;
    // The pause scope (Web Retry 4a): the configured host, trailing slashes already removed by the
    // configuration (plan section 15, step 4.1).
    this.hostHash = keyHash(options.config.host);
    this.blocked = options.config.hostSecurity === 'blocked';
  }

  /** The `.pause` host value of this page: `keyHash` of the configured host. */
  get pauseHost(): string {
    return this.hostHash;
  }

  /**
   * Whether an attempt may start now, from a fresh read of `.pause` and `.device` (Web Retry 1.1). A
   * `go` that ends a wait has written `probe_at` (Web Retry 1.5); give its attempt to
   * {@link onResult}.
   */
  gate(): UploadGate {
    if (this.blocked) return BLOCKED;
    const now = this.clock.now();
    const local = this.localEnd(now);
    const retry = this.device.state.retry;
    const transientEnd = this.transientEnd(retry, now);
    const pause = this.ownPause();
    const pauseEnd = pause === undefined ? undefined : this.pauseEnd(pause, now);

    const waits: { readonly until: number | undefined; readonly reason: WaitReason }[] = [
      { until: local, reason: 'local' },
      { until: transientEnd, reason: 'transient' },
      { until: pauseEnd, reason: pause === undefined ? 'config' : pause.kind },
    ];
    let wait: UploadGate | undefined;
    for (const { until, reason } of waits) {
      if (until !== undefined && until > now && (wait?.kind !== 'wait' || until > wait.until)) {
        wait = { kind: 'wait', until, reason };
      }
    }
    if (wait !== undefined) return wait;

    const shared = later(transientEnd, pauseEnd);
    if (shared === undefined) return go(retry.rev, false);
    // A shared wait has ended. A probe started since then answers for every page: its own page goes
    // on, another page waits for its result for 30 s and then goes on (Web Retry 1.5).
    const probeAt = validProbeAt(retry, now);
    if (probeAt !== undefined && probeAt >= shared) {
      if (probeAt === this.ownProbeAt || now - probeAt >= PROBE_WINDOW_MS) return go(retry.rev, false);
      return { kind: 'wait', until: probeAt + PROBE_WINDOW_MS, reason: 'probe' };
    }
    this.writeProbe(now);
    return go(retry.rev, true);
  }

  /**
   * Which of `chunks`, in the uploader's order, the next batch may take (Web Retry 1.6): the chunks
   * that are not suspects, which the chunk store then takes whole while they fit; when only suspects
   * are left, a cleared one alone (the one with the fewest lone attempts, then the first), else the
   * suspects as before, since a general outage goes on.
   */
  selectChunks<T extends { readonly id: string }>(chunks: readonly T[]): T[] {
    const suspects = this.device.state.retry.suspects;
    const healthy = chunks.filter((chunk) => !isSuspect(suspects.get(chunk.id)) && !goesAlone(suspects.get(chunk.id)));
    if (healthy.length > 0 || chunks.length === 0) return healthy;
    let alone: T | undefined;
    let fewest = Infinity;
    for (const chunk of chunks) {
      const suspect = suspects.get(chunk.id);
      if (suspect !== undefined && goesAlone(suspect) && suspect.alone < fewest) {
        alone = chunk;
        fewest = suspect.alone;
      }
    }
    if (alone !== undefined) return [alone];
    return chunks.slice();
  }

  /**
   * Records the result of the attempt that sent the chunks `chunkIds` and returns what to do with
   * them; one merge write of `.device`, and of `.pause` for a server pause.
   */
  onResult(
    attempt: RetryAttempt,
    chunkIds: readonly string[],
    result: HttpResult,
    options: ResultOptions = {},
  ): RetryDecision {
    const group = retryGroupOf(result);
    if (group === 'unknown' || (options.closing === true && isTypeError(result))) {
      // An unknown outcome is a waiting state (Web Retry 4c): no step, no revision, no counter.
      this.log.debug(() => 'The outcome of an upload is unknown; nothing is recorded and its chunks stay');
      return 'keep';
    }
    const now = this.clock.now();
    switch (group) {
      case 'success':
        this.succeeded(attempt, chunkIds);
        return 'delete-sent';
      case 'bad-batch': {
        const status = result.kind === 'http-error' ? result.status : 0;
        this.log.warn('BATCH_REJECTED', () => `The server rejected a batch with ${String(status)}; it was deleted`);
        this.forget(chunkIds);
        return 'delete-rejected';
      }
      case 'transient':
        return this.transient(chunkIds, result, now);
      case 'throttle':
        this.throttle(result, now);
        return 'keep';
      case 'config':
        this.config(result, now);
        return 'keep';
    }
  }

  /**
   * `retry.rev` at an `online` event (Web Retry 2); after the short delay of Queue 3 the uploader
   * gives it to {@link onlineAttempt}.
   */
  noteOnline(): number {
    return this.device.state.retry.rev;
  }

  /**
   * The early attempt of Web Retry 2, decided after the delay from a fresh read: only while a
   * transient wait after `connect`, `io` or `timeout` is in force, no server pause is, no other page
   * wrote a failure since `notedRev`, and no other page is probing. It writes `probe_at` only, never
   * `step`, the wait or `.pause`; `undefined` when nothing should happen.
   */
  onlineAttempt(notedRev: number): RetryAttempt | undefined {
    if (this.blocked) return undefined;
    const now = this.clock.now();
    if (this.localEnd(now) !== undefined) return undefined;
    const pause = this.ownPause();
    if (pause !== undefined && this.pauseEnd(pause, now) > now) return undefined;
    const retry = this.device.state.retry;
    if (retry.rev !== notedRev) return undefined;
    const end = this.transientEnd(retry, now);
    if (end === undefined || end <= now) return undefined;
    if (retry.lastFailure === undefined || NETWORK_FAILURES.indexOf(retry.lastFailure) < 0) return undefined;
    const probeAt = validProbeAt(retry, now);
    if (probeAt !== undefined && probeAt !== this.ownProbeAt && now - probeAt < PROBE_WINDOW_MS) return undefined;
    this.writeProbe(now);
    this.log.debug(() => 'The network returned; one early attempt after a network failure');
    return { rev: retry.rev, probe: true };
  }

  /** Forgets the counters of chunks deleted for any reason (Web Retry 1.6, point 6). */
  forget(chunkIds: readonly string[]): void {
    const suspects = this.device.state.retry.suspects;
    if (!chunkIds.some((id) => suspects.has(id))) return;
    this.device.update((state) => {
      const left = new Map(state.retry.suspects);
      chunkIds.forEach((id) => left.delete(id));
      return { ...state, retry: { ...state.retry, suspects: left } };
    });
    this.device.persist();
  }

  /**
   * Removes the counters of chunks that no longer exist, given the ids the key walk found (Web Retry
   * 1.6, point 6); the uploader calls it after each walk.
   */
  prune(liveChunkIds: readonly string[]): void {
    const suspects = this.device.state.retry.suspects;
    const gone: string[] = [];
    suspects.forEach((_suspect, id) => {
      if (liveChunkIds.indexOf(id) < 0) gone.push(id);
    });
    this.forget(gone);
  }

  private succeeded(attempt: RetryAttempt, chunkIds: readonly string[]): void {
    this.device.update((state) => {
      const retry = state.retry;
      const suspects = new Map(retry.suspects);
      const hadSuspect = chunkIds.some((id) => isSuspect(suspects.get(id)));
      chunkIds.forEach((id) => suspects.delete(id));
      // A batch without suspects that the server accepts proves the server works (Web Retry 1.6.3).
      if (!hadSuspect) {
        suspects.forEach((suspect, id) => {
          if (isSuspect(suspect))
            suspects.set(id, { ...suspect, clearedBy: Math.min(MAX_COUNT, suspect.clearedBy + 1) });
        });
      }
      // A failure another page wrote since this request started is kept (Web Retry 1.4).
      const reset = retry.rev === attempt.rev;
      return {
        ...state,
        retry: reset
          ? { ...retry, suspects, step: 0, pausedUntil: undefined, lastFailure: undefined }
          : { ...retry, suspects },
      };
    });
    this.device.persist();
  }

  private transient(chunkIds: readonly string[], result: HttpResult, now: number): RetryDecision {
    // Only a server answer is evidence about the batch (Web Retry 4b): 408, 5xx and non-standard
    // codes; `timeout`, `io` and `connect` advance the backoff only.
    const counted = result.kind === 'http-error';
    const failure = failureName(result);
    const lone = chunkIds.length === 1 ? chunkIds[0] : undefined;
    const before = lone === undefined ? undefined : this.device.state.retry.suspects.get(lone);
    const aloneId = counted && lone !== undefined && goesAlone(before) ? lone : undefined;
    if (aloneId !== undefined && before !== undefined) {
      const f = before.f + 1;
      const alone = before.alone + 1;
      if (f >= EXHAUSTED_AFTER && alone >= ALONE_BEFORE_DELETE) {
        this.log.warn(
          'RETRY_EXHAUSTED',
          () =>
            `A chunk failed ${String(f)} times, ${String(alone)} of them alone, while other batches were accepted; it was deleted`,
        );
        this.forget(chunkIds);
        // The server works, as other batches show: no wait before the next one (Android log 5.2).
        return 'delete-exhausted';
      }
    }
    const factor = this.jitter(0.5, 1.5);
    this.device.update((state) => {
      const retry = state.retry;
      const step = retry.step + 1;
      const end = now + Math.floor(backoff(step) * factor);
      const stored = validEnd(retry.pausedUntil, 'transient', now);
      return {
        ...state,
        retry: {
          ...retry,
          step,
          rev: retry.rev + 1,
          lastFailure: failure,
          pausedUntil: stored !== undefined && stored > end ? stored : end,
          suspects: counted ? countFailure(retry.suspects, chunkIds, aloneId) : retry.suspects,
        },
      };
    });
    this.device.persist();
    const until = this.device.state.retry.pausedUntil ?? now;
    this.log.debug(() => `Upload failed (${failure}); waiting ${String(until - now)} ms`);
    return 'keep';
  }

  private throttle(result: HttpResult, now: number): void {
    const retryAfter = result.kind === 'http-error' ? result.retryAfterMs : undefined;
    let wait: number;
    if (retryAfter === undefined) {
      // Without `Retry-After` the table is used and advanced, as for group B (Android log 5.2).
      const failure = failureName(result);
      const factor = this.jitter(0.5, 1.5);
      wait = Math.floor(backoff(this.device.state.retry.step + 1) * factor);
      this.device.update((state) => ({
        ...state,
        retry: { ...state.retry, step: state.retry.step + 1, rev: state.retry.rev + 1, lastFailure: failure },
      }));
      this.device.persist();
    } else {
      const asked = Math.min(MAX_WAIT_MS, Math.max(MIN_RETRY_AFTER_MS, retryAfter));
      // Never earlier than asked, never past the hour (Retry 3).
      wait = Math.min(MAX_WAIT_MS, Math.max(asked, Math.floor(asked * this.jitter(1.0, 1.1))));
    }
    this.writePause('throttle', wait, now);
    this.log.debug(() => `The server asked to slow down; uploads pause for ${String(wait)} ms`);
  }

  private config(result: HttpResult, now: number): void {
    const wait = Math.floor(MAX_WAIT_MS * this.jitter(0.8, 1.2));
    if (result.kind !== 'http-error') {
      // `unexpected` comes from this page's own environment (Web Retry 4a): a pause of this page
      // only, never written; `HTTP_UNEXPECTED` was logged by the HTTP client.
      this.holdLocally(now + wait, 'config');
      this.log.debug(() => `An unexpected failure pauses this page's uploads for ${String(wait)} ms`);
      return;
    }
    this.logConfigProblem(result.status, result.redirect === true);
    this.writePause('config', wait, now);
  }

  // The HTTP client already logged an `opaqueredirect` (HTTP_REDIRECT) and `unexpected`.
  private logConfigProblem(status: number, redirect: boolean): void {
    if (redirect) return;
    const code = String(status);
    if (status === 401 || status === 403) {
      this.log.error(
        'UPLOAD_UNAUTHORIZED',
        () => `The server rejected the API key (${code}); uploads pause for an hour`,
      );
    } else if (status === 404 || status === 410) {
      this.log.error('UPLOAD_ENDPOINT_MISSING', () => `The upload endpoint does not exist (${code}); check host`);
    } else if (status === 413) {
      this.log.error('UPLOAD_TOO_LARGE', () => 'A gateway rejected the request size (413); uploads pause for an hour');
    } else if (status === 501 || status === 505) {
      this.log.error('UPLOAD_NOT_SUPPORTED', () => `The server does not support the request (${code})`);
    } else if (status >= 300 && status <= 399 && status !== 304) {
      // A 3xx that `fetch` does not report as a redirect (300, ...) logs HTTP_REDIRECT, a 304 to an
      // upload nothing, as Android and iOS do (plan section 15, step 5.2).
      this.log.error(
        'HTTP_REDIRECT',
        () => `An upload was answered with ${code}, which is not followed; uploads pause for an hour, check host`,
      );
    }
  }

  /**
   * Writes a server pause (Web Retry 1.3): the later of the fresh record's end and this page's, read
   * back and written once more if the stored end is earlier. A record of another host, or one beyond
   * its kind's longest wait, is left out of the comparison. A pause that cannot be written still
   * holds this page.
   */
  private writePause(kind: PauseKind, waitMs: number, now: number): void {
    const own: PauseRecord = { until: now + waitMs, kind, host: this.hostHash };
    const change = (stored: PauseRecord | undefined): PauseRecord =>
      stored !== undefined && this.covers(stored, own, now) ? stored : own;
    let result = this.pauseStore.write(change);
    if (result === 'written' || result === 'unchanged') {
      const back = this.pauseStore.read();
      const stored = back.status === 'present' ? back.state : undefined;
      if (
        back.status === 'missing' ||
        (back.status === 'present' && (stored === undefined || !this.covers(stored, own, now)))
      ) {
        result = this.pauseStore.write(change);
      }
    }
    if (result === 'failed') this.holdLocally(own.until, kind);
  }

  private covers(stored: PauseRecord, own: PauseRecord, now: number): boolean {
    const end = stored.host === this.hostHash ? validEnd(stored.until, stored.kind, now) : undefined;
    return end !== undefined && end >= own.until;
  }

  private holdLocally(until: number, kind: WaitKind): void {
    const now = this.clock.now();
    const current = this.localEnd(now);
    if (current === undefined || until > current) this.local = { until, kind };
  }

  /** The end of this page's own wait, guarded; `undefined` once it ended. */
  private localEnd(now: number): number | undefined {
    const local = this.local;
    if (local === undefined) return undefined;
    if (local.until <= now) {
      this.local = undefined;
      return undefined;
    }
    const longest = LONGEST_WAIT_MS[local.kind];
    if (local.until - now > longest) this.local = { until: now + longest, kind: local.kind };
    return this.local?.until;
  }

  /** This host's pause, from the fresh record with this page's unwritten changes. */
  private ownPause(): PauseRecord | undefined {
    const pause = this.pauseStore.state;
    return pause !== undefined && pause.host === this.hostHash ? pause : undefined;
  }

  /**
   * The end of the transient wait, under the clock guard (Web Retry 3): a deadline beyond the
   * longest wait reads as the longest wait from now and is written back as that, once, so that the
   * next page load reads a valid end (plan section 15, step 5.2).
   */
  private transientEnd(retry: RetryState, now: number): number | undefined {
    const seen = retry.pausedUntil;
    if (seen === undefined) return undefined;
    if (validEnd(seen, 'transient', now) !== undefined) return seen;
    const end = now + LONGEST_WAIT_MS.transient;
    this.device.update((state) =>
      state.retry.pausedUntil === seen ? { ...state, retry: { ...state.retry, pausedUntil: end } } : state,
    );
    this.device.persist();
    this.log.debug(() => 'A stored wait lay beyond the longest of its kind; it now ends in 15 minutes');
    return end;
  }

  /** The end of this host's pause, under the clock guard; see {@link transientEnd}. */
  private pauseEnd(pause: PauseRecord, now: number): number {
    if (validEnd(pause.until, pause.kind, now) !== undefined) return pause.until;
    const end = now + LONGEST_WAIT_MS[pause.kind];
    this.pauseStore.write((stored) =>
      stored !== undefined && stored.until === pause.until && stored.host === pause.host && stored.kind === pause.kind
        ? { ...stored, until: end }
        : stored,
    );
    this.log.debug(() => 'A stored pause lay beyond the longest of its kind; it now ends within the hour');
    return end;
  }

  private writeProbe(now: number): void {
    this.ownProbeAt = now;
    this.device.update((state) => ({ ...state, retry: { ...state.retry, probeAt: now } }));
    this.device.persist();
  }

  /** A factor in `[low, high)` from one draw of the `RandomSource` (Retry 2: jitter from the platform). */
  private jitter(low: number, high: number): number {
    return low + ((high - low) * this.random.nextUint32()) / 4_294_967_296;
  }
}

const BLOCKED: UploadGate = { kind: 'blocked' };

function go(rev: number, probe: boolean): UploadGate {
  return { kind: 'go', attempt: { rev, probe } };
}

/** The wait of group B after `step` consecutive failures (Retry 2). */
function backoff(step: number): number {
  const index = Math.min(Math.max(step, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index] ?? MAX_WAIT_MS;
}

/** `end` when it is within its kind's longest wait from now; `undefined` when the clock was set back. */
function validEnd(end: number | undefined, kind: WaitKind, now: number): number | undefined {
  return end !== undefined && end - now <= LONGEST_WAIT_MS[kind] ? end : undefined;
}

/** `probe_at` unless it lies in the future, which only a clock set back explains. */
function validProbeAt(retry: RetryState, now: number): number | undefined {
  const probeAt = retry.probeAt;
  return probeAt !== undefined && probeAt <= now ? probeAt : undefined;
}

function later(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function isSuspect(suspect: SuspectState | undefined): boolean {
  return suspect !== undefined && suspect.f >= SUSPECT_AFTER;
}

function goesAlone(suspect: SuspectState | undefined): boolean {
  return suspect !== undefined && suspect.clearedBy >= 1;
}

function countFailure(
  suspects: ReadonlyMap<string, SuspectState>,
  chunkIds: readonly string[],
  aloneId: string | undefined,
): Map<string, SuspectState> {
  const counted = new Map(suspects);
  chunkIds.forEach((id) => {
    const suspect = counted.get(id) ?? { f: 0, alone: 0, clearedBy: 0 };
    counted.set(id, {
      f: Math.min(MAX_COUNT, suspect.f + 1),
      alone: id === aloneId ? Math.min(MAX_COUNT, suspect.alone + 1) : suspect.alone,
      clearedBy: suspect.clearedBy,
    });
  });
  return counted;
}

function isTypeError(result: HttpResult): boolean {
  return result.kind === 'network-failure' && (result.failure === 'io' || result.failure === 'connect');
}

/** The stored `last_failure`: a failure kind such as `io`, `redirect`, or `http_503` (Android `failureName`). */
export function failureName(result: HttpResult): string {
  switch (result.kind) {
    case 'network-failure':
      return result.failure;
    case 'http-error':
      return result.redirect === true ? 'redirect' : `http_${String(result.status)}`;
    case 'keepalive-refused':
      return 'keepalive_refused';
    case 'success':
      return 'none';
  }
}
