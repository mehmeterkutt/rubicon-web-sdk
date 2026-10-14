import type { ContextField } from '../context/context-field';
import type { BeforeSend } from '../event/before-send';
import type { EventObserver, LogLevel, RubiconLogger } from '../log/types';

// The platform-neutral half of the configuration (Web Configuration 6): the groups every platform
// has, with the Android names and meanings (Configuration 2). The `web` package extends `CoreConfig`
// into the public `AnalyticsConfig` with the browser-only settings, each in the group of the block
// that owns it. These types become public when `web` exports `AnalyticsConfig`.

/** The SaaS base URL, used when `host` is not set (D3; a placeholder until the production URL). */
export const DEFAULT_HOST = 'https://api.rubicon.example';

/**
 * Every {@link Autocapture} type on the web, in the order of Web Lifecycle 8, so the SDK can iterate
 * them. Internal: the public union is spelled out and this array is checked against it (plan
 * section 15, step 3.2).
 */
export const AUTOCAPTURE_TYPES = [
  'sessions',
  'page_views',
  'network_requests',
] as const satisfies readonly Autocapture[];

/**
 * An event type the SDK captures by itself, switched with `autocapture.enabled` (Lifecycle 6, Web
 * Lifecycle 8); all three are on by default, and remote configuration can switch a type off but never
 * on:
 *
 * - `sessions`: `Session Started` and `Session Ended`;
 * - `page_views`: `Page Viewed` on the load and on every navigation that changes the path; with it
 *   off, `history` is never wrapped;
 * - `network_requests`: `Network Request` for the requests made through `createTrackedFetch`, and
 *   only those; a remote switch-off applies at once.
 *
 * Members may be added in minor versions; a `switch` over an `Autocapture` should keep a `default`
 * branch.
 */
export type Autocapture = 'sessions' | 'page_views' | 'network_requests';

/**
 * Every {@link Consent}, so the SDK can iterate them. Internal: the public union is spelled out and
 * this array is checked against it (plan section 15, step 3.2).
 */
export const CONSENTS = ['granted', 'pending'] as const satisfies readonly Consent[];

/**
 * The consent state while no decision is stored, set with `privacy.defaultConsent` (Privacy 4). A
 * decision made with `optIn()` or `optOut()` and stored (`privacy.persistConsent`) always wins.
 *
 * - `granted`: events are collected and sent; the default.
 * - `pending`: events are kept in the page's memory and nothing is written to the browser until
 *   `optIn()`, which writes and sends them, or `optOut()`, which drops them (Web Privacy 1).
 */
export type Consent = 'granted' | 'pending';

/** When events are uploaded (Queue 2, 3, 7, Web Queue 4). Held by `flush`. */
export interface FlushConfig {
  /**
   * Upload when this many events are waiting. Default 30; a whole number from 1 to 100. A value out
   * of bounds is clamped with a warning.
   */
  readonly at?: number;
  /**
   * Upload this long after the first waiting event, in milliseconds. Default 5000 (five seconds); a
   * whole number from 1000 (one second) to 600 000 (ten minutes). A value out of bounds is clamped
   * with a warning.
   */
  readonly intervalMs?: number;
  /**
   * Event names that are uploaded right after they are stored, together with everything waiting
   * before them. Matched exactly, after the `beforeSend` hooks. Empty by default; duplicates are
   * ignored.
   *
   * @example
   * ```ts
   * flush: { immediateEvents: ['Purchase Completed'] }
   * ```
   */
  readonly immediateEvents?: readonly string[];
}

/** Which events the SDK captures by itself (Lifecycle 6, Web Lifecycle 8). Held by `autocapture`. */
export interface AutocaptureConfig {
  /**
   * The enabled types. Default: every {@link Autocapture} type. A value that is not a web member,
   * such as an Android type, is dropped with a warning.
   *
   * @example
   * ```ts
   * autocapture: { enabled: ['sessions', 'network_requests'] } // no Page Viewed
   * ```
   */
  readonly enabled?: readonly Autocapture[];
}

/** What goes into each event's `context` (Context 6, Web Context 5). Held by `context`. */
export interface CoreContextConfig {
  /** Fields that are never read and never sent. Empty by default; duplicates are ignored. */
  readonly disabledFields?: readonly ContextField[];
}

/** Consent (Privacy 2, 4, Web Privacy 1, 2). Held by `privacy`; changed at runtime with `optIn` and `optOut`. */
export interface PrivacyConfig {
  /** The state while no decision is stored. Default `granted`. */
  readonly defaultConsent?: Consent;
  /**
   * Whether the SDK stores the user's `optIn()` or `optOut()` decision, where it wins over
   * {@link PrivacyConfig.defaultConsent} on later pages. Default `true`. Set it to `false` when a
   * consent platform keeps the decision and passes it to the SDK on every page.
   */
  readonly persistConsent?: boolean;
}

/** The SDK's own log lines and health reports (Logging, Web Logging). Held by `logging`. */
export interface LoggingConfig {
  /**
   * How much the SDK logs. Default `warn`, which is silent on a healthy page. It is the only
   * authority over what is written: `debug` does not change it.
   */
  readonly level?: LogLevel;
  /** Where log lines go. Default: the browser console, each line prefixed `[Rubicon]`. */
  readonly logger?: RubiconLogger;
  /** Hears what became of each event: queued, sent or dropped. Meant for debug builds and tests. */
  readonly eventObserver?: EventObserver;
  /**
   * Whether the SDK sends the automatic `SDK Diagnostics` event, at most once an hour and only when
   * it dropped events or met problems. Default `true`.
   */
  readonly sendDiagnostics?: boolean;
}

/** Requests the SDK sends (Configuration 5). Held by `network`. */
export interface NetworkConfig {
  /**
   * Headers added to every SDK request, for example a gateway token of an on-prem deployment. Empty
   * by default. A header the SDK sets itself cannot be replaced: `Authorization`, `Content-Type`,
   * `Content-Encoding`, `Content-Length`, `User-Agent`, `Host`, `If-None-Match` and any name
   * starting with `X-Rubicon-`, in any letter case; such a header is ignored with a warning. The
   * backend's CORS preflight answer must allow every name given here, or the browser sends no
   * request at all (Web Configuration 4).
   *
   * @example
   * ```ts
   * network: { headers: { 'X-Gateway-Token': gatewayToken } }
   * ```
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The platform-neutral configuration (Configuration 2, Web Configuration 1, 6): what every platform
 * has. Only `apiKey` is required; a missing group, or a missing setting inside a group, takes its
 * default. The SDK copies what it needs when it is created and keeps nothing of this object, so a
 * later change to it, to a group, an array or the headers never reaches the SDK.
 */
export interface CoreConfig {
  /**
   * The project's key. It is public by nature on the web, visible in the page and its requests: a
   * publishable key. A missing or blank key makes the SDK do nothing, with an error line.
   */
  readonly apiKey: string;
  /**
   * The base URL of the analytics server. Default `https://api.rubicon.example`; on-prem and proxy
   * setups set their own, with an `http` or `https` scheme and an optional path, such as
   * `https://intranet.example.com/analytics`. Trailing slashes are ignored; otherwise the text is
   * used as given. A value with surrounding white space, a query, a fragment or user info makes the
   * SDK do nothing, with an error line. `http://` logs a warning, and on an `https` page an error,
   * since the browser blocks the requests as mixed content.
   */
  readonly host?: string;
  /**
   * Whether developer mistakes, such as an invalid setting or an unsupported property value, are
   * written to the console as `console.error(new Error(...))`, red and with a stack. Default `false`;
   * the SDK never reads it from the environment, so wire it from your build, for example
   * `debug: import.meta.env.DEV`. It adds no line, changes no log level and never throws.
   */
  readonly debug?: boolean;
  /**
   * Hooks that see each event, in order, before it is stored. Empty by default; fixed when the SDK
   * is created.
   */
  readonly beforeSend?: readonly BeforeSend[];
  /** When events are uploaded. */
  readonly flush?: FlushConfig;
  /** Which events the SDK captures by itself. */
  readonly autocapture?: AutocaptureConfig;
  /** What goes into each event's `context`. */
  readonly context?: CoreContextConfig;
  /** Consent. */
  readonly privacy?: PrivacyConfig;
  /** The SDK's own log lines and health reports. */
  readonly logging?: LoggingConfig;
  /** Requests the SDK sends. */
  readonly network?: NetworkConfig;
}
