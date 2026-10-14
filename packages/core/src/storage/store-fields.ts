import type { JsonFields, JsonValue } from '../json';

/**
 * The largest counter value: counts saturate here instead of growing without bound, Android's
 * `Int.MAX_VALUE` (Android log 4.1, iOS log 4.1), so the three platforms report the same number.
 */
export const MAX_COUNT = 2_147_483_647;

// Control flow only, caught by `decodeOrUndefined`; never leaves this module's callers.
class CorruptRecord extends Error {}

/**
 * The strict reading of a store record, the port of the Android `StoreFields`: a field that is
 * missing or JSON `null` is absent and takes its default; a field of the wrong type makes the whole
 * record unreadable (Android log 4.1), so it is never overwritten (Disk 7, Web Disk 5). Unknown
 * fields are not read here; the record keeps them when it is written back.
 */
export class StrictFields {
  constructor(readonly fields: JsonFields) {}

  optionalString(key: string): string | undefined {
    return this.absent(key) ? undefined : (this.fields.string(key) ?? corrupt());
  }

  /** A string that is not empty or white space only. */
  optionalNonBlankString(key: string): string | undefined {
    const value = this.optionalString(key);
    return value !== undefined && value.trim() === '' ? corrupt() : value;
  }

  requiredString(key: string): string {
    return this.optionalString(key) ?? corrupt();
  }

  /** A whole number in the safe range, the counterpart of Android's `long`. */
  optionalInteger(key: string): number | undefined {
    return this.absent(key) ? undefined : (this.fields.integer(key) ?? corrupt());
  }

  requiredInteger(key: string): number {
    return this.optionalInteger(key) ?? corrupt();
  }

  /** One of `allowed`; any other text, such as a value a newer SDK added, makes the record unreadable. */
  optionalChoice<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    const value = this.optionalString(key);
    if (value === undefined) return undefined;
    const found = allowed.find((choice) => choice === value);
    return found ?? corrupt();
  }

  requiredChoice<T extends string>(key: string, allowed: readonly T[]): T {
    return this.optionalChoice(key, allowed) ?? corrupt();
  }

  optionalFields(key: string): StrictFields | undefined {
    if (this.absent(key)) return undefined;
    const nested = this.fields.fields(key);
    return nested === undefined ? corrupt() : new StrictFields(nested);
  }

  /** An object of any JSON values, such as the super properties; empty when absent. */
  objectEntries(key: string): Map<string, JsonValue> {
    const nested = this.optionalFields(key);
    const entries = new Map<string, JsonValue>();
    if (nested === undefined) return entries;
    for (const name of nested.fields.keys) {
      const value = nested.fields.value(name);
      if (value !== undefined) entries.set(name, value);
    }
    return entries;
  }

  /** An object of non-negative whole numbers, such as counters; empty when absent. */
  counts(key: string): Map<string, number> {
    const nested = this.optionalFields(key);
    const counts = new Map<string, number>();
    if (nested === undefined) return counts;
    for (const name of nested.fields.keys) {
      const value = nested.fields.integer(name);
      if (value === undefined || value < 0) corrupt();
      counts.set(name, value);
    }
    return counts;
  }

  /** An object whose every value is an object, read by `read`; empty when absent. */
  records<T>(key: string, read: (fields: StrictFields) => T): Map<string, T> {
    const nested = this.optionalFields(key);
    const records = new Map<string, T>();
    if (nested === undefined) return records;
    for (const name of nested.fields.keys) {
      const value = nested.fields.fields(name);
      if (value === undefined) corrupt();
      records.set(name, read(new StrictFields(value)));
    }
    return records;
  }

  private absent(key: string): boolean {
    return !this.fields.has(key) || this.fields.isNull(key);
  }
}

/** The value `decode` reads, or `undefined` when a field made the record unreadable. */
export function decodeOrUndefined<T>(decode: () => T): T | undefined {
  try {
    return decode();
  } catch (error) {
    if (error instanceof CorruptRecord) return undefined;
    throw error;
  }
}

function corrupt(): never {
  throw new CorruptRecord();
}
