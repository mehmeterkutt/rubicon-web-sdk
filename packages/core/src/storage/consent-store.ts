import type { Log } from '../log';
import type { KeyValueStorage } from '../platform';
import { StoreRecord } from './store-record';
import type { StoreAccess, StoreCodec, StoreRead, WriteResult } from './store-record';

/** A stored consent decision: Android's stored values (Android log 4.1), never `pending`. */
export const CONSENT_DECISIONS = ['granted', 'denied'] as const;

export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

/**
 * The user's decision and its time (Web Privacy 2, Web Logging 4): never an identifier. The cookie
 * `rubicon_<keyHash>_c` is the authority (step 6.5); this record is its mirror.
 */
export interface ConsentRecord {
  readonly state: ConsentDecision;
  /** Epoch ms; the later decision wins a conflict between the cookie and the mirror. */
  readonly decidedAt: number;
}

const STATE = 'state';
const DECIDED_AT = 'decided_at';

/** The record's fields, in the order they are written. */
export const CONSENT_FIELDS = [STATE, DECIDED_AT] as const;

// The codec's initial state is never written alone: a decision always replaces both fields.
function consentCodec(): StoreCodec<ConsentRecord | undefined> {
  return {
    name: 'consent',
    initial: undefined,
    consentRecord: true,
    decode(fields) {
      return { state: fields.requiredChoice(STATE, CONSENT_DECISIONS), decidedAt: fields.requiredInteger(DECIDED_AT) };
    },
    encode(record) {
      return { [STATE]: record?.state, [DECIDED_AT]: record?.decidedAt };
    },
  };
}

/**
 * `rubicon.<keyHash>.consent`, the mirror of the consent cookie (Web Disk 3, Web Privacy 2): its own
 * key, written only when consent changes, so no counter, retry or person write can undo an opt-out.
 * It is read and written while consent is pending or refused as well; in the memory-only mode the
 * decision is per page.
 */
export class ConsentStore {
  private readonly record: StoreRecord<ConsentRecord | undefined>;

  constructor(keyHash: string, storage: KeyValueStorage, access: StoreAccess, log: Log) {
    this.record = new StoreRecord(keyHash, storage, access, log, consentCodec());
  }

  get key(): string {
    return this.record.key;
  }

  /** A fresh read; the stored decision is `state` when present. */
  read(): StoreRead<ConsentRecord | undefined> {
    return this.record.read();
  }

  /** Writes `decision` now, by fresh read and merge. */
  save(decision: ConsentRecord): WriteResult {
    return this.record.write(() => decision);
  }
}
