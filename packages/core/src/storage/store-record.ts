import { mergeJsonObject, readJsonObject, writeJson } from '../json';
import type { JsonObject } from '../json';
import type { Log } from '../log';
import type { KeyValueStorage } from '../platform';
import { decodeOrUndefined, StrictFields } from './store-fields';

/** The names of the five store records of Web Disk 2: `rubicon.<keyHash>.<name>`. */
export const STORE_NAMES = ['device', 'person', 'remote', 'consent', 'pause'] as const;

export type StoreName = (typeof STORE_NAMES)[number];

/** The `localStorage` key of a store record (Web Identity 4, Web Disk 2). */
export function storeKey(keyHash: string, name: StoreName): string {
  return `rubicon.${keyHash}.${name}`;
}

/**
 * The format version every store record carries as `"v"` (Disk 7, Android log 4.1). A record with
 * another version is unreadable; one with a higher version comes from a newer SDK on another page
 * of the origin and is left as it is (Web Disk 5). Raising it is a design discussion (Web Disk 5).
 */
export const STORE_VERSION = 1;

/**
 * What the stores may touch, shared by the stores of one instance and changed by the privacy and
 * startup code (steps 6.5, 6.7, 7.2):
 *
 * - `full`: consent granted; every store is read fresh and written.
 * - `consent`: consent pending or refused; only the consent record is read and written, the other
 *   stores live in this page's memory (Web Privacy 1, Web Logging 4).
 * - `none`: the memory-only mode (Web Disk 4); nothing is read or written.
 *
 * Changes made while a store may not be written stay pending in memory and are merged into the
 * fresh record by the first write after access becomes `full`, counters as increments, which is how
 * a pending page's counters reach `.device` on `optIn()` (Web Logging 5).
 */
export interface StoreAccess {
  level: 'full' | 'consent' | 'none';
}

/** Turns one record's state into its fields and back; `"v"` is the {@link StoreRecord}'s. */
export interface StoreCodec<S> {
  readonly name: StoreName;
  /** The state of a missing record, and the base this page's changes apply to while it is unreadable. */
  readonly initial: S;
  /** `true` for the consent mirror, which is used while consent is pending or refused as well. */
  readonly consentRecord?: boolean;
  /** `true` for `.remote`, written whole by the page that fetched it (Web Disk 3, Configuration 5). */
  readonly whole?: boolean;
  /** The state of a stored record; a missing or wrongly typed field throws through {@link StrictFields}. */
  decode(fields: StrictFields): S;
  /**
   * The record's known fields for `state`, `undefined` for an absent one. `stored` is the fresh
   * record, so that a nested object keeps the fields it does not know (Web Disk 5).
   */
  encode(state: S, stored: StrictFields | undefined): JsonObject;
}

/** One change of this page to a store's state, applied to the fresh record when it is written. */
export type StoreChange<S> = (state: S) => S;

/** A fresh read of a store record (Identity 1: missing and unreadable are different states). */
export type StoreRead<S> =
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'present'; readonly state: S };

/**
 * What a write did: `written` with one `setItem`; `unchanged` when the record already held the
 * result, so nothing was written; `held` when the record may not be written now (access, or an
 * unreadable record) and the changes stay in this page's memory; `failed` when `setItem` threw.
 */
export type WriteResult = 'written' | 'unchanged' | 'held' | 'failed';

type Stored<S> =
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'present'; readonly state: S; readonly text: string; readonly fields: StrictFields };

/**
 * One store record in `localStorage`, the web form of the Android `StoreFile` (Disk 7, Web Disk 3).
 *
 * Storage, not memory, is the source of truth: several pages of the origin write the same record.
 * Memory keeps only this page's pending changes. Every write is one synchronous task: a fresh read,
 * this page's changes applied to what was read, a field-level merge that keeps every field this
 * SDK does not know, and one `setItem`. Changes queued with {@link update} are coalesced into the
 * next {@link persist}, which the writer calls in its slices and on hiding (Android log 6.7).
 *
 * A record that cannot be read (access throws, not a JSON object, another `"v"`, a field of the
 * wrong type) is never written: this page's changes stay in memory and its {@link state} is built
 * from them, one `STORE_UNREADABLE` per record and page (Disk 7, Web Disk 5). A `setItem` that
 * throws (`QuotaExceededError`, `SecurityError`) logs `STORAGE_WRITE_FAILED` and keeps the pending
 * changes for the next write. Nothing here throws.
 */
export class StoreRecord<S> {
  readonly key: string;

  // The store's name for log lines, which never pass a `.name` (source rule `log-content`).
  private readonly label: string;
  private pending: StoreChange<S>[] = [];
  private cache: Stored<S> | undefined;
  private reportedUnreadable = false;

  constructor(
    keyHash: string,
    private readonly storage: KeyValueStorage,
    private readonly access: StoreAccess,
    private readonly log: Log,
    private readonly codec: StoreCodec<S>,
  ) {
    this.key = storeKey(keyHash, codec.name);
    this.label = codec.name;
  }

  /** Whether this record is read and written at the current access level. */
  get usesStorage(): boolean {
    const level = this.access.level;
    return level === 'full' || (level === 'consent' && this.codec.consentRecord === true);
  }

  /** A fresh read; `missing` while the record may not be read. */
  read(): StoreRead<S> {
    const stored = this.readStored();
    return stored.status === 'present' ? { status: 'present', state: stored.state } : stored;
  }

  /** The fresh record, or the initial state when it is missing or unreadable, with this page's changes. */
  get state(): S {
    const stored = this.readStored();
    const base = stored.status === 'present' ? stored.state : this.codec.initial;
    return this.apply(base, this.pending);
  }

  /** Whether `change` is still waiting to be written. */
  isPending(change: StoreChange<S>): boolean {
    return this.pending.indexOf(change) >= 0;
  }

  /** Queues a change for the next {@link persist}; it shows in {@link state} at once. */
  update(change: StoreChange<S>): void {
    this.pending.push(change);
  }

  /** Writes the pending changes, if any. */
  persist(): WriteResult {
    return this.store(undefined, false);
  }

  /**
   * Writes the pending changes and `change` now, in one `setItem`. When `setItem` throws, `change`
   * is dropped and the pending changes are kept: the caller decides whether to try again, as the
   * diagnostics checkpoint must not be applied twice (Web Logging 5). While the record may not be
   * written, `change` joins the pending changes in memory. `quiet` leaves out the failure line, for
   * a write made while a line is being logged.
   */
  write(change: StoreChange<S>, options: { readonly quiet?: boolean } = {}): WriteResult {
    return this.store(change, options.quiet === true);
  }

  /**
   * Deletes the record and drops the pending changes; `false` when `removeItem` threw. A deliberate
   * erasure (a stale `.person`, `clearLocalData()`), so an unreadable record is deleted as well.
   */
  remove(): boolean {
    this.pending = [];
    this.cache = undefined;
    if (!this.usesStorage) return true;
    try {
      this.storage.removeItem(this.key);
      return true;
    } catch (error) {
      this.log.error('STORAGE_WRITE_FAILED', () => `Could not delete the ${this.label} store`, { error });
      return false;
    }
  }

  private store(extra: StoreChange<S> | undefined, quiet: boolean): WriteResult {
    const changes = extra === undefined ? this.pending : this.pending.concat([extra]);
    if (changes.length === 0) return 'unchanged';
    const stored = this.usesStorage ? this.readStored() : undefined;
    if (stored === undefined || stored.status === 'unreadable') {
      if (extra !== undefined) this.pending.push(extra);
      return 'held';
    }
    const present = stored.status === 'present' ? stored : undefined;
    const next = this.apply(present === undefined ? this.codec.initial : present.state, changes);
    const record = this.encode(next, present?.fields);
    const text = writeJson(record);
    if (present !== undefined && text === present.text) {
      this.pending = [];
      return 'unchanged';
    }
    try {
      this.storage.setItem(this.key, text);
    } catch (error) {
      if (!quiet) {
        const kept = extra === undefined ? 'kept in memory and written later' : 'not stored';
        this.log.error('STORAGE_WRITE_FAILED', () => `Could not write the ${this.label} store; the change is ${kept}`, {
          error,
        });
      }
      return 'failed';
    }
    this.pending = [];
    return 'written';
  }

  private encode(state: S, stored: StrictFields | undefined): JsonObject {
    const known = mergeJsonObject({ v: STORE_VERSION }, this.codec.encode(state, stored));
    // Field-level merge over the fresh record keeps fields of other SDK versions (Web Disk 3, 5);
    // `.remote` is replaced whole by the page that fetched it (Configuration 5).
    return stored === undefined || this.codec.whole === true ? known : mergeJsonObject(stored.fields.toObject(), known);
  }

  private apply(base: S, changes: readonly StoreChange<S>[]): S {
    let state = base;
    for (const change of changes) state = change(state);
    return state;
  }

  private readStored(): Stored<S> {
    if (!this.usesStorage) return { status: 'missing' };
    let text: string | null;
    try {
      text = this.storage.getItem(this.key);
    } catch (error) {
      return this.unreadable(error);
    }
    if (text === null) return { status: 'missing' };
    // Parsing is skipped while the text is unchanged: a cost measure, every read is still fresh.
    if (this.cache !== undefined && this.cache.status === 'present' && this.cache.text === text) return this.cache;
    const json = readJsonObject(text);
    const fields = json === undefined ? undefined : new StrictFields(json);
    const state =
      fields === undefined || json?.integer('v') !== STORE_VERSION
        ? undefined
        : decodeOrUndefined(() => this.codec.decode(fields));
    if (fields === undefined || state === undefined) return this.unreadable(undefined);
    this.cache = { status: 'present', state, text, fields };
    return this.cache;
  }

  private unreadable(error: unknown): Stored<S> {
    if (!this.reportedUnreadable) {
      this.reportedUnreadable = true;
      this.log.warn(
        'STORE_UNREADABLE',
        () =>
          `The ${this.label} store exists but cannot be read; this page keeps its values in memory and leaves the record untouched`,
        { error, repeatKey: this.label },
      );
    }
    return { status: 'unreadable' };
  }
}
