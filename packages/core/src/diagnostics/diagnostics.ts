import type { IdentitySnapshot } from '../identity/identity';
import type { Log } from '../log/log';
import type { Clock } from '../platform/clock';
import type { EventPipeline, PreparedEvent } from '../pipeline/event-pipeline';
import type { DeviceStore, DiagnosticsState } from '../storage/device-store';
import type { StoreAccess } from '../storage/store-record';
import { formatIsoMillis } from '../util/iso-dates';
import type { UuidV7Generator } from '../util/uuid-v7-generator';
import type { PropertyValue } from '../validation/property-value';

/** The name of the automatic health event (Logging 5). */
export const SDK_DIAGNOSTICS = 'SDK Diagnostics';

/** At most one `SDK Diagnostics` an hour (Logging 5, Web Logging 5 point 2). */
export const DIAGNOSTICS_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Whether `SDK Diagnostics` is due at `now` (the Android `Diagnostics.isDue`): something was counted
 * and an hour has passed since the last report. A last time in the future, after the clock was set
 * back, counts as now (Logging 5, Web Logging 5 point 2).
 */
export function isDiagnosticsDue(state: DiagnosticsState, now: number): boolean {
  if (state.dropped.size === 0 && state.issues.size === 0) return false;
  const last = state.lastSentAt;
  if (last === undefined) return true;
  return now - Math.min(last, now) >= DIAGNOSTICS_INTERVAL_MS;
}

/**
 * The event's properties for `state` (the Android `Diagnostics.properties`, Android log 6.6):
 * `period_start` as an ISO string (now when counting has not begun or the stored time cannot be
 * written as one), `dropped` with `total` first and then each reason that counted, `issues` by code,
 * `{}` when none; keys sorted. Counts only, no text or values (Logging 5).
 */
export function diagnosticsProperties(state: DiagnosticsState, now: number): Record<string, PropertyValue> {
  const dropped: Record<string, PropertyValue> = { total: sum(state.dropped) };
  sortedKeys(state.dropped).forEach((reason) => {
    dropped[reason] = state.dropped.get(reason) ?? 0;
  });
  const issues: Record<string, PropertyValue> = {};
  sortedKeys(state.issues).forEach((code) => {
    issues[code] = state.issues.get(code) ?? 0;
  });
  const periodStart = formatIsoMillis(state.periodStart ?? now) ?? formatIsoMillis(now) ?? null;
  return { period_start: periodStart, dropped, issues };
}

function sum(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  counts.forEach((n) => {
    total += n;
  });
  return total;
}

function sortedKeys(counts: ReadonlyMap<string, number>): string[] {
  const keys: string[] = [];
  counts.forEach((_n, key) => keys.push(key));
  return keys.sort();
}

/** One `SDK Diagnostics` made from a snapshot of the counters, waiting for its chunk. */
export interface DiagnosticsReport {
  /** The session events its capture caused (Session 5), then the event itself. */
  readonly events: readonly PreparedEvent[];
  /** The event's own `message_id`. */
  readonly messageId: string;
  /** The counters it reports, subtracted at the checkpoint (Web Logging 5 point 4). */
  readonly counters: DiagnosticsState;
}

/** What a {@link DiagnosticsReporter} is made of. */
export interface DiagnosticsReporterOptions {
  /** `.device`, where the counters live (Web Logging 5 point 1). */
  readonly device: Pick<DeviceStore, 'read' | 'state' | 'checkpointDiagnostics'>;
  /** The access level the stores share: `full` only while consent is granted and storage is usable. */
  readonly access: StoreAccess;
  /** The event is captured like any automatic event (section 15, step 6.3a). */
  readonly pipeline: Pick<EventPipeline, 'capture' | 'callTimeValues'>;
  /** Who the event belongs to now, a fresh read (Web Identity 3). */
  readonly identity: () => IdentitySnapshot;
  /** The instance's generator (Web Event Model 3). */
  readonly ids: Pick<UuidV7Generator, 'next'>;
  /** `visibilityState` is `visible` now (Web Session 1). */
  readonly visible: () => boolean;
  readonly clock: Clock;
  readonly log: Log;
}

/**
 * `SDK Diagnostics` across tabs (Logging 5, Web Logging 5), the web form of the Android
 * `Diagnostics` and `Writer.appendDiagnosticsIfDue`. The writer asks for it right before a flush and
 * writes it with the flush's chunk; this class decides whether one is due and moves the checkpoint.
 *
 * - {@link prepare}: a fresh read of `.device`; nothing while the stores may not be used (consent
 *   pending or refused, the memory-only mode: access other than `full`, Web Logging 5 point 5) or
 *   while `.device` is unreadable (its checkpoint could never be written), nothing when every
 *   counter is zero or the last report is less than an hour old. Otherwise a snapshot of the
 *   counters, this page's unwritten counts included, becomes the event, captured like any automatic
 *   event (its session by Web Session 5) and marked to skip the hooks (Web Public API 5).
 * - {@link reported}: after the event's chunk was written, or after a hook dropped it on purpose,
 *   the checkpoint (Web Logging 5 points 3, 4): the snapshot subtracted from a fresh read and the
 *   time set, in one `setItem`. A failed write leaves everything, so the next flush reports again.
 *
 * Whether the event is sent at all (`logging.sendDiagnostics`, `diagnostics_sample_rate`, the kill
 * switch) is the writer's check, from the effective configuration (Configuration 1).
 */
export class DiagnosticsReporter {
  constructor(private readonly options: DiagnosticsReporterOptions) {}

  /**
   * The report due now, or `undefined`. `hiding` is the flush of a hiding or `pagehide`, where the
   * page is going away: the event then takes part in the session as a hidden page's event, which
   * uses a live session and starts none (Web Session 1; plan section 15, step 6.2 reading c).
   */
  prepare(hiding: boolean): DiagnosticsReport | undefined {
    const { device, access, pipeline, clock } = this.options;
    if (access.level !== 'full') return undefined;
    if (device.read().status === 'unreadable') return undefined;
    const counters = device.state.diagnostics;
    const now = clock.now();
    if (!isDiagnosticsDue(counters, now)) return undefined;
    const messageId = this.options.ids.next();
    const events = pipeline.capture({
      type: 'track',
      name: SDK_DIAGNOSTICS,
      properties: diagnosticsProperties(counters, now),
      source: 'auto',
      messageId,
      timestamp: now,
      visible: !hiding && this.options.visible(),
      identity: this.options.identity(),
      callTime: pipeline.callTimeValues(),
      skipsHooks: true,
    });
    return { events, messageId, counters };
  }

  /** The report's event is in the queue, or was dropped on purpose: the checkpoint. */
  reported(report: DiagnosticsReport): void {
    const result = this.options.device.checkpointDiagnostics(report.counters, this.options.clock.now());
    // A failed write was logged by the store (`STORAGE_WRITE_FAILED`).
    if (result === 'written' || result === 'unchanged') this.options.log.debug(() => `${SDK_DIAGNOSTICS} written`);
  }
}
