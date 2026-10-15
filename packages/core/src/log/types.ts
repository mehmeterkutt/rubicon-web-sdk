import type { Event } from '../event/event';

/**
 * Every {@link LogLevel}, from the most detailed to `off`, so the SDK can iterate and order them (Web
 * Event Model 5: string literal unions with an `as const` array, never `enum`). Internal: the public
 * union is spelled out and this array is checked against it, so `web` exports types only (plan
 * section 15, step 3.2).
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'off'] as const satisfies readonly LogLevel[];

/**
 * How much the SDK logs, set with `logging.level` (default `warn`). A level includes every level
 * after it: `warn` also logs `error`. The meaning of each level is a contract (Logging 2):
 *
 * - `error`: data is lost or the SDK cannot work, such as an invalid API key or a failed write;
 * - `warn`: a misconfiguration, or data that was dropped or changed, such as a dropped property or a
 *   full queue; a healthy page logs nothing at this level;
 * - `info`: a few lifecycle lines, such as the host in use or a consent change;
 * - `debug`: every step;
 * - `off`: nothing, whatever `debug` says.
 *
 * The level is the only authority over what is written: `debug` adds no line (Web Logging 1).
 * Values may be added in minor versions; a `switch` over a `LogLevel` should keep a `default` branch.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

/**
 * Receives the SDK's log lines, set with `logging.logger`. Without one the browser console is used,
 * each line prefixed `[Rubicon]`; a logger you set is never replaced unless it throws.
 *
 * Only lines that pass `logging.level` arrive, so the logger needs no level logic. Every warning and
 * error starts with its stable code, such as `QUEUE_FULL: ...`. Messages never contain property or
 * trait values, user or device ids, the API key, headers, bodies, query strings or anything taken
 * from a caught error; `error` is the caught error itself, when there is one, and reaches only this
 * function (Logging 4, Web Logging 1).
 *
 * Keep it fast and do not call the SDK from it: lines caused inside the logger are ignored. If it
 * throws, or returns a Promise that rejects, the console is used for the rest of the page.
 *
 * @example
 * ```ts
 * const logger: RubiconLogger = (level, message, error) => {
 *   if (level === 'error') errorTracker.captureMessage(`Rubicon: ${message}`);
 * };
 * ```
 */
export type RubiconLogger = (level: LogLevel, message: string, error?: unknown) => void;

/**
 * Every {@link DropReason}, so the SDK can iterate them. Internal: the public union is spelled out
 * and this array is checked against it (plan section 15, step 3.2).
 */
export const DROP_REASONS = [
  'queue_full',
  'expired',
  'backpressure',
  'before_send',
  'storage_error',
  'corrupt',
  'oversize',
  'rejected',
  'retry_exhausted',
  'page_closed',
] as const satisfies readonly DropReason[];

/**
 * Why events were dropped (Queue 5, Web Logging 3), as reported by a `dropped` {@link EventUpdate}
 * and counted in the automatic `SDK Diagnostics` event:
 *
 * - `queue_full`: more than 1000 events were waiting, or the stored events grew too large; the
 *   oldest were dropped;
 * - `expired`: the event was older than three days when it could be sent;
 * - `backpressure`: events were tracked faster than they could be stored;
 * - `before_send`: a `beforeSend` hook returned `null`, threw, or returned an event it may not;
 * - `storage_error`: the event could not be written, for example when storage was full;
 * - `corrupt`: a stored event was damaged and could not be read;
 * - `oversize`: the event was larger than 32 KB;
 * - `rejected`: the server rejected the batch as malformed;
 * - `retry_exhausted`: the batch kept failing while others were accepted, and was given up;
 * - `page_closed`: the page closed before the event was written; counted on a best-effort basis.
 *
 * Values may be added in minor versions; a `switch` over a `DropReason` should keep a `default`
 * branch.
 */
export type DropReason =
  | 'queue_full'
  | 'expired'
  | 'backpressure'
  | 'before_send'
  | 'storage_error'
  | 'corrupt'
  | 'oversize'
  | 'rejected'
  | 'retry_exhausted'
  | 'page_closed';

/**
 * What became of events (Logging 4c), as reported to an {@link EventObserver}:
 *
 * - `queued`: the event passed the hooks and validation and was stored, in the page that stored it;
 * - `sent`: the server accepted a batch with these events, in the page that sent it, which may hold
 *   other tabs' events;
 * - `dropped`: these events were dropped for `reason`, in the page that dropped them; events dropped
 *   before they were stored are included.
 *
 * Only `queued` carries the event; later updates carry `messageIds`, to match with
 * `event.messageId`. Members may be added in minor versions; a `switch` over `type` should keep a
 * `default` branch.
 */
export type EventUpdate =
  | { readonly type: 'queued'; readonly event: Event }
  | { readonly type: 'sent'; readonly messageIds: readonly string[] }
  | { readonly type: 'dropped'; readonly messageIds: readonly string[]; readonly reason: DropReason };

/**
 * Receives an {@link EventUpdate} for every event, set with `logging.eventObserver`; meant for
 * debug builds and tests. While consent is pending, `queued` arrives and `sent` waits.
 *
 * Keep it fast and do not call the SDK from it: updates and lines caused inside it are ignored. If
 * it throws, or returns a Promise that rejects, it is switched off for the rest of the page.
 *
 * @example
 * ```ts
 * const seen: Event[] = [];
 * const eventObserver: EventObserver = (update) => {
 *   if (update.type === 'queued') seen.push(update.event);
 * };
 * ```
 */
export type EventObserver = (update: EventUpdate) => void;
