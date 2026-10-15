import { CallbackGuard } from './callback-guard';
import type { DefaultSink } from './callback-guard';
import { ISSUE_CODES } from './issue-code';
import type { IssueCode, IssueCodeAt } from './issue-code';
import type { EventObserver, LogLevel, RubiconLogger } from './types';

/** Counts every WARN and ERROR by code for `SDK Diagnostics` (Logging 5); stored from step 4.1. */
export interface IssueCounter {
  increment(code: IssueCode): void;
}

/**
 * The device-wide half of the `per_24h` frequency (Web Logging 2): the time of a code's last line,
 * kept in `.device` by fresh read and merge from step 4.1. While consent is pending or refused, and
 * in the memory-only mode, it answers `true` and the limit is per page.
 */
export interface DailyLogLimit {
  /**
   * Whether `code` may be logged at its level now: `true` when its last line on this device is 24
   * hours old or more, or unknown, and records now as its time; best-effort, without a lock.
   */
  claim(code: IssueCode): boolean;
}

/** What {@link Log} is made of; one per `Analytics` instance. */
export interface LogOptions {
  /** `logging.level`. */
  readonly level: LogLevel;
  /** `debug`: changes only the form of a developer-error line in the default sink (Web Logging 1). */
  readonly debug: boolean;
  /** `logging.logger`; the default sink when absent. */
  readonly logger?: RubiconLogger;
  /** `logging.eventObserver`. */
  readonly eventObserver?: EventObserver;
  /** The platform's default sink: `console` in `web`, nothing in `core`. */
  readonly sink: DefaultSink;
  readonly issues?: IssueCounter;
}

/** Options of one WARN or ERROR line. */
export interface LineOptions {
  /** The caught error; it reaches only the developer's logger, never a message (Web Logging 1). */
  readonly error?: unknown;
  /** Limits repeats per key instead of per code, for lines a decision logs once per key. */
  readonly repeatKey?: string;
  /** A developer error (Web Public API 4): with `debug`, the default sink writes it as an `Error`. */
  readonly developerError?: boolean;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };

/**
 * The only way SDK code logs (Logging 1 to 4, Web Logging 1, 2). One per `Analytics` instance.
 *
 * - The level, and then the repeat limit, are checked before the message function runs, so a
 *   disabled line costs a comparison and builds no string (Logging 3).
 * - Every WARN and ERROR has an {@link IssueCode}. Every occurrence is counted, whatever the level;
 *   only the first in the page (per `repeatKey` when given) is logged at its own level, later ones at
 *   `debug`. A `per_24h` code is also asked of the {@link DailyLogLimit}, so another page load of the
 *   same device within 24 hours logs it at `debug` (Web Logging 2).
 * - A WARN or ERROR message starts with its code, `QUEUE_FULL: ...`.
 * - Lines go to the developer's logger, or to the default sink, through a {@link CallbackGuard}.
 *
 * Messages are built from fixed text and what Logging 4a allows: event names, keys and types,
 * counts, HTTP codes, durations, hosts and masked paths; never a value, an id, the key, a header, a
 * body, a query string or anything taken from a caught error, which goes in `error` only:
 *
 * ```ts
 * log.warn('PROPERTY_DROPPED', () => `Dropped property "${key}": unsupported type ${type}`, {
 *   developerError: true,
 * });
 * ```
 */
export class Log {
  readonly level: LogLevel;
  readonly callbacks: CallbackGuard;
  /** Set by the device store in step 4.1; the limit is per page while absent. */
  dailyLimit: DailyLogLimit | undefined;

  private readonly debugMode: boolean;
  private readonly issues: IssueCounter | undefined;
  private readonly reported = new Set<string>();

  constructor(options: LogOptions) {
    this.level = options.level;
    this.debugMode = options.debug;
    this.issues = options.issues;
    this.callbacks = new CallbackGuard(options.logger, options.eventObserver, options.sink, {
      loggerFailed: (error) => {
        this.warn('LOGGER_THREW', () => 'Custom logger threw; falling back to the default logger', { error });
      },
      observerFailed: (error) => {
        this.error('OBSERVER_THREW', () => 'Event observer threw; it is switched off', { error });
      },
    });
  }

  /** Whether a line at `level` is written; `off` never is. */
  isEnabled(level: LogLevel): boolean {
    return level !== 'off' && RANK[level] >= RANK[this.level];
  }

  debug(message: () => string): void {
    if (this.isEnabled('debug')) this.callbacks.log('debug', message(), undefined, false);
  }

  info(message: () => string): void {
    if (this.isEnabled('info')) this.callbacks.log('info', message(), undefined, false);
  }

  warn(code: IssueCodeAt<'warn'>, message: () => string, options?: LineOptions): void {
    this.line(code, 'warn', message, options);
  }

  error(code: IssueCodeAt<'error'>, message: () => string, options?: LineOptions): void {
    this.line(code, 'error', message, options);
  }

  private line(code: IssueCode, level: 'warn' | 'error', message: () => string, options?: LineOptions): void {
    const effective = this.report(code, level, options?.repeatKey);
    if (effective === undefined) return;
    // `debug` changes only the form of a developer error written at its own level; a repeat at
    // `debug` stays a debug line, since the level is the only authority (Web Logging 1).
    const developerErrorForm = this.debugMode && options?.developerError === true && effective === level;
    this.callbacks.log(effective, `${code}: ${message()}`, options?.error, developerErrorForm);
  }

  /**
   * Counts `code` and returns the level to log it at: `level` for its first occurrence in the page
   * (per `repeatKey`), and for a `per_24h` code only if the daily limit agrees; `debug` otherwise;
   * `undefined` when that level is disabled.
   */
  private report(code: IssueCode, level: 'warn' | 'error', repeatKey: string | undefined): LogLevel | undefined {
    this.issues?.increment(code);
    // A disabled level is never claimed, so a quiet page takes no 24-hour turn from a loud one.
    if (!this.isEnabled(level)) return undefined;
    const key = repeatKey === undefined ? code : `${code}:${repeatKey}`;
    if (this.reported.has(key)) return this.isEnabled('debug') ? 'debug' : undefined;
    this.reported.add(key);
    const daily = ISSUE_CODES[code].frequency === 'per_24h' ? this.dailyLimit : undefined;
    if (daily !== undefined && !claim(daily, code)) return this.isEnabled('debug') ? 'debug' : undefined;
    return level;
  }
}

// The limit is best-effort: one that throws lets the line through, per page.
function claim(limit: DailyLogLimit, code: IssueCode): boolean {
  try {
    return limit.claim(code);
  } catch {
    return true;
  }
}
