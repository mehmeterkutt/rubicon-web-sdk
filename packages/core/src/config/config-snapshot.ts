import type { ContextField } from '../context/context-field';
import type { BeforeSend } from '../event/before-send';
import type { EventObserver, LogLevel, RubiconLogger } from '../log/types';
import type { HostSecurity } from './hosts';
import type { Autocapture, Consent } from './types';

/** A numeric setting's default and its inclusive bounds (Configuration 3). */
export interface NumericSetting {
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}

/** `flush.at`: 30, from 1 to 100 (Queue 2, Web Queue 4). */
export const FLUSH_AT: NumericSetting = { defaultValue: 30, min: 1, max: 100 };

/** `flush.intervalMs`: five seconds on the web, from one second to ten minutes (Web Queue 4). */
export const FLUSH_INTERVAL_MS: NumericSetting = { defaultValue: 5_000, min: 1_000, max: 600_000 };

/** `session.inactivityTimeoutMs`: 30 minutes, from one minute to two hours (Web Session 3). */
export const INACTIVITY_TIMEOUT_MS: NumericSetting = { defaultValue: 1_800_000, min: 60_000, max: 7_200_000 };

/** The settings the `Log` is made of, known even when the configuration does not start the SDK. */
export interface LogSettings {
  readonly level: LogLevel;
  readonly debug: boolean;
  readonly logger?: RubiconLogger;
  readonly eventObserver?: EventObserver;
}

/** `context.app`: the values of `context.app.*`, each absent unless given (Web Context 3). */
export interface AppValues {
  readonly name?: string;
  readonly version?: string;
  readonly namespace?: string;
}

/**
 * The validated copy of a configuration that the SDK reads (Configuration 4, Web Configuration 1),
 * every setting of the public `AnalyticsConfig` included, the browser-only ones of `web` too: the
 * core reads most of them, and none needs the DOM. Built by hand by the validator from the caller's
 * object, of which it keeps nothing but function references; collections are its own copies. Not
 * frozen: nothing outside the SDK holds it. Numbers are within their bounds, the host is normalized,
 * reserved headers are removed.
 */
export interface ConfigSnapshot {
  readonly apiKey: string;
  /** The normalized base URL, without trailing slashes. */
  readonly host: string;
  /** `{host}/v1/batch`. */
  readonly batchUrl: string;
  /** `{host}/v1/config`. */
  readonly configUrl: string;
  /** How this page reaches the host; `blocked` keeps the uploader in configuration failure. */
  readonly hostSecurity: HostSecurity;
  readonly debug: boolean;
  readonly beforeSend: readonly BeforeSend[];
  readonly flushAt: number;
  readonly flushIntervalMs: number;
  readonly immediateEvents: ReadonlySet<string>;
  readonly inactivityTimeoutMs: number;
  readonly autocapture: ReadonlySet<Autocapture>;
  readonly disabledFields: ReadonlySet<ContextField>;
  readonly app: AppValues;
  /** `context.page.queryParams`, duplicates removed, in the order given. */
  readonly pageQueryParams: readonly string[];
  readonly pageTitle: boolean;
  readonly crossSubdomain: boolean;
  /** `identity.cookieDomain` as given; whether the browser takes it is decided at the probe (step 7.2). */
  readonly cookieDomain?: string;
  readonly defaultConsent: Consent;
  readonly persistConsent: boolean;
  readonly logging: LogSettings;
  readonly sendDiagnostics: boolean;
  /** The headers of `network.headers` that may be sent, in a null-prototype object. */
  readonly headers: Readonly<Record<string, string>>;
  /** The host only: never the API key or header values (Logging 4a, Web Configuration 1). */
  toString(): string;
}
