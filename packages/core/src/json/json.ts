/**
 * A JSON value as this layer writes and reads it. The `PropertyValue` tree of Web Public API 4 (step
 * 2.5) is one: the writer takes the normalized tree as it is.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/**
 * A JSON object. A key whose value is `undefined` is absent when written, as an unset optional
 * field (Web Public API 4), so context groups and store records need no filtering of their own.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/**
 * The compact JSON text of `value`: one event line, or one store record (Web Serialization 1).
 *
 * The only place besides {@link readJsonObject} that calls the engine's JSON (source rule `json`).
 * Plain `JSON.stringify`, no replacer: the normalizer of step 2.5 has already turned every value
 * into plain objects, arrays and primitives, so no `toJSON` runs and nothing is left to convert.
 * What the engine does with the rest is pinned by tests, so a different engine is noticed:
 *
 * - `null` is written, `{"coupon":null}`; a key holding `undefined` is left out;
 * - numbers are ECMAScript's shortest round-trip text: `50.0` as `50`, `49.9` as `49.9`, `1e21` as
 *   `1e+21` (Android `1.0E21`, the backend parses numbers as doubles), `-0` as `0`;
 * - `NaN` and `Infinity` would be written as `null`, silently: the normalizer drops them first;
 * - `/` is not escaped; control characters are, so a line never holds a raw line break, but U+2028
 *   and U+2029 are written as they are, so JSON Lines are split on `\n` only;
 * - a lone surrogate is escaped by current engines and written raw by those on the floor that
 *   predate well-formed `JSON.stringify`: the normalizer replaces it with U+FFFD first;
 * - integer-like keys come first in an object; nothing may depend on key order.
 */
export function writeJson(value: JsonObject): string {
  return JSON.stringify(value);
}

/**
 * Parses `text` as one JSON object; `undefined` when it is not valid JSON, is not an object (an
 * array, a string, `null`), or has anything but whitespace after the object. `JSON.parse` itself
 * rejects trailing content, which `org.json` ignored (Android log 2.4), so such a stored line is
 * corrupt here as well.
 *
 * Reading exists for the store records (Web Disk 3, 5) and for the checks of stored lines in
 * {@link checkLine}; events are never parsed back into objects otherwise (Serialization 1).
 */
export function readJsonObject(text: string): JsonFields | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isObject(parsed) ? new JsonFields(parsed) : undefined;
}

/**
 * Typed, checked access to a parsed JSON object, the port of the Android `JsonFields`. Every getter
 * gives `undefined` when the key is missing, holds JSON `null`, or holds a value of another type;
 * nothing is coerced, so the string `"123"` is not a number and a number is not a string. Unknown
 * keys stay in the object (Web Disk 5): {@link JsonFields.toObject} and {@link mergeJsonObject}
 * keep them when a record is written back.
 */
export class JsonFields {
  constructor(private readonly record: JsonObject) {}

  /** The object's own keys. */
  get keys(): string[] {
    return Object.keys(this.record);
  }

  has(key: string): boolean {
    return hasOwn(this.record, key);
  }

  /** Whether `key` is present with the JSON value `null`. */
  isNull(key: string): boolean {
    return this.value(key) === null;
  }

  /** The value of `key` as parsed, of any type; `undefined` when absent. */
  value(key: string): JsonValue | undefined {
    return hasOwn(this.record, key) ? this.record[key] : undefined;
  }

  string(key: string): string | undefined {
    const value = this.value(key);
    return typeof value === 'string' ? value : undefined;
  }

  boolean(key: string): boolean | undefined {
    const value = this.value(key);
    return typeof value === 'boolean' ? value : undefined;
  }

  /**
   * A whole number within the safe integer range, the counterpart of Android's `long`: `1.5` and
   * `1e30` give `undefined`. JavaScript has one number type, so `50.0` in the text reads as `50`,
   * where Android would read a `Double`; the writer never writes `50.0`.
   */
  integer(key: string): number | undefined {
    const value = this.value(key);
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
  }

  /** Any finite number; `1e400` parses to `Infinity` and gives `undefined`. */
  number(key: string): number | undefined {
    const value = this.value(key);
    return typeof value === 'number' && isFinite(value) ? value : undefined;
  }

  /** A nested object, with the same typed access. */
  fields(key: string): JsonFields | undefined {
    const value = this.object(key);
    return value === undefined ? undefined : new JsonFields(value);
  }

  /** A nested object as parsed. */
  object(key: string): JsonObject | undefined {
    const value = this.value(key);
    return isObject(value) ? value : undefined;
  }

  /** A nested array as parsed. */
  array(key: string): readonly JsonValue[] | undefined {
    const value = this.value(key);
    return Array.isArray(value) ? (value as readonly JsonValue[]) : undefined;
  }

  /** The whole object as parsed, unknown keys included. */
  toObject(): JsonObject {
    return this.record;
  }
}

/**
 * A new object with the own keys of `base` and then of `changes`; a change to `undefined` removes
 * the key. The field-level merge of a store write keeps every key it does not change, so fields of
 * another SDK version survive (Web Disk 3, 5). Keys are defined, never assigned, so a stored
 * `__proto__` key stays a field rather than becoming the prototype.
 */
export function mergeJsonObject(base: JsonObject, changes: JsonObject): JsonObject {
  const merged: Record<string, JsonValue> = {};
  const define = (key: string, value: JsonValue | undefined): void => {
    if (value !== undefined)
      Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
  };
  for (const key of Object.keys(base)) define(key, hasOwn(changes, key) ? changes[key] : base[key]);
  for (const key of Object.keys(changes)) if (!hasOwn(base, key)) define(key, changes[key]);
  return merged;
}

/** What a stored line holds, as far as the queue needs to know without parsing the event. */
export type StoredLine =
  | {
      readonly kind: 'event';
      readonly messageId: string;
      /** The event's time, epoch milliseconds, for the line-by-line age check (Web Disk 2). */
      readonly timestamp: number;
      /** `undefined` when missing or not a string: the device check is the caller's (Web Privacy 3). */
      readonly deviceId: string | undefined;
    }
  | {
      readonly kind: 'corrupt';
      /** For the log line when it can be read; never the content (Disk 5, Logging 4a). */
      readonly messageId: string | undefined;
    };

/**
 * Checks one stored line, the Android `FileEventStore.parse`: an event is a JSON object with a
 * string `type`, a string `message_id` and a whole-number `timestamp`; anything else is corrupt
 * (Disk 5, Web Disk 5). The checks the pages name need these fields only: corruption, the age of a
 * partly expired chunk (Web Disk 2) and the `device_id` after `clearLocalData()` (Web Privacy 3).
 */
export function checkLine(line: string): StoredLine {
  const fields = readJsonObject(line);
  if (fields === undefined) return { kind: 'corrupt', messageId: undefined };
  const messageId = fields.string('message_id');
  const timestamp = fields.integer('timestamp');
  if (fields.string('type') === undefined || messageId === undefined || timestamp === undefined) {
    return { kind: 'corrupt', messageId };
  }
  return { kind: 'event', messageId, timestamp, deviceId: fields.string('device_id') };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
