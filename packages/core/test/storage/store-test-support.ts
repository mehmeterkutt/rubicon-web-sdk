import { MemoryStorage, RecordingSink, TestClock } from 'rubicon-analytics-testing';
import { keyHash, Log, storeKey, Stores } from '../../src';
import type { IssueCode, LogLevel, StoreAccess, StoreName } from '../../src';

/** The key hash of the test API key; every store key of these tests is under it. */
export const KEY_HASH = keyHash('test-api-key');

/** One simulated page: its own `Log` and stores over a storage area shared with other pages. */
export interface TestPage {
  readonly storage: MemoryStorage;
  readonly sink: RecordingSink;
  readonly log: Log;
  readonly stores: Stores;
  /** The record as stored, parsed by `JSON.parse`; `undefined` when missing. */
  stored(name: StoreName): Record<string, unknown> | undefined;
  /** The raw stored text. */
  raw(name: StoreName): string | null;
  /** Whether a WARN or ERROR line of `code` was written at its own level. */
  logged(code: IssueCode): boolean;
}

/**
 * Opens a page as the factory will (step 6.7): the `Log` first, counting issues through the device
 * store, then the stores, which give the `Log` its `per_24h` limit.
 */
export function openPage(
  storage: MemoryStorage = new MemoryStorage(),
  clock: TestClock = new TestClock(),
  options: { readonly level?: LogLevel; readonly access?: StoreAccess['level'] } = {},
): TestPage {
  const sink = new RecordingSink();
  const holder: { stores?: Stores } = {};
  const log = new Log({
    level: options.level ?? 'debug',
    debug: false,
    sink,
    issues: { increment: (code) => holder.stores?.device.issueCounter.increment(code) },
  });
  const stores = new Stores({ keyHash: KEY_HASH, storage, log, clock, access: options.access });
  holder.stores = stores;
  const raw = (name: StoreName): string | null => storage.area.entries.get(storeKey(KEY_HASH, name)) ?? null;
  return {
    storage,
    sink,
    log,
    stores,
    raw,
    stored(name) {
      const text = raw(name);
      return text === null ? undefined : (JSON.parse(text) as Record<string, unknown>);
    },
    logged(code) {
      return sink.lines.some((line) => line.level !== 'debug' && line.message.startsWith(`${code}:`));
    },
  };
}

/** Writes `text` as the stored record `name`, as another SDK version or another script would. */
export function plant(storage: MemoryStorage, name: StoreName, text: string): void {
  storage.area.entries.set(storeKey(KEY_HASH, name), text);
}
