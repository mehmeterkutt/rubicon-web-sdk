import type { HttpClient } from '../http/http-client';
import type { HttpResult } from '../http/http-result';
import { batchRequest } from '../http/requests';
import type { RequestConfig } from '../http/requests';
import { utf8ByteLength } from '../json';
import type { Log } from '../log/log';
import type { DropReason } from '../log/types';
import type { Clock } from '../platform/clock';
import type { LifecycleEvent, LifecycleSource, Unsubscribe } from '../platform/lifecycle-source';
import type { NetworkSignal } from '../platform/network-signal';
import type { ScheduledTask, Scheduler } from '../platform/scheduler';
import type { UploadTrigger } from '../pipeline/writer';
import type { RuntimeFlags } from '../remote/runtime-flags';
import { retryGroupOf } from '../retry/retry-group';
import type { RetryAttempt, RetryDecision, RetryPolicy } from '../retry/retry-policy';
import { batchBody, KEEPALIVE_BUDGET_BYTES, MAX_BATCH_BYTES } from '../storage/chunk-store';
import type { ChunkInfo, ChunkStore, DropCounter } from '../storage/chunk-store';

/**
 * Web Queue 2, point 5: another page's chunk may be sent once it is released or older than this,
 * counted from its `writtenAt`. The page leaves the value to the demo (its first proposal was one
 * hour; Mixpanel uses twice the flush interval): one hour, the user's answer, provisional until the
 * measurement of step 9.3 (plan section 15, step 6.4).
 */
export const ADOPT_AFTER_MS = 60 * 60 * 1000;

/**
 * Web Queue 3, Web Retry 2: the short delay between the `online` event and its attempt, against
 * `ERR_NETWORK_CHANGED` (Amplitude flushes one flush interval later, 1 s by default). The page gives
 * no value: 1 s, the user's answer, provisional until the demo checks it (plan section 15, step 6.4).
 */
export const ONLINE_DELAY_MS = 1_000;

/** What an {@link Uploader} is made of; the factory (step 6.7) wires it. */
export interface UploaderOptions {
  /** This key's chunks, every page's (step 4.2). */
  readonly chunks: Pick<ChunkStore, 'walk' | 'buildBatch' | 'delete'>;
  /** Sends the request and classifies its outcome (step 5.1). */
  readonly http: Pick<HttpClient, 'send'>;
  /** The key, the batch endpoint and `network.headers` (Web HTTP 1). */
  readonly config: RequestConfig;
  /** The rules of Retry 1 to 5 over the shared state (step 5.2). */
  readonly policy: Pick<
    RetryPolicy,
    'gate' | 'selectChunks' | 'onResult' | 'noteOnline' | 'onlineAttempt' | 'forget' | 'prune'
  >;
  /** The kill switch and the sample rate (Configuration 1). */
  readonly flags: Pick<RuntimeFlags, 'collecting'>;
  /**
   * Whether a new upload may start: the consent decision, read fresh before every upload (Web
   * Privacy 1, 2, Web Logging 4). Wired by step 6.5; Android's `uploadsAllowed`.
   */
  readonly uploadsAllowed: () => boolean;
  /**
   * The `device_id` of the identity cookie, read fresh when a batch is built (Web Privacy 3);
   * `undefined` when no stored identity can be read, which holds the upload (plan section 15, step
   * 6.4).
   */
  readonly currentDeviceId: () => string | undefined;
  /** Counts `rejected` and `retry_exhausted` for `SDK Diagnostics` (Queue 5). */
  readonly drops: DropCounter;
  /** Writes the stores' pending changes (Web Disk 3), after every result. */
  readonly persist: () => void;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly network: NetworkSignal;
  readonly lifecycle: LifecycleSource;
  readonly log: Log;
}

/** Why a drain runs: a writer trigger, or the uploader's own continuation, wait timer or catch-up. */
type DrainCause = UploadTrigger | 'continue' | 'retry' | 'catch-up';

/** The request on its way to the server. */
interface InFlight {
  readonly attempt: RetryAttempt;
  readonly chunks: readonly ChunkInfo[];
  /** The stored lines sent, never serialized again (Web Disk 2). */
  readonly texts: readonly string[];
  readonly messageIds: readonly string[];
  /** Started on the `pagehide` path: a refused `keepalive` is not tried again (Web HTTP 3). */
  readonly closing: boolean;
  /** The attempt without `keepalive` after a refusal has been made (Web Queue 5). */
  readonly retried: boolean;
}

/**
 * The uploader of Queue 1 and 4, the port of the Android `Uploader` for the browser's one thread and
 * several tabs (Web Queue 2, 3, 5; Web HTTP 1 to 3; Web Retry 1 to 4; Web Privacy 1 to 3; Web Logging
 * 4).
 *
 * - One request at a time: a trigger that arrives while a request is in flight is collapsed into one
 *   follow-up drain after its result (Queue 1). A drain sends batches one after another, oldest first,
 *   and stops at the first failure (Queue 4).
 * - Before every request, the hiding path included: the network (`navigator.onLine !== false`), the
 *   kill switch, the consent decision and a fresh read of `.pause` and `.device` through the retry
 *   policy (Web Retry 1.1, 2). A wait in force means no request; a timer to its end is a hint, caught
 *   up when the page becomes visible or returns from the back/forward cache (Web Retry 3), and only
 *   armed while chunks are pending.
 * - Which chunks: a fresh key walk, this page's own chunks first, then other pages' released or aged
 *   ones, read in place and deleted by key only after a 2xx (Web Queue 2, 3); suspects are left out
 *   by the policy (Web Retry 1.6). Lines whose `device_id` is not the identity cookie's are left out
 *   of the body, on purpose and uncounted, and leave with their chunk (Web Privacy 3).
 * - Every request whose uncompressed body fits {@link KEEPALIVE_BUDGET_BYTES} is `keepalive` (Web
 *   Queue 5). A `hidden` or `pagehide` trigger starts its request synchronously inside the browser's
 *   event, uncompressed, with a batch built to fit the budget (Web HTTP 2); a refused `keepalive`
 *   request is tried once without it while the page lives, never on `pagehide` (Web HTTP 3).
 * - `online` waits {@link ONLINE_DELAY_MS}, then makes the early attempt of Web Retry 2 or goes
 *   through the gate. No upload at start: leftovers wait for a trigger (Queue 2).
 *
 * Nothing here throws: every entry point, timer and callback catches and logs `WORKER_FAILED`.
 */
export class Uploader {
  private unsubscribes: Unsubscribe[] = [];
  private inFlight: InFlight | undefined;
  /** A trigger arrived during the request in flight (Queue 1: collapsed into one). */
  private wanted = false;
  private waitTimer: ScheduledTask | undefined;
  private waitUntil: number | undefined;
  private onlineTimer: ScheduledTask | undefined;

  constructor(private readonly options: UploaderOptions) {}

  /** Listens for the catch-up points of Web Retry 3; sends nothing (Queue 2: no upload at start). */
  start(): void {
    this.guard(() => {
      if (this.unsubscribes.length > 0) return;
      this.unsubscribes = [
        this.options.lifecycle.subscribe((event) => {
          this.guard(() => {
            this.onLifecycle(event);
          });
        }),
      ];
    });
  }

  /** Stops listening, cancels the timers and ignores the result of a request in flight; for tests and shutdown. */
  stop(): void {
    this.guard(() => {
      this.unsubscribes.forEach((unsubscribe) => {
        unsubscribe();
      });
      this.unsubscribes = [];
      this.cancelWait();
      this.onlineTimer?.cancel();
      this.onlineTimer = undefined;
      this.inFlight = undefined;
      this.wanted = false;
    });
  }

  /** A request is on its way to the server; for tests. */
  get busy(): boolean {
    return this.inFlight !== undefined;
  }

  /**
   * The writer asks for an upload (`Writer` option `upload`). Returns at once; a `hidden` or
   * `pagehide` request has started when it returns (Web HTTP 2).
   */
  upload(trigger: UploadTrigger): void {
    this.guard(() => {
      if (this.unsubscribes.length === 0) return;
      if (trigger === 'online' && this.inFlight === undefined) {
        this.scheduleOnline();
        return;
      }
      this.drain(trigger, undefined);
    });
  }

  private onLifecycle(event: LifecycleEvent): void {
    if (event !== 'visible' && event !== 'pageshow-persisted') return;
    // A timer of a hidden or frozen page may come late (Web Retry 3.4): a wait that has ended is
    // tried at once.
    const until = this.waitUntil;
    if (until === undefined || this.options.clock.now() < until) return;
    this.drain('catch-up', undefined);
  }

  // Web Retry 2: the `rev` is noted at the event and the attempt decided after the delay.
  private scheduleOnline(): void {
    if (this.onlineTimer !== undefined) return;
    const notedRev = this.options.policy.noteOnline();
    this.onlineTimer = this.options.scheduler.after(ONLINE_DELAY_MS, () => {
      this.onlineTimer = undefined;
      this.guard(() => {
        this.drain('online', notedRev);
      });
    });
  }

  /** Starts the next request, if any may start; chunks that need no request are deleted on the way. */
  private drain(cause: DrainCause, onlineRev: number | undefined): void {
    if (this.inFlight !== undefined) {
      // One request at a time: whatever asked is collapsed into one drain after its result (Queue 1).
      this.wanted = true;
      this.options.log.debug(() => `Upload (${cause}) follows the request in flight`);
      return;
    }
    this.cancelWait();
    // Chunks this drain deleted without a request, so a delete that failed cannot loop.
    const handled = new Set<string>();
    while (this.step(cause, onlineRev, handled)) {
      // each pass deleted or skipped chunks without a request
    }
  }

  /** One pass of a drain; `true` when it handled chunks without a request and should look again. */
  private step(cause: DrainCause, onlineRev: number | undefined, handled: Set<string>): boolean {
    const { options } = this;
    if (!options.network.isOnline()) {
      // No network is a waiting state, not a failure; `online` resumes (Web Retry 2).
      options.log.debug(() => 'Offline; the upload waits for the network');
      return false;
    }
    if (!options.flags.collecting || !options.uploadsAllowed()) return false;
    const walked = options.chunks.walk();
    if (walked === undefined) return false;
    options.policy.prune(walked.map((chunk) => chunk.id));
    const candidates = options.policy.selectChunks(this.eligible(walked, handled));
    if (candidates.length === 0) return false;
    const attempt = this.attemptFor(onlineRev);
    if (attempt === undefined) return false;
    const deviceId = options.currentDeviceId();
    if (deviceId === undefined) {
      options.log.debug(() => 'No stored identity can be read; the upload waits');
      return false;
    }
    const hiding = cause === 'hidden' || cause === 'pagehide';
    const batch = options.chunks.buildBatch(candidates, {
      sentAt: options.clock.now(),
      maxBytes: hiding ? KEEPALIVE_BUDGET_BYTES : MAX_BATCH_BYTES,
    });
    if (batch.status === 'unusable') return false;
    if (batch.chunks.length === 0) {
      // Every chunk vanished: another page sent or cleared them (Web Disk 1).
      candidates.forEach((chunk) => handled.add(chunk.key));
      return true;
    }
    const lines = batch.lines.filter((line) => line.deviceId === deviceId);
    const left = batch.lines.length - lines.length;
    if (left > 0) {
      options.log.debug(() => `${String(left)} stored events belong to a cleared device id; they are not sent`);
    }
    if (lines.length === 0) {
      // Nothing to send: every line was corrupt, expired or of another device id (Disk 5, Queue 5).
      this.deleteChunks(batch.chunks);
      batch.chunks.forEach((chunk) => handled.add(chunk.key));
      options.persist();
      return true;
    }
    const flight: InFlight = {
      attempt,
      chunks: batch.chunks,
      texts: lines.map((line) => line.text),
      messageIds: lines.map((line) => line.messageId),
      closing: cause === 'pagehide',
      retried: false,
    };
    this.send(flight, hiding);
    const events = lines.length;
    const chunks = batch.chunks.length;
    options.log.debug(() => `Upload (${cause}): ${String(events)} events in ${String(chunks)} chunks`);
    return false;
  }

  /** This page's own chunks first, then other pages' released or aged ones, each in walk order (Web Queue 2, 3). */
  private eligible(walked: readonly ChunkInfo[], handled: ReadonlySet<string>): ChunkInfo[] {
    const now = this.options.clock.now();
    const own: ChunkInfo[] = [];
    const others: ChunkInfo[] = [];
    for (const chunk of walked) {
      if (handled.has(chunk.key)) continue;
      if (chunk.own) own.push(chunk);
      // A `writtenAt` later than now (a clock set back) is not aged: its page, or the next visit
      // once the clock passes it, sends it (Web Retry 3: no wait trusted beyond the clock).
      else if (chunk.released || now - chunk.writtenAt >= ADOPT_AFTER_MS) others.push(chunk);
    }
    return own.concat(others);
  }

  /** The early attempt after `online` when the policy offers one, else the gate (Web Retry 1.1, 2). */
  private attemptFor(onlineRev: number | undefined): RetryAttempt | undefined {
    const { policy } = this.options;
    if (onlineRev !== undefined) {
      const early = policy.onlineAttempt(onlineRev);
      if (early !== undefined) return early;
    }
    const gate = policy.gate();
    switch (gate.kind) {
      case 'go':
        return gate.attempt;
      case 'wait':
        this.armWait(gate.until);
        this.options.log.debug(
          () => `Uploads wait (${gate.reason}) for ${String(gate.until - this.options.clock.now())} ms`,
        );
        return undefined;
      case 'blocked':
        // Mixed content: `CLEARTEXT_HOST` was logged at ERROR by the configuration (Web HTTP 3).
        this.options.log.debug(() => 'The host is blocked as mixed content; this page does not upload');
        return undefined;
    }
  }

  /**
   * Starts the request; inside a hiding handler it starts synchronously and uncompressed (Web HTTP 2).
   * `keepalive` when the body fits the budget, counted before compression, which only makes it
   * smaller (Web Queue 5).
   */
  private send(flight: InFlight, hiding: boolean): void {
    const { options } = this;
    const sentAt = options.clock.now();
    const keepalive = !flight.retried && utf8ByteLength(batchBody(sentAt, flight.texts)) <= KEEPALIVE_BUDGET_BYTES;
    this.inFlight = flight;
    const request = batchRequest(options.config, { sentAt, lines: flight.texts, keepalive, closing: hiding });
    options.http.send(request, (result) => {
      this.guard(() => {
        this.onResult(flight, result);
      });
    });
  }

  private onResult(flight: InFlight, result: HttpResult): void {
    // A result after `stop()`, or for a request this page no longer waits for, changes nothing.
    if (this.inFlight !== flight) return;
    this.inFlight = undefined;
    const { options } = this;
    if (result.kind === 'keepalive-refused' && !flight.closing && !flight.retried && this.mayStart()) {
      // A recovery attempt, not a diagnosis: once without `keepalive` while the page lives (Web Queue
      // 5 as changed on 2026-10-14, Web HTTP 3). It is the same attempt, so its result is the one recorded.
      options.log.debug(() => 'A keepalive request was refused; trying once without keepalive');
      this.send({ ...flight, retried: true }, false);
      return;
    }
    const decision = options.policy.onResult(flight.attempt, ids(flight.chunks), result, { closing: flight.closing });
    this.apply(flight, decision);
    options.persist();
    const wanted = this.wanted;
    this.wanted = false;
    if (decision !== 'keep') {
      // Batches one after another until nothing is pending (Queue 4).
      this.drain('continue', undefined);
      return;
    }
    // A failure has written its wait: the next drain arms the timer to its end and stops there. An
    // unknown outcome wrote nothing (Web Retry 4c): the chunks wait for the next trigger instead of
    // going again at once.
    if (wanted || !isUnknown(result, flight.closing)) this.drain(wanted ? 'flush' : 'retry', undefined);
  }

  private apply(flight: InFlight, decision: RetryDecision): void {
    switch (decision) {
      case 'delete-sent': {
        this.deleteChunks(flight.chunks);
        const events = flight.texts.length;
        this.options.log.debug(() => `Uploaded ${String(events)} events`);
        this.options.log.callbacks.notify({ type: 'sent', messageIds: flight.messageIds });
        return;
      }
      case 'delete-rejected':
        this.drop(flight, 'rejected');
        return;
      case 'delete-exhausted':
        this.drop(flight, 'retry_exhausted');
        return;
      case 'keep':
        return;
    }
  }

  // Counted and reported in the page that deleted them (Queue 5, Web Logging 1).
  private drop(flight: InFlight, reason: DropReason): void {
    this.deleteChunks(flight.chunks);
    this.options.drops.count(reason, flight.messageIds.length);
    this.options.log.callbacks.notify({ type: 'dropped', messageIds: flight.messageIds, reason });
  }

  private deleteChunks(chunks: readonly ChunkInfo[]): void {
    this.options.chunks.delete(chunks);
    this.options.policy.forget(ids(chunks));
  }

  private mayStart(): boolean {
    const { options } = this;
    return options.network.isOnline() && options.flags.collecting && options.uploadsAllowed();
  }

  // Web Retry 3: the timer is a hint; every path checks the deadline itself.
  private armWait(until: number): void {
    this.cancelWait();
    this.waitUntil = until;
    this.waitTimer = this.options.scheduler.after(Math.max(0, until - this.options.clock.now()), () => {
      this.waitTimer = undefined;
      this.waitUntil = undefined;
      this.guard(() => {
        this.drain('retry', undefined);
      });
    });
  }

  private cancelWait(): void {
    this.waitTimer?.cancel();
    this.waitTimer = undefined;
    this.waitUntil = undefined;
  }

  // An unexpected failure is an analytics gap, never an exception into the page (Web Logging 3,
  // `WORKER_FAILED`: an SDK task failed, as Android's coroutine handler logs it).
  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.options.log.error('WORKER_FAILED', () => 'The uploader failed; it goes on at the next trigger', {
        error,
      });
    }
  }
}

function ids(chunks: readonly ChunkInfo[]): string[] {
  return chunks.map((chunk) => chunk.id);
}

/** Web Retry 4c: a refused `keepalive` request, or a `TypeError` on the `pagehide` path, says nothing about the server. */
function isUnknown(result: HttpResult, closing: boolean): boolean {
  if (retryGroupOf(result) === 'unknown') return true;
  return closing && result.kind === 'network-failure' && (result.failure === 'io' || result.failure === 'connect');
}
