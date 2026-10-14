import { jsonObjectFromEntries } from '../json';
import type { JsonValue } from '../json';
import type { Log } from '../log';
import type { KeyValueStorage } from '../platform';
import { StoreRecord } from './store-record';
import type { StoreAccess, StoreChange, StoreCodec, StoreRead, WriteResult } from './store-record';

/**
 * What belongs to the person using the browser, cleared by `reset()` and `clearLocalData()`
 * (Identity 5), in `rubicon.<keyHash>.person` (Web Identity 4). A new stored value goes here unless
 * it should carry over when another person logs in; then it belongs to `.device`. The open session
 * lives in the session cookie, not here (Web Session 2). `person-store.test.ts` pins the exact keys.
 */
export interface PersonState {
  /** `null` while anonymous; the identity cookie is the authority (Web Identity 1). */
  readonly userId: string | null;
  /** Normalized values as `register` stored them; `null` is a value (Web Identity 2). */
  readonly superProperties: ReadonlyMap<string, JsonValue>;
  /** The `device_id` this record belongs to; another id in the cookie makes it stale (Web Privacy 3). */
  readonly deviceId: string | undefined;
}

export const ANONYMOUS: PersonState = { userId: null, superProperties: /*#__PURE__*/ new Map(), deviceId: undefined };

const USER_ID = 'user_id';
const SUPER_PROPERTIES = 'super_properties';
const DEVICE_ID = 'device_id';

/** The record's fields, in the order they are written. */
export const PERSON_FIELDS = [USER_ID, SUPER_PROPERTIES, DEVICE_ID] as const;

function personCodec(): StoreCodec<PersonState> {
  return {
    name: 'person',
    initial: ANONYMOUS,
    decode(fields) {
      return {
        userId: fields.optionalString(USER_ID) ?? null,
        superProperties: fields.objectEntries(SUPER_PROPERTIES),
        deviceId: fields.optionalNonBlankString(DEVICE_ID),
      };
    },
    encode(state) {
      const entries: [string, JsonValue][] = [];
      state.superProperties.forEach((value, key) => entries.push([key, value]));
      // `user_id` is written as `null` while anonymous, as Android's `person.json`.
      return {
        [USER_ID]: state.userId,
        [SUPER_PROPERTIES]: jsonObjectFromEntries(entries),
        [DEVICE_ID]: state.deviceId,
      };
    },
  };
}

/**
 * `rubicon.<keyHash>.person`, the port of the Android `PersonStore` over a {@link StoreRecord}:
 * read fresh, written by merge. A super property is merged by its own key, so two pages that
 * `register` different keys both keep theirs (Web Disk 3).
 */
export class PersonStore {
  private readonly record: StoreRecord<PersonState>;

  constructor(keyHash: string, storage: KeyValueStorage, access: StoreAccess, log: Log) {
    this.record = new StoreRecord(keyHash, storage, access, log, personCodec());
  }

  get key(): string {
    return this.record.key;
  }

  /** A fresh read. */
  read(): StoreRead<PersonState> {
    return this.record.read();
  }

  /** The fresh record, anonymous when missing or unreadable, with this page's pending changes. */
  get state(): PersonState {
    return this.record.state;
  }

  update(change: StoreChange<PersonState>): void {
    this.record.update(change);
  }

  /** Queues one super property, merged by its key. */
  register(key: string, value: JsonValue): void {
    this.record.update((state) => {
      const superProperties = new Map(state.superProperties);
      superProperties.set(key, value);
      return { ...state, superProperties };
    });
  }

  /** Queues the removal of one super property. */
  unregister(key: string): void {
    this.record.update((state) => {
      if (!state.superProperties.has(key)) return state;
      const superProperties = new Map(state.superProperties);
      superProperties.delete(key);
      return { ...state, superProperties };
    });
  }

  persist(): WriteResult {
    return this.record.persist();
  }

  write(change: StoreChange<PersonState>): WriteResult {
    return this.record.write(change);
  }

  /** Deletes the record: stale, `clearLocalData()` (Web Privacy 3). */
  remove(): boolean {
    return this.record.remove();
  }
}
