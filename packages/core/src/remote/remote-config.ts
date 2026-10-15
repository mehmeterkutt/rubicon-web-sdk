import type { ConfigSnapshot } from '../config/config-snapshot';
import { FLUSH_AT, FLUSH_INTERVAL_MS } from '../config/config-snapshot';
import { AUTOCAPTURE_TYPES } from '../config/types';
import type { Autocapture } from '../config/types';
import { readJsonObject } from '../json';
import type { JsonObject, JsonValue } from '../json';
import type { Log } from '../log';

/**
 * The remote configuration after validation against the code's own values (Configuration 1, Web
 * Configuration 5): it can only restrict. An absent value means "no remote value". The contract is
 * Android's `docs/remote-config.md`.
 */
export interface RemoteConfig {
  /** `false` is the kill switch; `true` changes nothing. */
  readonly enabled: boolean;
  /** Autocapture types to switch off, from the web's three (Web Lifecycle 8, Web Configuration 6). */
  readonly autocaptureOff: ReadonlySet<Autocapture>;
  readonly flushAt?: number;
  readonly flushIntervalMs?: number;
  /** The share of devices that collect at all, by `device_id`. */
  readonly sampleRate?: number;
  /** The share of devices that send `SDK Diagnostics`, by `device_id` (Logging 5). */
  readonly diagnosticsSampleRate?: number;
}

/** No remote values: the code alone decides. */
export const NO_REMOTE_CONFIG: RemoteConfig = { enabled: true, autocaptureOff: /*#__PURE__*/ new Set<Autocapture>() };

const ENABLED = 'enabled';
const AUTOCAPTURE_OFF = 'autocapture_off';
const FLUSH_AT_KEY = 'flush_at';
const FLUSH_INTERVAL_MS_KEY = 'flush_interval_ms';
const SAMPLE_RATE = 'sample_rate';
const DIAGNOSTICS_SAMPLE_RATE = 'diagnostics_sample_rate';

/** The response body as an object, or `undefined` when it is not one JSON object (Android log 5.3). */
export function parseRemoteBody(body: string): JsonObject | undefined {
  return readJsonObject(body)?.toObject();
}

/**
 * Validates `values`, a stored or fetched response, against `code`, the Android `RemoteConfig.from`.
 * A known key with an invalid value, or one that would widen what the code allows, is ignored with
 * `REMOTE_CONFIG_INVALID_VALUE` (once per key and page); an unknown key or autocapture type, perhaps
 * for a newer SDK or another platform, is ignored at DEBUG. Saved values go through this again at
 * every page load, so a stricter release is never widened by an old response.
 */
export function readRemoteConfig(values: JsonObject, code: ConfigSnapshot, log: Log): RemoteConfig {
  let config: RemoteConfig = NO_REMOTE_CONFIG;
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined) continue;
    const next = readKey(config, key, value, code, log);
    if (next === undefined) invalid(key, log);
    else config = next;
  }
  return config;
}

/** `code` restricted by `remote`: the snapshot the page runs with until the next page load. */
export function restrictConfig(code: ConfigSnapshot, remote: RemoteConfig): ConfigSnapshot {
  const autocapture = new Set<Autocapture>();
  code.autocapture.forEach((type) => {
    if (!remote.autocaptureOff.has(type)) autocapture.add(type);
  });
  return {
    ...code,
    autocapture,
    flushAt: remote.flushAt ?? code.flushAt,
    flushIntervalMs: remote.flushIntervalMs ?? code.flushIntervalMs,
  };
}

// The configuration with `key` applied; `undefined` when the value is invalid, an unknown key
// changing nothing.
function readKey(
  config: RemoteConfig,
  key: string,
  value: JsonValue,
  code: ConfigSnapshot,
  log: Log,
): RemoteConfig | undefined {
  switch (key) {
    case ENABLED:
      return typeof value === 'boolean' ? { ...config, enabled: value } : undefined;
    case AUTOCAPTURE_OFF: {
      const off = autocaptureOff(value, log);
      return off === undefined ? undefined : { ...config, autocaptureOff: off };
    }
    case FLUSH_AT_KEY: {
      const at = wholeNumber(value);
      return at !== undefined && within(at, FLUSH_AT.min, FLUSH_AT.max) && at >= code.flushAt
        ? { ...config, flushAt: at }
        : undefined;
    }
    case FLUSH_INTERVAL_MS_KEY: {
      const interval = wholeNumber(value);
      return interval !== undefined &&
        within(interval, FLUSH_INTERVAL_MS.min, FLUSH_INTERVAL_MS.max) &&
        interval >= code.flushIntervalMs
        ? { ...config, flushIntervalMs: interval }
        : undefined;
    }
    case SAMPLE_RATE: {
      const rate = rateOf(value);
      return rate === undefined ? undefined : { ...config, sampleRate: rate };
    }
    case DIAGNOSTICS_SAMPLE_RATE: {
      // With `sendDiagnostics` off in code, any rate above 0 would widen it.
      const rate = rateOf(value);
      return rate !== undefined && (code.sendDiagnostics || rate === 0)
        ? { ...config, diagnosticsSampleRate: rate }
        : undefined;
    }
    default:
      log.debug(() => `Remote configuration: ignored the unknown key "${key}"`);
      return config;
  }
}

function invalid(key: string, log: Log): void {
  log.warn(
    'REMOTE_CONFIG_INVALID_VALUE',
    () => `Remote configuration: "${key}" is invalid or would widen what the app's code allows; it is ignored`,
    { repeatKey: key },
  );
}

// A list of strings, or `undefined` when it is not one; a type the web does not have is ignored at
// DEBUG, as a type of a newer SDK is (Web Configuration 6).
function autocaptureOff(value: JsonValue, log: Log): ReadonlySet<Autocapture> | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value as readonly JsonValue[];
  if (names.some((name) => typeof name !== 'string')) return undefined;
  const off = new Set<Autocapture>();
  for (const name of names as readonly string[]) {
    const type = AUTOCAPTURE_TYPES.find((member) => member === name);
    if (type === undefined) log.debug(() => `Remote configuration: ignored the unknown autocapture type "${name}"`);
    else off.add(type);
  }
  return off;
}

// Android's `Int` and `Long`: a safe integer. JSON has one number type, so `50.0` reads as 50 here,
// where Android reads a `Double` and rejects it (plan section 15, step 5.3).
function wholeNumber(value: JsonValue): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function rateOf(value: JsonValue): number | undefined {
  return typeof value === 'number' && within(value, 0, 1) ? value : undefined;
}

function within(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}
