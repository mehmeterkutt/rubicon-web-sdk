import type { Log } from '../log';
import type { KeyValueStorage } from '../platform';
import { StoreRecord } from './store-record';
import type { StoreAccess, StoreChange, StoreCodec, StoreRead, WriteResult } from './store-record';

/**
 * The kinds of a server pause: Android's `pause_kind` without `transient`, which stays in `.device`
 * on the web (Android log 4.1, Web Retry 1): `throttle` for 429 (group C), `config` for the
 * server-caused configuration problems (group E, Web Retry 4).
 */
export const PAUSE_KINDS = ['throttle', 'config'] as const;

export type PauseKind = (typeof PAUSE_KINDS)[number];

/** A server pause shared by every page of the origin (Web Retry 1, point 3). */
export interface PauseRecord {
  /** No upload starts before this time, epoch ms. */
  readonly until: number;
  readonly kind: PauseKind;
  /**
   * `keyHash` of the configured `host`, trailing slashes removed (plan section 15, step 4.1); a page
   * configured with another host ignores the pause.
   */
  readonly host: string;
}

const UNTIL = 'until';
const KIND = 'kind';
const HOST = 'host';

/** The record's fields, in the order they are written. */
export const PAUSE_FIELDS = [UNTIL, KIND, HOST] as const;

function pauseCodec(): StoreCodec<PauseRecord | undefined> {
  return {
    name: 'pause',
    initial: undefined,
    decode(fields) {
      return {
        until: fields.requiredInteger(UNTIL),
        kind: fields.requiredChoice(KIND, PAUSE_KINDS),
        host: fields.requiredString(HOST),
      };
    },
    encode(record) {
      return { [UNTIL]: record?.until, [KIND]: record?.kind, [HOST]: record?.host };
    },
  };
}

/**
 * `rubicon.<keyHash>.pause` (Web Retry 1, Web Disk 3 as changed on 2026-10-14): its own key, so no
 * transient, success or counter write can erase a server pause. Only a page that received such a
 * result writes it; the rules for the later end, the read back and the host are the retry policy's
 * (step 5.2), which writes through {@link write} with a change computed from the fresh record.
 */
export class PauseStore {
  private readonly record: StoreRecord<PauseRecord | undefined>;

  constructor(keyHash: string, storage: KeyValueStorage, access: StoreAccess, log: Log) {
    this.record = new StoreRecord(keyHash, storage, access, log, pauseCodec());
  }

  get key(): string {
    return this.record.key;
  }

  /** A fresh read; in this page's memory while it may not be written (Web Logging 4). */
  read(): StoreRead<PauseRecord | undefined> {
    return this.record.read();
  }

  /** The fresh record with this page's pauses that could not be written. */
  get state(): PauseRecord | undefined {
    return this.record.state;
  }

  /** Applies `change` to the fresh record and writes it now in one `setItem`. */
  write(change: StoreChange<PauseRecord | undefined>): WriteResult {
    return this.record.write(change);
  }

  /** Deletes the record (`clearLocalData()` while refused, Web Logging 4). */
  remove(): boolean {
    return this.record.remove();
  }
}
