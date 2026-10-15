import type { EventObserver, EventUpdate, LogLevel, RubiconLogger } from './types';

/**
 * Where lines go when the developer gave no logger, or after theirs failed: the `console` sink in
 * `web` (step 7.1), nothing in `core` (Web Logging 1). It never receives the caught error: the
 * console is public and read by monitoring scripts.
 */
export interface DefaultSink {
  /** Writes one line at its level. */
  write(level: LogLevel, message: string): void;
  /**
   * Writes a developer-error line in the form `debug: true` asks for, `console.error(new Error(message))`
   * in the browser; called instead of {@link write} only for such a line at its own level.
   */
  writeDeveloperError(message: string): void;
}

/** The core's default sink: writes nothing, so Node code never touches `console` (Web Logging 1). */
export const NO_OP_SINK: DefaultSink = {
  write: () => undefined,
  writeDeveloperError: () => undefined,
};

// Set while the developer's logger or observer, or the default sink, runs. The page has one thread,
// so a module-level flag is the web form of Android's ThreadLocal (Web Logging 1).
let inCallback = false;

/** Whether the code running now was called from inside the logger, the observer or the sink. */
export function isInCallback(): boolean {
  return inCallback;
}

/** What the guard tells its owner, at most once each; the owner logs the code (Logging 4b). */
export interface CallbackFailures {
  /** The logger threw or rejected and was replaced; lines go to the default sink from now on. */
  loggerFailed(error: unknown): void;
  /** The observer threw or rejected and was switched off. */
  observerFailed(error: unknown): void;
}

// The callbacks as the guard holds them: typed to return `unknown`, since a JavaScript function
// typed `void` may still return a Promise, whose rejection must be caught (Web Logging 1).
type HeldLogger = (...args: Parameters<RubiconLogger>) => unknown;
type HeldObserver = (...args: Parameters<EventObserver>) => unknown;

/**
 * Calls the developer's logger and event observer so that neither can break the SDK (Logging 4b,
 * Web Logging 1):
 *
 * - a logger that throws, or returns a Promise that rejects, is replaced by the default sink for
 *   the page, and the failure is reported once; the line it failed on goes to the sink;
 * - an observer that throws or rejects is switched off for the page, reported once;
 * - a line or update caused by one of these callbacks, for example by a logger that calls the SDK,
 *   is ignored, which prevents endless loops.
 *
 * A returned Promise is never awaited: its rejection is caught, so it never becomes an unhandled
 * rejection of the page.
 */
export class CallbackGuard {
  private logger: HeldLogger | undefined;
  private observer: HeldObserver | undefined;

  constructor(
    logger: RubiconLogger | undefined,
    observer: EventObserver | undefined,
    private readonly sink: DefaultSink,
    private readonly failures: CallbackFailures,
  ) {
    this.logger = logger;
    this.observer = observer;
  }

  /** Whether lines go to the developer's logger; `false` without one or after it failed. */
  get usesDeveloperLogger(): boolean {
    return this.logger !== undefined;
  }

  /** Whether an observer is set and still switched on. */
  get isObserverEnabled(): boolean {
    return this.observer !== undefined;
  }

  /**
   * Writes one line: to the developer's logger with its error, else to the default sink, in the
   * developer-error form when `developerErrorForm` is set.
   */
  log(level: LogLevel, message: string, error: unknown, developerErrorForm: boolean): void {
    const logger = this.logger;
    if (logger === undefined) {
      this.run(() => {
        if (developerErrorForm) this.sink.writeDeveloperError(message);
        else this.sink.write(level, message);
      });
      return;
    }
    const failure = this.run(
      () => logger(level, message, error),
      (rejection) => {
        this.loggerFailed(logger, rejection, level, message, developerErrorForm);
      },
    );
    if (failure !== undefined) this.loggerFailed(logger, failure.error, level, message, developerErrorForm);
  }

  /** Hands `update` to the observer, unless there is none or it was switched off. */
  notify(update: EventUpdate): void {
    const observer = this.observer;
    if (observer === undefined) return;
    const failure = this.run(
      () => observer(update),
      (rejection) => {
        this.observerFailed(observer, rejection);
      },
    );
    if (failure !== undefined) this.observerFailed(observer, failure.error);
  }

  // Only the logger that failed is replaced, once: a rejection that arrives after a throw, or from
  // an earlier call, finds another logger in place and changes nothing.
  private loggerFailed(
    failed: HeldLogger,
    error: unknown,
    level: LogLevel,
    message: string,
    developerErrorForm: boolean,
  ): void {
    if (this.logger !== failed) return;
    this.logger = undefined;
    this.failures.loggerFailed(error);
    this.log(level, message, error, developerErrorForm);
  }

  private observerFailed(failed: HeldObserver, error: unknown): void {
    if (this.observer !== failed) return;
    this.observer = undefined;
    this.failures.observerFailed(error);
  }

  /**
   * Runs `callback` with the flag set and returns what it threw, or `undefined`. A re-entrant call
   * is skipped. When the callback returns a thenable, `onRejected` is attached to it; a thenable
   * whose `then` throws counts as a throw.
   */
  private run(callback: () => unknown, onRejected?: (error: unknown) => void): { error: unknown } | undefined {
    if (inCallback) return undefined;
    inCallback = true;
    try {
      const result = callback();
      if (onRejected !== undefined && isThenable(result)) {
        result.then(undefined, (rejection: unknown) => {
          onRejected(rejection);
        });
      }
      return undefined;
    } catch (error) {
      return { error };
    } finally {
      inCallback = false;
    }
  }
}

interface Thenable {
  then(onFulfilled: undefined, onRejected: (error: unknown) => void): unknown;
}

// Reading `then` may run a getter of the developer's object; it runs inside `run`, so a throw there
// counts as the callback's.
function isThenable(value: unknown): value is Thenable {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
