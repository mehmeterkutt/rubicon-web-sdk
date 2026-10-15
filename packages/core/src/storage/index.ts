// The key-value stores (step 4.1): the port of the Android `internal/store` package over the
// origin's `localStorage`, written by fresh read, field-level merge and one `setItem` (Web Disk 3).
// The event chunks (step 4.2): the port of the Android `FileEventStore` as immutable self-describing
// keys (Web Disk 2).
export { CHUNK_FORMAT, chunkId, chunkKey, MARKER_FORMAT, MARKER_VALUE, markerKey, parseQueueKey } from './chunk-key';
export type { ChunkName, ParsedQueueKey } from './chunk-key';
export {
  batchBody,
  ChunkStore,
  KEEPALIVE_BUDGET_BYTES,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_EVENT_AGE_MS,
  MAX_PENDING_EVENTS,
  MAX_QUEUE_MEASURE,
  TRIM_TO_EVENTS,
  TRIM_TO_MEASURE,
} from './chunk-store';
export type {
  BatchLine,
  BatchOptions,
  BatchResult,
  ChunkInfo,
  ChunkLine,
  ChunkStoreOptions,
  ChunkWriteResult,
  DropCounter,
} from './chunk-store';
export { cookieValues } from './cookie-text';
export { CONSENT_DECISIONS, CONSENT_FIELDS, ConsentStore } from './consent-store';
export type { ConsentDecision, ConsentRecord } from './consent-store';
export {
  DAILY_LOG_WINDOW_MS,
  DEVICE_FIELDS,
  DeviceStore,
  DIAGNOSTICS_FIELDS,
  NO_DIAGNOSTICS,
  NO_RETRY,
  RETRY_FIELDS,
  SUSPECT_FIELDS,
} from './device-store';
export type { DeviceState, DiagnosticsState, RetryState, SuspectState } from './device-store';
export { PAUSE_FIELDS, PAUSE_KINDS, PauseStore } from './pause-store';
export type { PauseKind, PauseRecord } from './pause-store';
export { ANONYMOUS, PERSON_FIELDS, PersonStore } from './person-store';
export type { PersonState } from './person-store';
export { REMOTE_FIELDS, RemoteStore } from './remote-store';
export type { RemoteConfigRecord } from './remote-store';
export { MemoryKeyValueStorage } from './memory-key-value-storage';
export { MAX_COUNT } from './store-fields';
export { STORE_NAMES, STORE_VERSION, storeKey, StoreRecord } from './store-record';
export type { StoreAccess, StoreChange, StoreCodec, StoreName, StoreRead, WriteResult } from './store-record';
export { Stores } from './stores';
export type { StoresOptions } from './stores';
