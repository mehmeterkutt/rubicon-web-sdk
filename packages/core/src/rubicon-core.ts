import type { Analytics } from './analytics';
import type { AutomaticCapture } from './automatic-capture';
import { reportConfig, validateConfig } from './config/config-validator';
import { DefaultAnalytics } from './default-analytics';
import type { CoreOptions } from './default-analytics';
import { NO_OP_SINK } from './log/callback-guard';
import type { DefaultSink } from './log/callback-guard';
import { Log } from './log/log';
import type { IssueCounter } from './log/log';
import { createNoOpAnalytics } from './no-op-analytics';
import type { Platform } from './platform';

/** What the core factory takes besides the configuration and the platform. */
export interface CreateCoreOptions extends CoreOptions {
  /**
   * Where lines go when the developer gives no `logging.logger`: the `console` sink in `web` (step
   * 7.1), nothing in the core (Web Logging 1).
   */
  readonly sink?: DefaultSink;
}

// The instances this factory made, for the test helpers below; weak, so a page's instance is never
// kept alive by it.
const INSTANCES = /*#__PURE__*/ new WeakMap<Analytics, DefaultAnalytics>();

/**
 * The core factory, `(config, platform)` (Configuration 3, 5; Android `RubiconCore.create`):
 * `createAnalytics` in `web` calls it with the browser platform (step 7.1), tests with a
 * `TestPlatform`.
 *
 * - The configuration is validated into its snapshot and every issue logged through the
 *   developer's logger and level (Web Configuration 1). A missing or blank key or an invalid host
 *   gives the no-op instance, with its ERROR; nothing is thrown, `debug` included (Web Public API 4).
 * - Otherwise the components are built and wired; nothing is read from storage or cookies here, the
 *   instance starts at its first use (see {@link DefaultAnalytics}).
 * - A failure while building gives the no-op instance with `WORKER_FAILED`: the page goes on.
 *
 * One instance per page is the web factory's (Web Configuration 3, step 7.1), across copies of the
 * SDK; this function makes a new instance at every call.
 */
export function createCore(config: unknown, platform: Platform, options: CreateCoreOptions = {}): Analytics {
  let log: Log | undefined;
  try {
    const validation = validateConfig(config, { urls: platform.urls, pageScheme: platform.pageScheme });
    // Counted into `.device` once the stores exist; the log is needed to build them (step 4.1).
    const counted: { target?: IssueCounter } = {};
    log = new Log({
      ...validation.logSettings,
      sink: options.sink ?? NO_OP_SINK,
      issues: {
        increment: (code) => {
          counted.target?.increment(code);
        },
      },
    });
    reportConfig(validation, log);
    const code = validation.snapshot;
    if (code === undefined) return createNoOpAnalytics();
    const core = new DefaultAnalytics({ code, platform, log, options });
    counted.target = core.stores.device.issueCounter;
    INSTANCES.set(core.analytics, core);
    attach(core, options, log);
    return core.analytics;
  } catch (error) {
    reportFailure(log, error);
    return createNoOpAnalytics();
  }
}

/**
 * Asks `analytics` to flush and resolves once nothing it can send is waiting, `true`, or when
 * `timeoutMs` passed, `false`; `false` at once for an instance this factory did not make. For tests
 * only, never public (Public API 9, Android `RubiconCore.flushBlocking`).
 */
export function flushAndWait(analytics: Analytics, timeoutMs: number): Promise<boolean> {
  const core = INSTANCES.get(analytics);
  return core === undefined ? Promise.resolve(false) : core.flushAndWait(timeoutMs);
}

/**
 * Stops `analytics` (writer, uploader, listeners) so a test can open another page over the same
 * storage; nothing for an instance this factory did not make. For tests only (Android
 * `RubiconCore.resetForTests`).
 */
export function shutdown(analytics: Analytics): void {
  INSTANCES.get(analytics)?.shutdown();
}

/** The instance behind `analytics`, for the core's own tests; `undefined` for the no-op. */
export function coreOf(analytics: Analytics): DefaultAnalytics | undefined {
  return INSTANCES.get(analytics);
}

/**
 * The automatic capture of `analytics`, for `createTrackedFetch` in `web` (step 7.7; Android's
 * `analytics as? AutomaticCapture`); `undefined` for the no-op, a test double or an instance of
 * another copy of the SDK, which `createTrackedFetch` then passes through.
 */
export function captureOf(analytics: Analytics): AutomaticCapture | undefined {
  return INSTANCES.get(analytics)?.capture;
}

// `onCreated` belongs to the platform's code: a throw there costs the automatic capture only.
function attach(core: DefaultAnalytics, options: CoreOptions, log: Log): void {
  if (options.onCreated === undefined) return;
  try {
    options.onCreated(core.capture);
  } catch (error) {
    log.error('WORKER_FAILED', () => 'Automatic capture could not be attached', { error });
  }
}

function reportFailure(log: Log | undefined, error: unknown): void {
  try {
    log?.error('WORKER_FAILED', () => 'The SDK could not start; it does nothing on this page', { error });
  } catch {
    // The log itself failed: nothing more can be said without risking the page.
  }
}
