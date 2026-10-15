import { CONTEXT_FIELDS } from '../context/context-field';
import type { ContextField } from '../context/context-field';
import type { BeforeSend } from '../event/before-send';
import { isReservedHeader } from '../http/headers';
import type { IssueCodeAt } from '../log/issue-code';
import type { Log } from '../log/log';
import { LOG_LEVELS } from '../log/types';
import type { EventObserver, LogLevel, RubiconLogger } from '../log/types';
import type { PageScheme, UrlParser } from '../platform/page';
import { FLUSH_AT, FLUSH_INTERVAL_MS, INACTIVITY_TIMEOUT_MS } from './config-snapshot';
import type { AppValues, ConfigSnapshot, LogSettings, NumericSetting } from './config-snapshot';
import { checkHost, hostProblemText, hostSecurity } from './hosts';
import type { HostSecurity } from './hosts';
import { AUTOCAPTURE_TYPES, CONSENTS, DEFAULT_HOST } from './types';
import type { Autocapture, Consent } from './types';

/**
 * One problem the validator found (Configuration 3, Web Configuration 1). Its text, the log message
 * without the code, names settings, types and bounds, never the API key, a header value or the text of an invalid host (Logging 4a).
 */
export type ConfigIssue =
  | {
      readonly level: 'warn';
      readonly code: IssueCodeAt<'warn'>;
      readonly text: string;
      readonly developerError: boolean;
    }
  | {
      readonly level: 'error';
      readonly code: IssueCodeAt<'error'>;
      readonly text: string;
      readonly developerError: boolean;
    };

/** The validator's answer: the snapshot, or `undefined` when the SDK must not start, and the issues. */
export interface ConfigValidation {
  /** `undefined` for a missing or blank key or an invalid host: the factory returns the no-op. */
  readonly snapshot: ConfigSnapshot | undefined;
  /** What the `Log` needs to report the issues, the developer's logger and level included. */
  readonly logSettings: LogSettings;
  readonly issues: readonly ConfigIssue[];
}

/** What validation takes from the platform: the URL parser and the page's scheme. */
export interface ConfigEnvironment {
  readonly urls: UrlParser;
  readonly pageScheme: PageScheme;
}

// The CLEARTEXT_HOST messages of Web Logging 3, word for word.
const BLOCKED_MESSAGE =
  'The host uses http://, which the browser blocks from an https page as mixed content; ' +
  'nothing is sent until host uses https://.';
const CLEARTEXT_MESSAGE = 'The host uses http://; events travel unencrypted.';

/**
 * Validates a configuration and builds its snapshot by hand (Configuration 3, Web Configuration 1,
 * 4): every setting is read once, through a `try`, from an `unknown` input, so a plain JavaScript
 * caller's mistakes, a throwing getter or a `Proxy` included, become issues and never exceptions.
 *
 * - A missing or blank `apiKey`, or an invalid `host` (a value that is not a string included):
 *   no snapshot, an ERROR.
 * - A number out of bounds: clamped, `SETTING_OUT_OF_BOUNDS`.
 * - A setting of the wrong type, a value outside its closed set or a group that is not an object:
 *   the default, `SETTING_WRONG_TYPE`; an invalid array element or header drops only itself.
 * - `session.backgroundTimeoutMs`, the Android and iOS setting: not applied, `SETTING_NOT_SUPPORTED`.
 * - A reserved header: dropped, `RESERVED_HEADER`.
 * - An `http` host: `CLEARTEXT_HOST`, an ERROR when the page is `https` and the browser blocks it.
 *
 * `undefined` means "not given" everywhere; any other value is checked. Settings this function does
 * not know are ignored. Arrays and the headers are copied, functions kept by reference, and nothing
 * of the input is kept (Web Configuration 1). Nothing is frozen.
 */
export function validateConfig(input: unknown, environment: ConfigEnvironment): ConfigValidation {
  const reader = new SettingsReader();
  const root = reader.root(input);

  const apiKey = reader.apiKey(root);
  const host = reader.host(root, environment);
  const debug = reader.boolean(root, 'debug', false);
  // A function is kept by reference; what it does when called is checked where it is called.
  const beforeSend = (reader.callbacks(root, 'beforeSend') ?? []) as BeforeSend[];

  const flush = reader.group(root, 'flush');
  const flushAt = reader.integer(flush, 'at', FLUSH_AT);
  const flushIntervalMs = reader.integer(flush, 'intervalMs', FLUSH_INTERVAL_MS);
  const immediateEvents = new Set(reader.strings(flush, 'immediateEvents') ?? []);

  const session = reader.group(root, 'session');
  const inactivityTimeoutMs = reader.integer(session, 'inactivityTimeoutMs', INACTIVITY_TIMEOUT_MS);
  reader.notSupported(session, 'backgroundTimeoutMs', 'session.inactivityTimeoutMs');

  const autocaptureGroup = reader.group(root, 'autocapture');
  const autocapture = new Set<Autocapture>(
    reader.members(autocaptureGroup, 'enabled', AUTOCAPTURE_TYPES) ?? AUTOCAPTURE_TYPES,
  );

  const context = reader.group(root, 'context');
  const disabledFields = new Set<ContextField>(reader.members(context, 'disabledFields', CONTEXT_FIELDS) ?? []);
  const appGroup = reader.group(context, 'app');
  const app: AppValues = {
    name: reader.text(appGroup, 'name'),
    version: reader.text(appGroup, 'version'),
    namespace: reader.text(appGroup, 'namespace'),
  };
  const page = reader.group(context, 'page');
  const pageQueryParams = unique(reader.strings(page, 'queryParams') ?? []);
  const pageTitle = reader.boolean(page, 'title', false);

  const identity = reader.group(root, 'identity');
  const crossSubdomain = reader.boolean(identity, 'crossSubdomain', true);
  const cookieDomain = reader.text(identity, 'cookieDomain');

  const privacy = reader.group(root, 'privacy');
  const defaultConsent: Consent = reader.member(privacy, 'defaultConsent', CONSENTS, 'granted');
  const persistConsent = reader.boolean(privacy, 'persistConsent', true);

  const logging = reader.group(root, 'logging');
  const logSettings: LogSettings = {
    level: reader.member<LogLevel>(logging, 'level', LOG_LEVELS, 'warn'),
    debug,
    logger: reader.callback(logging, 'logger') as RubiconLogger | undefined,
    eventObserver: reader.callback(logging, 'eventObserver') as EventObserver | undefined,
  };
  const sendDiagnostics = reader.boolean(logging, 'sendDiagnostics', true);

  const network = reader.group(root, 'network');
  const headers = reader.headers(network, 'headers');

  const snapshot: ConfigSnapshot | undefined =
    apiKey === undefined || host === undefined
      ? undefined
      : {
          apiKey,
          host: host.host,
          batchUrl: `${host.host}/v1/batch`,
          configUrl: `${host.host}/v1/config`,
          hostSecurity: host.security,
          debug,
          beforeSend,
          flushAt,
          flushIntervalMs,
          immediateEvents,
          inactivityTimeoutMs,
          autocapture,
          disabledFields,
          app,
          pageQueryParams,
          pageTitle,
          crossSubdomain,
          cookieDomain,
          defaultConsent,
          persistConsent,
          logging: logSettings,
          sendDiagnostics,
          headers,
          toString: () => `ConfigSnapshot(host=${host.host}, debug=${String(debug)})`,
        };
  return { snapshot, logSettings, issues: reader.issues };
}

/**
 * Logs the issues in the order found, each with its code, and then, when the SDK starts, the
 * effective host once at INFO (Configuration 3, Web Configuration 4). A developer error is marked so
 * that `debug` changes only its form in the default sink; nothing throws (Web Public API 4).
 */
export function reportConfig(validation: ConfigValidation, log: Log): void {
  for (const issue of validation.issues) {
    const options = { developerError: issue.developerError };
    if (issue.level === 'error') log.error(issue.code, () => issue.text, options);
    else log.warn(issue.code, () => issue.text, options);
  }
  const { snapshot } = validation;
  if (snapshot !== undefined) log.info(() => `Sending to ${snapshot.host}`);
}

/** A group being read: its object, or `undefined` when absent or invalid, and its dotted path. */
interface Group {
  readonly source: object | undefined;
  readonly path: string;
}

/** Any function, before the call site's type is given to it. */
type AnyFunction = (...args: never[]) => unknown;

/** A value read from the input: what the getter gave, or `unreadable` when reading it threw. */
type Read = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function read(source: object, key: string): Read {
  try {
    return { ok: true, value: (source as Readonly<Record<string, unknown>>)[key] };
  } catch {
    return { ok: false };
  }
}

function isArray(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    // A revoked Proxy.
    return false;
  }
}

// A plain object by its tag: `Map`, `Headers`, a `Date` or a function are not groups.
function isObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || isArray(value)) return false;
  try {
    return Object.prototype.toString.call(value) === '[object Object]';
  } catch {
    return false;
  }
}

/** What a wrong value is, for the message: its kind, never its content (Logging 4a). */
function describe(found: Read): string {
  if (!found.ok) return 'unreadable';
  const value = found.value;
  if (value === null) return 'null';
  if (isArray(value)) return 'an array';
  switch (typeof value) {
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (!Number.isFinite(value)) return 'not finite';
      return Number.isInteger(value) ? 'a number' : 'a fractional number';
    case 'string':
      return 'a string';
    case 'boolean':
      return 'a boolean';
    case 'function':
      return 'a function';
    case 'undefined':
      return 'undefined';
    case 'object':
      return 'an object';
    default:
      return `a ${typeof value}`;
  }
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

function unique(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (out.indexOf(value) < 0) out.push(value);
  return out;
}

/** Reads settings from an `unknown` input and collects the issues, in reading order. */
class SettingsReader {
  readonly issues: ConfigIssue[] = [];

  root(input: unknown): Group {
    return { source: isObject(input) ? input : undefined, path: '' };
  }

  /** The group `key` of `parent`: absent, an object, or the defaults with `SETTING_WRONG_TYPE`. */
  group(parent: Group, key: string): Group {
    const path = this.path(parent, key);
    const found = this.value(parent, key);
    if (found === undefined) return { source: undefined, path };
    if (found.ok && isObject(found.value)) return { source: found.value, path };
    this.wrongType(path, found, 'an object', 'its defaults are used');
    return { source: undefined, path };
  }

  apiKey(root: Group): string | undefined {
    const found = this.value(root, 'apiKey');
    if (found !== undefined && found.ok && typeof found.value === 'string') {
      if (found.value.trim() !== '') return found.value;
      this.error('INVALID_API_KEY', 'The API key is blank; the SDK does nothing.');
      return undefined;
    }
    this.error('INVALID_API_KEY', 'The API key is missing or not a string; the SDK does nothing.');
    return undefined;
  }

  host(root: Group, environment: ConfigEnvironment): { host: string; security: HostSecurity } | undefined {
    const found = this.value(root, 'host');
    if (found === undefined) return { host: DEFAULT_HOST, security: 'encrypted' };
    // A host of another type is an invalid host, never the default: data would go elsewhere.
    if (!found.ok || typeof found.value !== 'string') {
      this.error('INVALID_HOST', `host is ${describe(found)}, not a string; the SDK does nothing.`);
      return undefined;
    }
    const check = checkHost(found.value, environment.urls);
    if (!check.valid) {
      this.error('INVALID_HOST', `host ${hostProblemText(check.problem)}; the SDK does nothing.`);
      return undefined;
    }
    const security = hostSecurity(check.url, environment.pageScheme);
    if (security === 'blocked') this.error('CLEARTEXT_HOST', BLOCKED_MESSAGE, false);
    else if (security === 'cleartext') this.warn('CLEARTEXT_HOST', CLEARTEXT_MESSAGE, false);
    return { host: check.host, security };
  }

  boolean(group: Group, key: string, fallback: boolean): boolean {
    const found = this.value(group, key);
    if (found === undefined) return fallback;
    if (found.ok && typeof found.value === 'boolean') return found.value;
    this.wrongType(this.path(group, key), found, 'a boolean', `the default ${String(fallback)} is used`);
    return fallback;
  }

  /** A whole number, clamped to its bounds (Configuration 3). */
  integer(group: Group, key: string, setting: NumericSetting): number {
    const path = this.path(group, key);
    const found = this.value(group, key);
    if (found === undefined) return setting.defaultValue;
    if (!found.ok || typeof found.value !== 'number' || !Number.isInteger(found.value)) {
      this.wrongType(path, found, 'a whole number', `the default ${String(setting.defaultValue)} is used`);
      return setting.defaultValue;
    }
    const value = found.value;
    if (value >= setting.min && value <= setting.max) return value;
    const clamped = value < setting.min ? setting.min : setting.max;
    this.warn(
      'SETTING_OUT_OF_BOUNDS',
      `${path} is ${String(value)}, outside ${String(setting.min)} to ${String(setting.max)}; ${String(clamped)} is used.`,
    );
    return clamped;
  }

  /** A value of a closed set (Web Event Model 5). */
  member<T extends string>(group: Group, key: string, members: readonly T[], fallback: T): T {
    const found = this.value(group, key);
    if (found === undefined) return fallback;
    if (found.ok && isMember(members, found.value)) return found.value;
    this.warn(
      'SETTING_WRONG_TYPE',
      `${this.path(group, key)} is not one of ${quoted(members)}; the default "${fallback}" is used.`,
    );
    return fallback;
  }

  text(group: Group, key: string): string | undefined {
    const found = this.value(group, key);
    if (found === undefined) return undefined;
    if (found.ok && typeof found.value === 'string') return found.value;
    this.wrongType(this.path(group, key), found, 'a string', 'it is not used');
    return undefined;
  }

  callback(group: Group, key: string): AnyFunction | undefined {
    const found = this.value(group, key);
    if (found === undefined) return undefined;
    if (found.ok && typeof found.value === 'function') return found.value as AnyFunction;
    this.wrongType(this.path(group, key), found, 'a function', 'it is not used');
    return undefined;
  }

  strings(group: Group, key: string): string[] | undefined {
    return this.list(group, key, 'a string', (value): value is string => typeof value === 'string');
  }

  callbacks(group: Group, key: string): AnyFunction[] | undefined {
    return this.list(group, key, 'a function', (value): value is AnyFunction => typeof value === 'function');
  }

  /** An array of a closed set; a value outside it drops only itself (Web Lifecycle 8, Web Logging 3). */
  members<T extends string>(group: Group, key: string, members: readonly T[]): T[] | undefined {
    const path = this.path(group, key);
    const elements = this.elements(group, key);
    if (elements === undefined) return undefined;
    const out: T[] = [];
    elements.forEach((element, index) => {
      if (element.ok && isMember(members, element.value)) out.push(element.value);
      else
        this.warn('SETTING_WRONG_TYPE', `${path}[${String(index)}] is not one of ${quoted(members)}; it is dropped.`);
    });
    return out;
  }

  /** `network.headers`: string values, reserved names removed (Configuration 5). */
  headers(group: Group, key: string): Readonly<Record<string, string>> {
    const path = this.path(group, key);
    const out = Object.create(null) as Record<string, string>;
    const found = this.value(group, key);
    if (found === undefined) return out;
    if (!found.ok || !isObject(found.value)) {
      this.wrongType(path, found, 'an object of strings', 'no header is added');
      return out;
    }
    const source = found.value;
    let names: string[];
    try {
      names = Object.keys(source);
    } catch {
      this.wrongType(path, { ok: false }, 'an object of strings', 'no header is added');
      return out;
    }
    for (const name of names) {
      // Header names are logged, never values (Logging 4a).
      const value = read(source, name);
      if (!value.ok || typeof value.value !== 'string') {
        this.wrongType(`${path}["${name}"]`, value, 'a string', 'it is dropped');
      } else if (isReservedHeader(name)) {
        this.warn(
          'RESERVED_HEADER',
          `network.headers: "${name}" is set by the SDK and cannot be replaced; it is ignored.`,
        );
      } else {
        out[name] = value.value;
      }
    }
    return out;
  }

  /** A setting of another platform, given anyway: not applied (Web Session 3). */
  notSupported(group: Group, key: string, replacement: string): void {
    if (this.value(group, key) === undefined) return;
    this.warn(
      'SETTING_NOT_SUPPORTED',
      `${this.path(group, key)} is not a web setting and is not applied; use ${replacement}.`,
    );
  }

  private list<T>(
    group: Group,
    key: string,
    expected: string,
    accepts: (value: unknown) => value is T,
  ): T[] | undefined {
    const path = this.path(group, key);
    const elements = this.elements(group, key);
    if (elements === undefined) return undefined;
    const out: T[] = [];
    elements.forEach((element, index) => {
      if (element.ok && accepts(element.value)) out.push(element.value);
      else this.wrongType(`${path}[${String(index)}]`, element, expected, 'it is dropped');
    });
    return out;
  }

  /** The elements of an array setting, each read on its own; `undefined` when absent or no array. */
  private elements(group: Group, key: string): Read[] | undefined {
    const found = this.value(group, key);
    if (found === undefined) return undefined;
    if (found.ok && isArray(found.value)) {
      const array = found.value;
      const length = read(array, 'length');
      if (length.ok && typeof length.value === 'number') {
        const out: Read[] = [];
        for (let index = 0; index < length.value; index++) out.push(read(array, String(index)));
        return out;
      }
    }
    this.wrongType(this.path(group, key), found, 'an array', 'the default is used');
    return undefined;
  }

  /** The value of `key`, or `undefined` when the group is absent or the value is `undefined`. */
  private value(group: Group, key: string): Read | undefined {
    if (group.source === undefined) return undefined;
    const found = read(group.source, key);
    return found.ok && found.value === undefined ? undefined : found;
  }

  private path(group: Group, key: string): string {
    return group.path === '' ? key : `${group.path}.${key}`;
  }

  private wrongType(path: string, found: Read, expected: string, outcome: string): void {
    this.warn('SETTING_WRONG_TYPE', `${path} is ${describe(found)}, not ${expected}; ${outcome}.`);
  }

  private warn(code: IssueCodeAt<'warn'>, text: string, developerError = true): void {
    this.issues.push({ level: 'warn', code, text, developerError });
  }

  private error(code: IssueCodeAt<'error'>, text: string, developerError = true): void {
    this.issues.push({ level: 'error', code, text, developerError });
  }
}

function isMember<T extends string>(members: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (members as readonly string[]).indexOf(value) >= 0;
}
