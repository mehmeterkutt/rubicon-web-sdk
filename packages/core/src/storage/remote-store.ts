import type { JsonObject, JsonValue } from '../json';
import { jsonObjectFromEntries } from '../json';
import type { Log } from '../log';
import type { KeyValueStorage } from '../platform';
import { StoreRecord } from './store-record';
import type { StoreAccess, StoreCodec, StoreRead, WriteResult } from './store-record';

/**
 * The last valid remote configuration (Configuration 1, Web Configuration 5), shared by the tabs of
 * the origin; its values are read in step 5.3.
 */
export interface RemoteConfigRecord {
  /** The `ETag` of the answer, sent back as `If-None-Match`. */
  readonly etag: string | undefined;
  /** The response object as received (Android log 4.1, 5.3). */
  readonly values: JsonObject;
  /**
   * The time of the last successful fetch, epoch ms: a page load fetches only when it is more than
   * five minutes old (Web Configuration 5).
   */
  readonly fetchedAt: number | undefined;
}

const ETAG = 'etag';
const VALUES = 'values';
// Named by the user, not the pages (plan section 15, step 4.1).
const FETCHED_AT = 'fetched_at';

/** The record's fields, in the order they are written. */
export const REMOTE_FIELDS = [ETAG, VALUES, FETCHED_AT] as const;

const EMPTY: RemoteConfigRecord = { etag: undefined, values: {}, fetchedAt: undefined };

function remoteCodec(): StoreCodec<RemoteConfigRecord> {
  return {
    name: 'remote',
    initial: EMPTY,
    whole: true,
    decode(fields) {
      const values: [string, JsonValue][] = [];
      fields.objectEntries(VALUES).forEach((value, key) => values.push([key, value]));
      return {
        etag: fields.optionalString(ETAG),
        values: jsonObjectFromEntries(values),
        fetchedAt: fields.optionalInteger(FETCHED_AT),
      };
    },
    encode(record) {
      return { [ETAG]: record.etag, [VALUES]: record.values, [FETCHED_AT]: record.fetchedAt };
    },
  };
}

/**
 * `rubicon.<keyHash>.remote`: written whole by the page that fetched (Web Disk 3, Configuration 5),
 * never over an unreadable record, which leaves the page without a cache (Android log 4.1).
 */
export class RemoteStore {
  private readonly record: StoreRecord<RemoteConfigRecord>;

  constructor(keyHash: string, storage: KeyValueStorage, access: StoreAccess, log: Log) {
    this.record = new StoreRecord(keyHash, storage, access, log, remoteCodec());
  }

  get key(): string {
    return this.record.key;
  }

  /** A fresh read; `missing` and `unreadable` both mean no cache. */
  read(): StoreRead<RemoteConfigRecord> {
    return this.record.read();
  }

  /** Replaces the record with `record` in one `setItem`. */
  save(record: RemoteConfigRecord): WriteResult {
    return this.record.write(() => record);
  }

  /** Deletes the record (a 404, Android log 5.3). */
  remove(): boolean {
    return this.record.remove();
  }
}
