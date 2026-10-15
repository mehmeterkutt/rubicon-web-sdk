import type { ConfigSnapshot } from '../config/config-snapshot';
import type { Event } from '../event/event';
import { eventLine } from '../event/event-wire';
import type { Log } from '../log/log';
import type { DropReason } from '../log/types';
import type { Clock } from '../platform/clock';
import type { LifecycleEvent, LifecycleSource, Unsubscribe } from '../platform/lifecycle-source';
import type { NetworkSignal } from '../platform/network-signal';
import type { ScheduledTask, Scheduler } from '../platform/scheduler';
import type { RuntimeFlags } from '../remote/runtime-flags';
import type { ChunkLine, ChunkStore, DropCounter } from '../storage/chunk-store';
import { isOversizeLine, MAX_EVENT_BYTES } from '../validation/property-normalizer';
import type { EventPipeline, PreparedEvent } from './event-pipeline';

/** Queue 1, Web Queue 1: the call queue holds at most this many messages. */
export const WRITE_QUEUE_CAPACITY = 1000;

/**
 * Web Queue 1: the writer works in slices of about this long and then yields to the browser. A
 * provisional value, to be measured in the demo on a slow device (step 9.3; plan section 15).
 */
export const SLICE_BUDGET_MS = 10;

/**
 * Web Queue 1: the synchronous drain on hiding and `pagehide` stops after this long, the Long Tasks
 * threshold. Provisional like {@link SLICE_BUDGET_MS}.
 */
export const DRAIN_BUDGET_MS = 50;

/**
 * Why the writer asks the uploader for an upload (Queue 2, 7, Web Queue 3): `hidden` and `pagehide`
 * are the hiding path, whose request starts synchronously inside the browser's event, with the
 * keepalive budget and without gzip (Web Queue 5, Web HTTP 2); on `pagehide` a refused `keepalive`
 * request is not tried again (Web HTTP 3). `online` waits the uploader's short delay first (Web
 * Queue 3, Web Retry 2). Collapsing several requests into one upload is the uploader's (Queue 1).
 */
export type UploadTrigger = 'count' | 'interval' | 'hidden' | 'pagehide' | 'online' | 'flush' | 'immediate';

/** The settings the writer runs with: the code's, restricted by remote configuration (Configuration 1). */
export type WriterSettings = Pick<ConfigSnapshot, 'flushAt' | 'flushIntervalMs' | 'immediateEvents'>;

/** What a {@link Writer} is made of. */
export interface WriterOptions {
  /** The hooks and the second validation (step 6.3a). */
  readonly pipeline: Pick<EventPipeline, 'process'>;
  /** This page's chunks (step 4.2). */
  readonly chunks: Pick<ChunkStore, 'write' | 'walk' | 'release' | 'unrelease'>;
  /**
   * The effective configuration, asked once at the writer's first use, never when it is made: the
   * remote configuration's startup (step 5.3, Android's `Writer.startUp`), which also sets the kill
   * switch in `flags`.
   */
  readonly startup: () => WriterSettings;
  /** The kill switch and the sample rate (Configuration 1). */
  readonly flags: Pick<RuntimeFlags, 'collecting'>;
  /**
   * `false` while consent is refused, read fresh at the start of every slice and drain: events the
   * page accepted before an opt-out and has not written are discarded, unwritten and uncounted, as
   * Android's writer does (Privacy 1, 2, Web Logging 4 point 1). Wired by the privacy code (step 6.5).
   */
  readonly eventsAllowed: () => boolean;
  /** The `device_id` of the identity cookie, read fresh (Web Privacy 3, Web Identity 3). */
  readonly currentDeviceId: () => string;
  /** Counts every drop for `SDK Diagnostics` (Queue 5); wired to the device store by the factory. */
  readonly drops: DropCounter;
  /** Writes the stores' pending changes, coalesced (Web Disk 3): after every slice and on hiding. */
  readonly persist: () => void;
  /** Asks the uploader for an upload (step 6.4). */
  readonly upload: (trigger: UploadTrigger) => void;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly lifecycle: LifecycleSource;
  readonly network: NetworkSignal;
  readonly log: Log;
}

/** What the public call and the platform ask of the writer, in order (Queue 1, Web Queue 1). */
type WriteMessage =
  | { readonly kind: 'events'; readonly events: readonly PreparedEvent[] }
  | { readonly kind: 'flush'; readonly trigger: 'flush' | 'interval' }
  | { readonly kind: 'online' };

/** An accepted event waiting for the chunk write of its slice. */
interface Buffered {
  readonly line: ChunkLine;
  readonly event: Event;
}

/**
 * The writer of Web Queue 1, the port of the Android `Writer` (Queue 1, 2, 7) for the browser's one
 * thread. It owns the event store only: identity, session and the session cookie are written by the
 * public call (Web Queue 1, Web Session 2).
 *
 * - The public call puts one message into a bounded queue of {@link WRITE_QUEUE_CAPACITY} and
 *   returns; a full queue drops the call's events as `backpressure`, without blocking.
 * - The writer runs after paint (`Scheduler.yield`) in slices of {@link SLICE_BUDGET_MS}: the
 *   `device_id` check (Web Privacy 3), the hooks and the second validation, serialization and the
 *   32 KB scan, then one chunk write per slice of what the slice accepted (Web Queue 5: the chunk
 *   store closes a chunk at 100 events or the keepalive budget). The stores are persisted after
 *   every slice (Web Disk 3).
 * - On hiding and `pagehide` the queue is drained synchronously for at most {@link DRAIN_BUDGET_MS},
 *   then one flush. A hidden page keeps the rest and goes on in slices; `pagehide` is the closing
 *   page, whose rest is lost and counted as `page_closed` with the one store write of the drain.
 * - Flush triggers (Queue 2, 7, Web Queue 3, 4): `flush.at` events written since the last flush
 *   (leftover chunks counted once at the first use, Android log 6.3b); `flush.intervalMs` after the
 *   first pending event, started at the first use when chunks were left over, cancelled by any
 *   flush; hiding (`hidden` or `pagehide`, one flush for both); `online` while chunks are pending;
 *   `flush()`; an immediate event, by its final name after the hooks. A flush first writes what was
 *   accepted, so it covers every earlier call; nothing is flushed at the first use.
 *
 * Nothing here throws: every entry point, timer and slice catches, logs `WORKER_FAILED` and goes on.
 */
export class Writer {
  // Handled messages are cleared to `undefined` and the array reset when empty, so a dequeue is O(1).
  private readonly queue: (WriteMessage | undefined)[] = [];
  private head = 0;
  private buffered: Buffered[] = [];

  private settings: WriterSettings | undefined;
  private unsubscribes: Unsubscribe[] = [];
  private slice: ScheduledTask | undefined;
  private interval: ScheduledTask | undefined;
  private intervalDeadline: number | undefined;
  /** Events written since the last flush, for the count trigger (Android log 6.3b). */
  private writtenSinceFlush = 0;
  /** The `device_id` of the identity cookie, read once per slice or drain. */
  private deviceIdNow: string | undefined;
  /** Consent allows writing events, read at the start of each slice or drain. */
  private allowedNow = true;
  /** This hiding has flushed: `pagehide` and `hidden` give one flush (Web Queue 3). */
  private hidingFlushed = false;
  /** Set while draining: flushes wait for the one at the end of the drain. */
  private draining = false;
  /** A flush was asked for during the drain; always `false` outside one. */
  private flushWanted = false;

  constructor(private readonly options: WriterOptions) {}

  /** Listens to the page's lifecycle and network signals; the first use's work runs in the first slice. */
  start(): void {
    this.guard(() => {
      if (this.unsubscribes.length > 0) return;
      this.unsubscribes = [
        this.options.lifecycle.subscribe((event) => {
          this.guard(() => {
            this.onLifecycle(event);
          });
        }),
        this.options.network.subscribe((online) => {
          this.guard(() => {
            if (online) this.offer({ kind: 'online' });
          });
        }),
      ];
      this.scheduleSlice();
    });
  }

  /** Stops listening and cancels the slice and the timer; for tests and the factory's shutdown. */
  stop(): void {
    this.guard(() => {
      this.unsubscribes.forEach((unsubscribe) => {
        unsubscribe();
      });
      this.unsubscribes = [];
      this.slice?.cancel();
      this.slice = undefined;
      this.cancelInterval();
    });
  }

  /** No message waiting, nothing unwritten and no slice scheduled; for tests. */
  get idle(): boolean {
    return this.head === this.queue.length && this.buffered.length === 0 && this.slice === undefined;
  }

  /**
   * From the public call: the events it prepared (the session events it caused, then its event), as
   * one message; never blocks. Returns `false` when the queue was full and they were dropped as
   * `backpressure` (Queue 1, Web Queue 1).
   */
  enqueue(events: readonly PreparedEvent[]): boolean {
    let accepted = true;
    this.guard(() => {
      if (events.length === 0) return;
      if (this.offer({ kind: 'events', events })) {
        this.catchUpInterval();
        return;
      }
      accepted = false;
      const ids = events.map((prepared) => prepared.event.messageId);
      this.options.drops.count('backpressure', ids.length);
      this.options.log.warn(
        'BACKPRESSURE',
        () => `Events arrive faster than they can be stored; ${String(ids.length)} were dropped`,
      );
      this.dropped(ids, 'backpressure');
    });
    return accepted;
  }

  /** `flush()`: an upload of everything accepted before it, in order; returns at once (Web Queue 1). */
  flush(): void {
    this.guard(() => {
      this.offer({ kind: 'flush', trigger: 'flush' });
    });
  }

  /**
   * Writes `to` as the `device_id` of the events waiting in the queue that carry `from`: a pending
   * page's temporary id replaced by the stored identity at `optIn()` (Web Privacy 1; plan section 15,
   * step 6.5), before the device check would drop them as another device's. `user_id` stays.
   */
  replaceDeviceId(from: string, to: string): void {
    this.guard(() => {
      if (from === to) return;
      for (let i = this.head; i < this.queue.length; i += 1) {
        const message = this.queue[i];
        if (message?.kind !== 'events') continue;
        this.queue[i] = {
          kind: 'events',
          events: message.events.map((prepared) =>
            prepared.event.deviceId === from ? { ...prepared, event: { ...prepared.event, deviceId: to } } : prepared,
          ),
        };
      }
    });
  }

  /** The stores have changes to write (`register`, Web Disk 3): the next slice persists them. */
  requestPersist(): void {
    this.guard(() => {
      this.scheduleSlice();
    });
  }

  private offer(message: WriteMessage): boolean {
    if (this.queue.length - this.head >= WRITE_QUEUE_CAPACITY) {
      if (message.kind !== 'events')
        this.options.log.debug(() => `The write queue is full; the ${message.kind} message was skipped`);
      return false;
    }
    this.queue.push(message);
    this.scheduleSlice();
    return true;
  }

  private scheduleSlice(): void {
    if (this.slice !== undefined || this.unsubscribes.length === 0) return;
    this.slice = this.options.scheduler.yield(() => {
      this.slice = undefined;
      this.guard(() => {
        this.runSlice();
      });
    });
  }

  /** One slice after paint: messages until the budget is spent, then the chunk write and the stores. */
  private runSlice(): void {
    this.startUp();
    this.deviceIdNow = undefined;
    this.allowedNow = this.options.eventsAllowed();
    const started = this.options.clock.now();
    while (this.head < this.queue.length) {
      this.processNext();
      if (spent(started, this.options.clock.now(), SLICE_BUDGET_MS)) break;
    }
    this.writeBuffered();
    this.deviceIdNow = undefined;
    this.options.persist();
    if (this.head < this.queue.length) this.scheduleSlice();
  }

  /**
   * The synchronous drain of Web Queue 1 inside the browser's event: messages until the queue is
   * empty or {@link DRAIN_BUDGET_MS} are spent, the chunk write, one flush for the hiding, and on
   * `pagehide` the released marker and the rest counted as `page_closed`; then one store write.
   */
  private drain(trigger: 'hidden' | 'pagehide'): void {
    this.startUp();
    this.deviceIdNow = undefined;
    this.allowedNow = this.options.eventsAllowed();
    this.draining = true;
    try {
      const started = this.options.clock.now();
      while (this.head < this.queue.length && !spent(started, this.options.clock.now(), DRAIN_BUDGET_MS)) {
        this.processNext();
      }
      this.writeBuffered();
    } finally {
      this.draining = false;
      this.deviceIdNow = undefined;
    }
    // Each closing step on its own, so a failing one never costs the others their only chance.
    this.guard(() => {
      if (!this.hidingFlushed || this.flushWanted) {
        this.hidingFlushed = true;
        this.flushNow(trigger);
      }
    });
    this.flushWanted = false;
    if (trigger === 'pagehide') {
      this.guard(() => {
        this.options.chunks.release();
      });
      this.guard(() => {
        this.dropRest();
      });
    }
    this.options.persist();
  }

  // The closing page loses what it accepted and did not write: counted, logged and reported once,
  // and gone from the queue, so the count is what was lost (Web Queue 1, Web Logging 3).
  private dropRest(): void {
    const ids: string[] = [];
    for (let i = this.head; i < this.queue.length; i += 1) {
      const message = this.queue[i];
      if (message?.kind === 'events') message.events.forEach((prepared) => ids.push(prepared.event.messageId));
    }
    this.queue.length = 0;
    this.head = 0;
    if (ids.length === 0) return;
    this.options.drops.count('page_closed', ids.length);
    this.options.log.warn(
      'PAGE_CLOSED',
      () => `The page closed before ${String(ids.length)} accepted events were stored; they were dropped`,
    );
    this.dropped(ids, 'page_closed');
  }

  private onLifecycle(event: LifecycleEvent): void {
    if (event === 'hidden' || event === 'pagehide') {
      this.drain(event);
      return;
    }
    // A visible page, or one restored from the back/forward cache, is live again (Web Queue 2).
    this.hidingFlushed = false;
    if (event === 'pageshow-persisted') this.options.chunks.unrelease();
    this.catchUpInterval();
    if (this.head < this.queue.length) this.scheduleSlice();
  }

  /** The work of the first use, in the first slice or drain (Android's `startUp`): settings, leftovers. */
  private startUp(): WriterSettings {
    if (this.settings !== undefined) return this.settings;
    const settings = this.options.startup();
    this.settings = settings;
    // The walk at start deletes what expired (Queue 5); leftover chunks count once and start the
    // interval, and nothing is flushed now (Queue 2, Web Queue 3, Android log 6.3b).
    const leftover = (this.options.chunks.walk() ?? []).reduce((sum, chunk) => sum + chunk.count, 0);
    this.writtenSinceFlush = leftover;
    if (leftover > 0) this.startInterval();
    this.options.log.debug(() => `Writer started with ${String(leftover)} pending events`);
    return settings;
  }

  private processNext(): void {
    const message = this.queue[this.head];
    this.queue[this.head] = undefined;
    this.head += 1;
    if (this.head === this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    }
    if (message === undefined) return;
    this.guard(() => {
      this.handle(message);
    });
  }

  private handle(message: WriteMessage): void {
    switch (message.kind) {
      case 'events':
        this.handleEvents(message.events);
        return;
      case 'flush':
        this.requestFlush(message.trigger);
        return;
      case 'online': {
        // After every earlier event was written, and only while chunks are pending (Queue 2).
        this.writeBuffered();
        const pending = this.options.chunks.walk();
        if (pending !== undefined && pending.length > 0) this.requestFlush('online');
        return;
      }
    }
  }

  private handleEvents(events: readonly PreparedEvent[]): void {
    const settings = this.startUp();
    let immediate: string | undefined;
    for (const prepared of events) {
      const name = this.accept(prepared);
      if (name !== undefined && settings.immediateEvents.has(name)) immediate = name;
    }
    if (immediate !== undefined) {
      const matched = immediate;
      this.options.log.debug(() => `Immediate event "${matched}" accepted; flushing`);
      this.requestFlush('immediate');
    } else if (this.writtenSinceFlush + this.buffered.length >= settings.flushAt) {
      this.requestFlush('count');
    }
  }

  /** One event through the writer's steps; returns its final name when it was accepted. */
  private accept(prepared: PreparedEvent): string | undefined {
    const messageId = prepared.event.messageId;
    // A kill switch or a device outside the sample rate creates nothing; not a loss (Configuration 1).
    if (!this.options.flags.collecting) return undefined;
    // Nothing new is written after an opt-out, also what was accepted before it (Privacy 1, 2).
    if (!this.allowedNow) {
      this.options.log.debug(() => `Event ${messageId} was accepted before an opt-out; it was not stored`);
      return undefined;
    }
    // An event of a device id that `clearLocalData()` replaced is never written, on purpose and
    // uncounted (Web Privacy 3); hooks cannot change the id, so it is checked first.
    if (prepared.event.deviceId !== this.currentDeviceId()) {
      this.options.log.debug(() => `Event ${messageId} belongs to a cleared device id; it was not stored`);
      return undefined;
    }
    const result = this.options.pipeline.process(prepared);
    if (result.kind === 'dropped') {
      this.options.drops.count(result.reason, 1);
      this.dropped([messageId], result.reason);
      return undefined;
    }
    const event = result.event;
    const text = eventLine(event);
    // After the hooks: a hook's null, throw or violation keeps its own reason (section 15, step
    // 6.3b); a flag from either normalizer pass means the line is over the limit (step 2.5).
    if (result.oversize || isOversizeLine(text)) {
      this.options.drops.count('oversize', 1);
      this.options.log.warn(
        'EVENT_OVERSIZE',
        () => `An event is over the limit of ${String(MAX_EVENT_BYTES)} bytes; it was dropped`,
        { developerError: true },
      );
      this.dropped([messageId], 'oversize');
      return undefined;
    }
    this.buffered.push({ line: { text, timestamp: event.timestamp }, event });
    return event.type === 'identify' ? undefined : event.name;
  }

  /** What the slice accepted, as this page's next chunks; `queued` for each event stored (Web Logging 1). */
  private writeBuffered(): void {
    if (this.buffered.length === 0) return;
    const buffered = this.buffered;
    this.buffered = [];
    const result = this.options.chunks.write(buffered.map((item) => item.line));
    // The chunk store counted and logged a failed write as `storage_error` (Web Queue 6).
    const failed = new Set(result.droppedLines);
    if (failed.size > 0) {
      this.dropped(
        buffered.filter((_, i) => failed.has(i)).map((item) => item.event.messageId),
        'storage_error',
      );
    }
    buffered.forEach((item, i) => {
      if (!failed.has(i)) this.options.log.callbacks.notify({ type: 'queued', event: item.event });
    });
    this.writtenSinceFlush += result.stored;
    if (result.stored > 0 && this.interval === undefined) this.startInterval();
  }

  private requestFlush(trigger: UploadTrigger): void {
    if (this.draining) {
      this.flushWanted = true;
      return;
    }
    this.flushNow(trigger);
  }

  /** Closes what is unwritten into chunks and asks for an upload (Queue 1: a flush covers every earlier call). */
  private flushNow(trigger: UploadTrigger): void {
    this.writeBuffered();
    // TODO(step 6.6) SDK Diagnostics right before a flush, when due (Logging 5, Web Logging 5).
    this.cancelInterval();
    this.writtenSinceFlush = 0;
    this.options.log.debug(() => `Flush (${trigger})`);
    this.options.upload(trigger);
  }

  private startInterval(): void {
    const settings = this.settings;
    if (settings === undefined) return;
    this.cancelInterval();
    this.intervalDeadline = this.options.clock.now() + settings.flushIntervalMs;
    this.interval = this.options.scheduler.after(settings.flushIntervalMs, () => {
      this.guard(() => {
        this.interval = undefined;
        this.intervalDeadline = undefined;
        this.offer({ kind: 'flush', trigger: 'interval' });
      });
    });
  }

  // Timers are hints (Web Retry 3): a hidden or frozen page's timer may come late, so a passed
  // deadline is also caught at the next call, on becoming visible and on a restore.
  private catchUpInterval(): void {
    const deadline = this.intervalDeadline;
    if (deadline === undefined || this.options.clock.now() < deadline) return;
    this.cancelInterval();
    this.offer({ kind: 'flush', trigger: 'interval' });
  }

  private cancelInterval(): void {
    this.interval?.cancel();
    this.interval = undefined;
    this.intervalDeadline = undefined;
  }

  private currentDeviceId(): string {
    if (this.deviceIdNow === undefined) this.deviceIdNow = this.options.currentDeviceId();
    return this.deviceIdNow;
  }

  private dropped(messageIds: readonly string[], reason: DropReason): void {
    this.options.log.callbacks.notify({ type: 'dropped', messageIds, reason });
  }

  // An unexpected failure is an analytics gap, never an exception into the page (Web Queue 1, Web
  // Logging 3: a writer slice threw).
  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.options.log.error('WORKER_FAILED', () => 'The writer failed; it goes on with the next message', {
        error,
      });
    }
  }
}

/** The budget is spent, or the clock moved back, which ends the slice rather than stretching it. */
function spent(started: number, now: number, budgetMs: number): boolean {
  const elapsed = now - started;
  return elapsed >= budgetMs || elapsed < 0;
}
