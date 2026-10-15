import {
  MemoryStorage,
  MemoryStorageArea,
  parseWithPython,
  quotaExceededError,
  RecordingSink,
  ScriptedRandom,
  SeededRandom,
  TestClock,
} from 'rubicon-analytics-testing';
import { afterAll, describe, expect, it } from 'vitest';
import {
  chunkKey,
  ChunkStore,
  KEEPALIVE_BUDGET_BYTES,
  keyHash,
  Log,
  MAX_EVENT_AGE_MS,
  MAX_QUEUE_MEASURE,
  markerKey,
  MemoryKeyValueStorage,
  parseQueueKey,
  utf8ByteLength,
} from '../../src';
import type { BatchResult, ChunkInfo, ChunkLine, DropReason, IssueCode, KeyValueStorage, StoreAccess } from '../../src';
import { KEY_HASH, openPage as openStores } from './store-test-support';

// The port of the Android FileEventStoreTest (Disk 1 to 5, Queue 4 and 5, Android log 4.2) for the
// chunks of Web Disk 1, 2, 5 and 6 and Web Queue 2, 5 and 6. Leftover `.tmp` segments, fsync, file
// permissions and the unreadable segment have no counterpart (Web Disk 5: no half-written line, a
// throwing `getItem` deletes nothing); events of another API key are no longer deleted and counted
// (Web Disk 6, no `api_key_changed`).

const NOW = TestClock.DEFAULT_START;
const SENT_AT = NOW + 60_000;
const THREE_DAYS = MAX_EVENT_AGE_MS;
const OTHER_HASH = keyHash('another-api-key');
const PAGE_A = 'aaaaaaaaaaaaaaaa';
const PAGE_B = 'bbbbbbbbbbbbbbbb';

/** Every batch body built in this file, for Python to parse in `afterAll` (Web Serialization 3). */
const bodies: string[] = [];

afterAll(() => {
  const answers = parseWithPython(bodies);
  answers.forEach((answer, i) => {
    const body = bodies[i] ?? '';
    expect(answer, body).toEqual({ ok: true, value: JSON.parse(body) as unknown });
  });
});

/** `KeyValueStorage` over a `MemoryStorage` that records reads and can act between them. */
class WatchedStorage implements KeyValueStorage {
  readonly reads: string[] = [];
  onRead: ((key: string) => void) | undefined;
  /** `setItem` throws a `QuotaExceededError` for the writes this answers `true` for, counted from 0. */
  failWrite: ((index: number) => boolean) | undefined;
  private writes = 0;

  constructor(readonly inner: MemoryStorage) {}

  get length(): number {
    return this.inner.length;
  }

  key(index: number): string | null {
    return this.inner.key(index);
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    this.onRead?.(key);
    return this.inner.getItem(key);
  }

  setItem(key: string, value: string): void {
    const index = this.writes;
    this.writes += 1;
    if (this.failWrite?.(index) === true) throw quotaExceededError();
    this.inner.setItem(key, value);
  }

  removeItem(key: string): void {
    this.inner.removeItem(key);
  }
}

interface Page {
  readonly store: ChunkStore;
  readonly storage: MemoryStorage;
  readonly watched: WatchedStorage;
  readonly sink: RecordingSink;
  readonly access: StoreAccess;
  readonly dropped: Map<DropReason, number>;
  /** Whether a WARN or ERROR line of `code` was written at its own level. */
  logged(code: IssueCode): boolean;
  lines(code: IssueCode): { level: string; message: string }[];
}

function openPage(
  storage: MemoryStorage = new MemoryStorage(),
  options: { readonly clock?: TestClock; readonly level?: StoreAccess['level']; readonly seed?: number } = {},
): Page {
  const sink = new RecordingSink();
  const log = new Log({ level: 'debug', debug: false, sink });
  const dropped = new Map<DropReason, number>();
  const access: StoreAccess = { level: options.level ?? 'full' };
  const watched = new WatchedStorage(storage);
  const store = new ChunkStore({
    keyHash: KEY_HASH,
    storage: watched,
    access,
    log,
    clock: options.clock ?? new TestClock(),
    random: new SeededRandom(options.seed ?? 1),
    drops: {
      count(reason, events) {
        dropped.set(reason, (dropped.get(reason) ?? 0) + events);
      },
    },
  });
  return {
    store,
    storage,
    watched,
    sink,
    access,
    dropped,
    logged: (code) => sink.lines.some((l) => l.level !== 'debug' && l.message.startsWith(`${code}:`)),
    lines: (code) => sink.lines.filter((l) => l.message.startsWith(`${code}:`)),
  };
}

function line(id: string, timestamp: number = NOW, padding = 0): ChunkLine {
  return {
    text: `{"type":"track","event":"E","message_id":"${id}","timestamp":${String(timestamp)},"properties":{"p":"${'x'.repeat(padding)}"}}`,
    timestamp,
  };
}

function messageIdOf(chunkLine: ChunkLine): string {
  return (JSON.parse(chunkLine.text) as { message_id: string }).message_id;
}

function lines(prefix: string, count: number, timestamp: number = NOW): ChunkLine[] {
  return Array.from({ length: count }, (_, i) => line(`${prefix}${String(i)}`, timestamp));
}

/** Writes a chunk as another page or another SDK would; `count` and `chars` from the value. */
function plantChunk(
  storage: MemoryStorage,
  texts: readonly string[],
  options: {
    readonly writtenAt?: number;
    readonly newestEventAt?: number;
    readonly pageId?: string;
    readonly seq?: number;
    readonly hash?: string;
    readonly count?: number;
    readonly chars?: number;
  } = {},
): string {
  const value = texts.map((text) => `${text}\n`).join('');
  const key = chunkKey({
    keyHash: options.hash ?? KEY_HASH,
    writtenAt: options.writtenAt ?? NOW,
    newestEventAt: options.newestEventAt ?? NOW,
    pageId: options.pageId ?? PAGE_B,
    seq: options.seq ?? 0,
    count: options.count ?? texts.length,
    chars: options.chars ?? value.length,
  });
  storage.area.entries.set(key, value);
  return key;
}

function built(result: BatchResult): Extract<BatchResult, { status: 'built' }> {
  if (result.status !== 'built') throw new Error('the batch was not built');
  bodies.push(result.body);
  return result;
}

function batch(page: Page, chunks: readonly ChunkInfo[], maxBytes?: number): Extract<BatchResult, { status: 'built' }> {
  return built(page.store.buildBatch(chunks, { sentAt: SENT_AT, maxBytes }));
}

function walk(page: Page): ChunkInfo[] {
  const chunks = page.store.walk();
  if (chunks === undefined) throw new Error('the walk failed');
  return chunks;
}

function ids(page: Page, chunks: readonly ChunkInfo[]): string[] {
  return batch(page, chunks).lines.map((l) => l.messageId);
}

/** Every message id stored, oldest first, one batch per chunk. */
function allIds(page: Page): string[] {
  return walk(page).reduce<string[]>((all, chunk) => all.concat(ids(page, [chunk])), []);
}

function pending(page: Page): number {
  return walk(page).reduce((sum, chunk) => sum + chunk.count, 0);
}

function queueKeys(storage: MemoryStorage): string[] {
  return Array.from(storage.area.entries.keys()).filter((key) => parseQueueKey(key) !== undefined);
}

describe('ChunkStore', () => {
  describe('the page id', () => {
    it('is 16 hex characters from two draws of the RandomSource', () => {
      const sink = new RecordingSink();
      const store = new ChunkStore({
        keyHash: KEY_HASH,
        storage: new MemoryStorage(),
        access: { level: 'full' },
        log: new Log({ level: 'debug', debug: false, sink }),
        clock: new TestClock(),
        random: new ScriptedRandom([0x0123abcd, 0x9]),
        drops: { count: () => undefined },
      });

      expect(store.pageId).toBe('0123abcd00000009');
    });

    it('differs between two page loads on the same storage', () => {
      const storage = new MemoryStorage();
      expect(openPage(storage, { seed: 1 }).store.pageId).not.toBe(openPage(storage, { seed: 2 }).store.pageId);
    });
  });

  describe('chunks', () => {
    it('are one key and value each, the key describing the value', () => {
      const clock = new TestClock();
      const page = openPage(undefined, { clock });
      const texts = [line('a', NOW - 5), line('ö-💳', NOW - 9), line('c', NOW - 7)];

      expect(page.store.write(texts)).toEqual({ stored: 3, dropped: 0, droppedLines: [] });

      const value = texts.map((l) => `${l.text}\n`).join('');
      const key = `rubicon.${KEY_HASH}.q1.${String(NOW)}.${String(NOW - 5)}.${page.store.pageId}.0.3.${String(value.length)}`;
      expect(page.storage.area.snapshot()).toEqual({ [key]: value });
      expect(page.storage.writeCount).toBe(1);
      // `chars` is the value's length in UTF-16 code units, not bytes: ö is 1 unit and 2 bytes, the
      // card emoji 2 units and 4 bytes.
      expect(utf8ByteLength(value) - value.length).toBe(3);
    });

    it('hold at most 100 events: a write of 250 lines makes three chunks in order', () => {
      const page = openPage();

      page.store.write(lines('e', 250));

      const chunks = walk(page);
      expect(chunks.map((c) => [c.seq, c.count])).toEqual([
        [0, 100],
        [1, 100],
        [2, 50],
      ]);
      expect(allIds(page)).toEqual(lines('e', 250).map((l) => messageIdOf(l)));
    });

    it('never exceed the keepalive budget in their envelope; a line alone always makes a chunk', () => {
      const page = openPage();
      const big = Array.from({ length: 5 }, (_, i) => line(`big${String(i)}`, NOW, 20_000));

      page.store.write(big);

      const chunks = walk(page);
      expect(chunks.map((c) => c.count)).toEqual([2, 2, 1]);
      for (const chunk of chunks) {
        const body = batch(page, [chunk]).body;
        expect(utf8ByteLength(body)).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
      }
    });

    it('are not written for an empty write', () => {
      const page = openPage();

      expect(page.store.write([])).toEqual({ stored: 0, dropped: 0, droppedLines: [] });

      expect(page.storage.area.entries.size).toBe(0);
    });

    it('count seq per page from 0, and a new page load starts its own', () => {
      const clock = new TestClock();
      const storage = new MemoryStorage();
      const first = openPage(storage, { clock, seed: 1 });
      first.store.write([line('a')]);
      first.store.write([line('b')]);
      clock.advanceBy(1);
      const second = openPage(storage, { clock, seed: 2 });
      second.store.write([line('c')]);

      const chunks = walk(second);

      expect(chunks.map((c) => [c.pageId, c.seq, c.own])).toEqual([
        [first.store.pageId, 0, false],
        [first.store.pageId, 1, false],
        [second.store.pageId, 0, true],
      ]);
      expect(chunks.map((c) => c.id)).toEqual(chunks.map((c) => `${c.pageId}.${String(c.seq)}`));
    });

    it('are ordered by writtenAt, pageId and seq, never by the order of key(i)', () => {
      for (const keyOrder of ['insertion', 'reverse'] as const) {
        const storage = new MemoryStorage(new MemoryStorageArea({ keyOrder }));
        plantChunk(storage, [line('b1').text], { pageId: PAGE_B, seq: 1, writtenAt: NOW });
        plantChunk(storage, [line('a2').text], { pageId: PAGE_A, seq: 2, writtenAt: NOW });
        plantChunk(storage, [line('a10').text], { pageId: PAGE_A, seq: 10, writtenAt: NOW });
        plantChunk(storage, [line('late').text], { pageId: PAGE_A, seq: 0, writtenAt: NOW + 1 });
        plantChunk(storage, [line('early').text], { pageId: PAGE_B, seq: 9, writtenAt: NOW - 1 });
        const page = openPage(storage);

        expect(allIds(page), keyOrder).toEqual(['early', 'a2', 'a10', 'b1', 'late']);
      }
    });

    it('1000 events are read back in order', () => {
      const clock = new TestClock();
      const page = openPage(undefined, { clock });
      const all = lines('e', 1000);
      for (let i = 0; i < 1000; i += 7) {
        page.store.write(all.slice(i, i + 7));
        clock.advanceBy(1);
      }

      expect(allIds(page)).toEqual(all.map((l) => messageIdOf(l)));
      expect(page.dropped.size).toBe(0);
    });
  });

  describe('the batch body', () => {
    it('is the stored lines joined, byte for byte', () => {
      const page = openPage();
      const texts = [
        line('a'),
        line('ö-💳'),
        { text: `{"type":"screen","name":"s","message_id":"c","timestamp":${String(NOW)},"x":"\\/"}`, timestamp: NOW },
      ];
      page.store.write(texts);

      const result = batch(page, walk(page));

      expect(result.body).toBe(`{"sent_at":${String(SENT_AT)},"batch":[${texts.map((l) => l.text).join(',')}]}`);
      expect(result.lines.map((l) => l.messageId)).toEqual(['a', 'ö-💳', 'c']);
      const parsed = JSON.parse(result.body) as { sent_at: number; batch: unknown[] };
      expect(parsed.sent_at).toBe(SENT_AT);
      expect(parsed.batch).toHaveLength(3);
    });

    it('of no chunk is an empty batch', () => {
      const result = batch(openPage(), []);

      expect(result.lines).toEqual([]);
      expect(result.chunks).toEqual([]);
      expect(result.body).toBe(`{"sent_at":${String(SENT_AT)},"batch":[]}`);
    });

    it('gives each line its timestamp and device id, for the device check of the uploader', () => {
      const page = openPage();
      page.store.write([
        {
          text: `{"type":"track","event":"E","message_id":"m","timestamp":${String(NOW)},"device_id":"d-1"}`,
          timestamp: NOW,
        },
      ]);

      expect(batch(page, walk(page)).lines).toEqual([
        {
          text: `{"type":"track","event":"E","message_id":"m","timestamp":${String(NOW)},"device_id":"d-1"}`,
          messageId: 'm',
          timestamp: NOW,
          deviceId: 'd-1',
        },
      ]);
    });

    it('takes whole chunks, oldest first, up to 100 events and the byte limit, the first always', () => {
      const clock = new TestClock();
      const page = openPage(undefined, { clock });
      page.store.write(lines('a', 60));
      clock.advanceBy(1);
      page.store.write(lines('b', 30));
      clock.advanceBy(1);
      page.store.write(lines('c', 20));
      const chunks = walk(page);

      expect(batch(page, chunks).chunks.map((c) => c.count)).toEqual([60, 30]);
      expect(batch(page, chunks.slice(1)).chunks.map((c) => c.count)).toEqual([30, 20]);
      const firstAlone = batch(page, chunks, 10);
      expect(firstAlone.chunks.map((c) => c.count)).toEqual([60]);
      const oneChunk = utf8ByteLength(batch(page, chunks.slice(1, 2)).body);
      expect(batch(page, chunks.slice(1), oneChunk).chunks.map((c) => c.count)).toEqual([30]);
    });
  });

  describe('corrupt lines', () => {
    function pageWithLines(...texts: string[]): Page {
      const storage = new MemoryStorage();
      plantChunk(storage, texts);
      return openPage(storage);
    }

    it('are skipped, logged without content and counted once when the chunk is deleted', () => {
      const page = pageWithLines(
        line('a').text,
        'not json',
        '[1,2]',
        '{"message_id":"no-type","timestamp":1}',
        '{"type":"track","timestamp":1}',
        '{"type":"track","message_id":"secret-id","timestamp":"1"}',
        '{"type":"track","message_id":"x","timestamp":1.5}',
        line('b').text,
      );
      const chunks = walk(page);
      const key = chunks[0]?.key ?? '';

      const result = batch(page, chunks);
      batch(page, chunks);
      page.store.delete(chunks);

      expect(result.lines.map((l) => l.messageId)).toEqual(['a', 'b']);
      expect(result.body).toBe(`{"sent_at":${String(SENT_AT)},"batch":[${line('a').text},${line('b').text}]}`);
      expect(page.dropped.get('corrupt')).toBe(6);
      const corrupt = page.lines('CORRUPT_LINE');
      expect(corrupt[0]).toEqual({
        level: 'error',
        message: `CORRUPT_LINE: Skipped corrupt line 2 of chunk ${key}`,
        developerErrorForm: false,
      });
      expect(corrupt.some((l) => l.message.endsWith(`line 6 of chunk ${key}, message_id secret-id`))).toBe(true);
      expect(corrupt.slice(1).every((l) => l.level === 'debug')).toBe(true);
      expect(corrupt).toHaveLength(6);
      expect(page.sink.messages.some((m) => m.includes('not json'))).toBe(false);
    });

    it('a chunk of corrupt lines only gives an empty batch, and its deletion counts them', () => {
      const page = pageWithLines('x', 'y');
      const chunks = walk(page);

      const result = batch(page, chunks);
      page.store.delete(result.chunks);

      expect(result.lines).toEqual([]);
      expect(result.chunks).toHaveLength(1);
      expect(page.dropped.get('corrupt')).toBe(2);
      expect(queueKeys(page.storage)).toEqual([]);
    });

    it('a value without the final line break and with an empty line reads every line', () => {
      const storage = new MemoryStorage();
      const value = `${line('a').text}\n\n${line('b').text}`;
      storage.area.entries.set(
        chunkKey({
          keyHash: KEY_HASH,
          writtenAt: NOW,
          newestEventAt: NOW,
          pageId: PAGE_B,
          seq: 0,
          count: 3,
          chars: value.length,
        }),
        value,
      );
      const page = openPage(storage);
      const chunks = walk(page);

      expect(batch(page, chunks).lines.map((l) => l.messageId)).toEqual(['a', 'b']);
      page.store.delete(chunks);
      expect(page.dropped.get('corrupt')).toBe(1);
    });
  });

  describe('the key walk', () => {
    it('reads no value: age and capacity come from key names only', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('old', NOW - THREE_DAYS - 1).text], { newestEventAt: NOW - THREE_DAYS - 1 });
      // The key claims 600 events and 600 000 characters; the value holds one line.
      plantChunk(storage, [line('big').text], { seq: 1, writtenAt: NOW + 1, count: 600, chars: 600_000 });
      plantChunk(storage, [line('new').text], { seq: 2, writtenAt: NOW + 2, count: 500 });
      const page = openPage(storage);

      const chunks = walk(page);

      expect(page.watched.reads).toEqual([]);
      expect(page.dropped.get('expired')).toBe(1);
      // 1100 events by the names: the oldest whole chunk goes; 600 counted as queue_full.
      expect(page.dropped.get('queue_full')).toBe(600);
      expect(chunks.map((c) => c.seq)).toEqual([2]);
    });

    it('deletes malformed keys under the exact prefixes with UNKNOWN_FILE and nothing else', () => {
      const storage = new MemoryStorage();
      const host = {
        'host-key': 'v',
        [`rubicon.${KEY_HASH}.device`]: '{"v":1}',
        [`rubicon.${KEY_HASH}.q2.1.2.${PAGE_A}.0.1.1`]: 'x',
      };
      for (const [key, value] of Object.entries(host)) storage.area.entries.set(key, value);
      const malformedOwn = [`rubicon.${KEY_HASH}.q1.junk`, `rubicon.${KEY_HASH}.q1r.junk`];
      const malformedOther = [`rubicon.${OTHER_HASH}.q1.junk`, `rubicon.${OTHER_HASH}.q1r.junk`];
      for (const key of malformedOwn.concat(malformedOther)) storage.area.entries.set(key, 'x');
      const kept = plantChunk(storage, [line('a').text]);
      const page = openPage(storage);

      walk(page);

      expect(Array.from(storage.area.entries.keys()).sort()).toEqual(
        Object.keys(host).concat(malformedOther, [kept]).sort(),
      );
      expect(page.logged('UNKNOWN_FILE')).toBe(true);
      expect(page.sink.messages.some((m) => m.includes('junk'))).toBe(false);
      expect(page.dropped.size).toBe(0);
    });

    it("deletes another key's expired chunks and their markers uncounted, and keeps its others", () => {
      const storage = new MemoryStorage();
      const old = NOW - THREE_DAYS - 1;
      plantChunk(storage, [line('o').text], { hash: OTHER_HASH, pageId: PAGE_A, newestEventAt: old });
      storage.area.entries.set(markerKey(OTHER_HASH, PAGE_A), '');
      const live = plantChunk(storage, [line('l').text], { hash: OTHER_HASH, pageId: PAGE_B });
      const liveMarker = markerKey(OTHER_HASH, PAGE_B);
      storage.area.entries.set(liveMarker, '');
      // Another key's stores are never touched (Web Disk 6).
      storage.area.entries.set(`rubicon.${OTHER_HASH}.device`, '{"v":1}');
      const page = openPage(storage);

      expect(walk(page)).toEqual([]);

      expect(Array.from(storage.area.entries.keys()).sort()).toEqual(
        [live, liveMarker, `rubicon.${OTHER_HASH}.device`].sort(),
      );
      expect(page.dropped.size).toBe(0);
      expect(page.logged('EVENTS_EXPIRED')).toBe(false);
    });

    it('skips a null from key(i) when a key vanishes while it lists them, and deletes nothing for it', () => {
      const storage = new MemoryStorage();
      const gone = plantChunk(storage, [line('gone').text], { seq: 0 });
      plantChunk(storage, [line('kept').text], { seq: 1 });
      // Another page deletes the first key right after it is listed: the indexes shift and key(1)
      // gives null, so this walk misses the second chunk, as a browser's would.
      storage.vanishAfterListing(gone);
      const page = openPage(storage);

      const first = walk(page);
      const result = batch(page, first);
      page.store.delete(first);

      expect(first.map((c) => c.seq)).toEqual([0]);
      expect(result.lines).toEqual([]);
      expect(page.dropped.size).toBe(0);
      expect(walk(page).map((c) => c.seq)).toEqual([1]);
    });

    it('fails without deleting anything when storage cannot be listed', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('old', NOW - THREE_DAYS - 1).text], { newestEventAt: NOW - THREE_DAYS - 1 });
      const page = openPage(storage);
      storage.failAccess = true;

      expect(page.store.walk()).toBeUndefined();

      storage.failAccess = false;
      expect(queueKeys(storage)).toHaveLength(1);
      expect(page.dropped.size).toBe(0);
    });
  });

  describe('the released marker', () => {
    it('is written on release, removed on unrelease, and marks the page as released for other pages', () => {
      const storage = new MemoryStorage();
      const leaving = openPage(storage, { seed: 1 });
      leaving.store.write([line('a')]);
      const other = openPage(storage, { seed: 2 });

      leaving.store.release();

      expect(storage.area.entries.get(markerKey(KEY_HASH, leaving.store.pageId))).toBe('');
      expect(walk(other).map((c) => [c.own, c.released])).toEqual([[false, true]]);
      leaving.store.unrelease();
      expect(walk(other).map((c) => c.released)).toEqual([false]);
      expect(queueKeys(storage)).toHaveLength(1);
    });

    it('is removed by the first page that finds no chunk of that page id', () => {
      const storage = new MemoryStorage();
      const leaving = openPage(storage, { seed: 1 });
      leaving.store.write([line('a')]);
      leaving.store.release();
      const other = openPage(storage, { seed: 2 });
      const chunks = walk(other);

      other.store.delete(chunks);
      expect(storage.area.entries.has(markerKey(KEY_HASH, leaving.store.pageId))).toBe(true);
      walk(other);

      expect(queueKeys(storage)).toEqual([]);
    });

    it('is never written without full access', () => {
      for (const level of ['consent', 'none'] as const) {
        const page = openPage(undefined, { level });
        page.store.release();
        expect(page.storage.area.entries.size).toBe(0);
      }
    });
  });

  describe('age limit', () => {
    it('an event exactly 3 days old is kept, one millisecond older is not', () => {
      const page = openPage();
      page.store.write([line('kept', NOW - THREE_DAYS), line('gone', NOW - THREE_DAYS - 1)]);

      expect(ids(page, walk(page))).toEqual(['kept']);
    });

    it('a chunk whose newest event is exactly 3 days old is kept, one millisecond older is deleted unread', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('kept', NOW - THREE_DAYS).text], { seq: 0, newestEventAt: NOW - THREE_DAYS });
      plantChunk(storage, [line('gone', NOW - THREE_DAYS - 1).text, 'corrupt'], {
        seq: 1,
        newestEventAt: NOW - THREE_DAYS - 1,
      });
      const page = openPage(storage);

      expect(walk(page).map((c) => c.seq)).toEqual([0]);
      expect(page.watched.reads).toEqual([]);
      // Deleted unread: every event of the chunk is counted as expired.
      expect(page.dropped.get('expired')).toBe(2);
      expect(page.logged('EVENTS_EXPIRED')).toBe(true);
    });

    it('a chunk of expired events is deleted by the walk at start and counted', () => {
      const storage = new MemoryStorage();
      const old = NOW - THREE_DAYS - 1;
      plantChunk(
        storage,
        lines('old', 5, old).map((l) => l.text),
        { seq: 0, newestEventAt: old },
      );
      plantChunk(storage, [line('new').text], { seq: 1 });

      const page = openPage(storage);

      expect(walk(page).map((c) => c.seq)).toEqual([1]);
      expect(page.dropped.get('expired')).toBe(5);
      expect(page.logged('EVENTS_EXPIRED')).toBe(true);
    });

    it('the walk before an upload deletes chunks that aged since they were written', () => {
      const clock = new TestClock();
      const page = openPage(undefined, { clock });
      page.store.write([line('a')]);

      clock.advanceBy(THREE_DAYS + 1);

      expect(walk(page)).toEqual([]);
      expect(page.dropped.get('expired')).toBe(1);
    });

    it('expired lines of a partly expired chunk are skipped line by line and counted on deletion', () => {
      const clock = new TestClock();
      const page = openPage(undefined, { clock });
      page.store.write([line('old', NOW - 10), line('new', NOW)]);
      clock.advanceBy(THREE_DAYS - 5);
      const chunks = walk(page);

      expect(ids(page, chunks)).toEqual(['new']);
      expect(page.dropped.get('expired')).toBeUndefined();
      page.store.delete(chunks);
      expect(page.dropped.get('expired')).toBe(1);
    });

    it('events from a clock that was ahead never expire, nor does a future newestEventAt', () => {
      const page = openPage();
      page.store.write([line('future', NOW + THREE_DAYS * 10)]);

      const chunks = walk(page);

      expect(chunks[0]?.newestEventAt).toBe(NOW + THREE_DAYS * 10);
      expect(ids(page, chunks)).toEqual(['future']);
    });
  });

  describe('capacity', () => {
    it('passing 1000 events drops the oldest chunks down to 900 and counts them', () => {
      const page = openPage();

      page.store.write(lines('e', 1000));
      expect(pending(page)).toBe(1000);
      expect(page.dropped.get('queue_full')).toBeUndefined();

      page.store.write([line('e1000')]);

      expect(pending(page)).toBe(901 - 100);
      expect(page.dropped.get('queue_full')).toBe(200);
      expect(page.logged('QUEUE_FULL')).toBe(true);
      expect(ids(page, walk(page).slice(0, 1))[0]).toBe('e200');
    });

    it('small chunks are trimmed one by one until at most 900 remain', () => {
      const page = openPage();
      for (let i = 0; i <= 1000; i += 1) page.store.write([line(`e${String(i)}`)]);

      expect(pending(page)).toBe(900);
      expect(page.dropped.get('queue_full')).toBe(101);
      expect(ids(page, walk(page).slice(0, 1))).toEqual(['e101']);
    });

    it('counts every page of the key, and the page that sees the excess deletes the oldest of any page', () => {
      const clock = new TestClock();
      const storage = new MemoryStorage();
      const first = openPage(storage, { clock, seed: 1 });
      first.store.write(lines('a', 600));
      clock.advanceBy(1);
      const second = openPage(storage, { clock, seed: 2 });
      second.store.write(lines('b', 401));

      expect(second.dropped.get('queue_full')).toBe(200);
      expect(walk(second).map((c) => [c.own, c.count])).toEqual([
        [false, 100],
        [false, 100],
        [false, 100],
        [false, 100],
        [true, 100],
        [true, 100],
        [true, 100],
        [true, 100],
        [true, 1],
      ]);
    });

    it('a batch on its way to the server is never trimmed', () => {
      const page = openPage();
      page.store.write(lines('e', 1000));
      const chunks = walk(page);
      // The uploader has read the oldest batch and is sending it.
      batch(page, chunks.slice(0, 1));

      page.store.write([line('e1000')]);

      expect(
        walk(page)
          .map((c) => c.seq)
          .slice(0, 2),
      ).toEqual([0, 3]);
      page.store.delete(chunks.slice(0, 1));
      page.store.write([line('e1001')]);
      expect(walk(page).map((c) => c.seq)).not.toContain(0);
    });

    it('the capacity is enforced by the walk at start too', () => {
      const storage = new MemoryStorage();
      for (let seq = 0; seq < 12; seq += 1) {
        plantChunk(
          storage,
          lines(`s${String(seq)}-`, 100).map((l) => l.text),
          { seq },
        );
      }
      const page = openPage(storage);

      expect(pending(page)).toBe(900);
      expect(page.dropped.get('queue_full')).toBe(300);
    });

    it('2 × the key and value lengths of chunks and markers at exactly 1 MiB is kept; one more trims to below 90 percent', () => {
      const storage = new MemoryStorage();
      // The marker of the page that wrote the chunks, so the walk keeps it.
      const marker = markerKey(KEY_HASH, PAGE_B);
      storage.area.entries.set(marker, '');
      const keyOf = (seq: number, chars: number): string =>
        chunkKey({ keyHash: KEY_HASH, writtenAt: NOW, newestEventAt: NOW, pageId: PAGE_B, seq, count: 1, chars });
      // Five chunks that claim 90 000 characters and a sixth that makes the half measure exactly
      // 512 KiB: Σ(key and value length) of chunks and the marker, its value empty.
      const half = MAX_QUEUE_MEASURE / 2;
      const fiveKeys = [0, 1, 2, 3, 4].reduce((sum, seq) => sum + keyOf(seq, 90_000).length + 90_000, 0);
      const sixth = half - marker.length - fiveKeys - keyOf(5, 70_000).length;
      expect(String(sixth)).toHaveLength(5);
      for (let seq = 0; seq < 5; seq += 1) plantChunk(storage, [line(`c${String(seq)}`).text], { seq, chars: 90_000 });
      const sixthKey = plantChunk(storage, [line('c5').text], { seq: 5, chars: sixth });
      const page = openPage(storage);

      expect(walk(page)).toHaveLength(6);
      expect(page.dropped.size).toBe(0);

      storage.area.entries.delete(sixthKey);
      plantChunk(storage, [line('c5').text], { seq: 5, chars: sixth + 1 });
      const after = walk(page);

      // Below 90 percent of 1 MiB (943 718.4): the oldest chunk goes, the rest stay.
      const measure = 2 * (marker.length + after.reduce((sum, c) => sum + c.key.length + c.chars, 0));
      expect(measure).toBeLessThan(0.9 * MAX_QUEUE_MEASURE);
      expect(after.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(page.dropped.get('queue_full')).toBe(1);
      expect(page.logged('QUEUE_FULL')).toBe(true);
      expect(page.watched.reads).toEqual([]);
    });

    it('fits the quota of every engine at the limit (plan section 15, step 1.4)', () => {
      // The worst case measured: WebKit stores 2 bytes per code unit of a non-Latin-1 value and
      // throws at 5 MiB of bytes. The SDK's own chunks at the limit then use at most 1 MiB of it.
      const worstBytesPerUnit = 2;
      expect((MAX_QUEUE_MEASURE / 2) * worstBytesPerUnit).toBe(1024 * 1024);
      expect(MAX_QUEUE_MEASURE).toBeLessThanOrEqual((5 * 1024 * 1024) / 5);
    });
  });

  describe('a chunk that vanished (Web Disk 1)', () => {
    it('deleted by another page between the walk and the read is skipped, never counted', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('a').text, 'corrupt'], { seq: 0 });
      plantChunk(storage, [line('b').text], { seq: 1 });
      const page = openPage(storage);
      const other = openPage(storage, { seed: 2 });
      const chunks = walk(page);

      other.store.delete(chunks.slice(0, 1));
      const result = batch(page, chunks);
      page.store.delete(chunks);
      page.store.delete(chunks);

      expect(result.lines.map((l) => l.messageId)).toEqual(['b']);
      expect(result.chunks.map((c) => c.seq)).toEqual([1]);
      expect(page.dropped.size).toBe(0);
      expect(other.dropped.size).toBe(0);
      expect(queueKeys(storage)).toEqual([]);
    });

    it('deleted in the middle of building a batch is skipped and the batch built from the rest', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('a').text], { seq: 0 });
      const middle = plantChunk(storage, [line('b').text], { seq: 1 });
      plantChunk(storage, [line('c').text], { seq: 2 });
      const page = openPage(storage);
      const chunks = walk(page);
      page.watched.onRead = (key) => {
        if (key === chunks[0]?.key) storage.area.entries.delete(middle);
      };

      const result = batch(page, chunks);

      expect(result.lines.map((l) => l.messageId)).toEqual(['a', 'c']);
      expect(result.chunks.map((c) => c.seq)).toEqual([0, 2]);
      expect(storage.area.entries.has(middle)).toBe(false);
    });

    it('deleted while its batch was in flight makes the delete after the acknowledgement a no-op', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('a', NOW - THREE_DAYS + 10).text, line('b').text]);
      const clock = new TestClock();
      const page = openPage(storage, { clock });
      const chunks = walk(page);
      clock.advanceBy(20);
      const result = batch(page, chunks);
      expect(result.lines.map((l) => l.messageId)).toEqual(['b']);

      storage.area.entries.clear();
      page.store.delete(result.chunks);

      expect(page.dropped.size).toBe(0);
    });

    it('the same chunk sent by two pages is deleted and counted once', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('a').text, 'corrupt']);
      const first = openPage(storage, { seed: 1 });
      const second = openPage(storage, { seed: 2 });
      const a = batch(first, walk(first));
      const b = batch(second, walk(second));

      first.store.delete(a.chunks);
      second.store.delete(b.chunks);

      expect(first.dropped.get('corrupt')).toBe(1);
      expect(second.dropped.size).toBe(0);
    });
  });

  describe('clearing', () => {
    it("deletes every chunk and marker of the key, other pages' included, without counting; seq keeps growing", () => {
      const storage = new MemoryStorage();
      const page = openPage(storage, { seed: 1 });
      page.store.write(lines('e', 150));
      plantChunk(storage, [line('other-page').text], { pageId: PAGE_B });
      storage.area.entries.set(markerKey(KEY_HASH, PAGE_B), '');
      storage.area.entries.set(`rubicon.${KEY_HASH}.q1.junk`, 'x');
      const otherKey = plantChunk(storage, [line('other-key').text], { hash: OTHER_HASH });
      storage.area.entries.set('host-key', 'v');

      page.store.clear();

      expect(Array.from(storage.area.entries.keys()).sort()).toEqual([otherKey, 'host-key'].sort());
      expect(page.dropped.size).toBe(0);
      page.store.write([line('after')]);
      const chunks = walk(page);
      expect(chunks.map((c) => c.seq)).toEqual([2]);
      expect(ids(page, chunks)).toEqual(['after']);
    });
  });

  describe('failures', () => {
    it('a failed write drops the chunk as storage_error with an ERROR, and the next write goes on', () => {
      const page = openPage();
      page.storage.failWrites = true;

      expect(page.store.write(lines('lost', 3))).toEqual({ stored: 0, dropped: 3, droppedLines: [0, 1, 2] });

      expect(page.dropped.get('storage_error')).toBe(3);
      expect(page.lines('STORAGE_WRITE_FAILED')[0]?.level).toBe('error');
      page.storage.failWrites = false;
      page.store.write([line('kept')]);
      expect(walk(page).map((c) => c.seq)).toEqual([1]);
    });

    it('a failed chunk drops only its own lines, and the result names them for the observer', () => {
      const page = openPage();
      page.watched.failWrite = (index) => index === 1;

      const result = page.store.write(lines('e', 250));

      expect(result.stored).toBe(150);
      expect(result.dropped).toBe(100);
      expect(result.droppedLines).toEqual(Array.from({ length: 100 }, (_, i) => 100 + i));
      expect(page.dropped.get('storage_error')).toBe(100);
    });

    it('a QuotaExceededError drops the chunk as storage_error and touches no host key', () => {
      const storage = new MemoryStorage(new MemoryStorageArea({ quotaChars: 2000 }));
      storage.setItem('host-a', 'x'.repeat(1000));
      storage.setItem('host-b', 'y'.repeat(500));
      const before = storage.area.snapshot();
      const page = openPage(storage);

      const result = page.store.write(lines('e', 10));

      expect(result).toEqual({ stored: 0, dropped: 10, droppedLines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
      expect(page.dropped.get('storage_error')).toBe(10);
      expect(storage.area.snapshot()).toEqual(before);
    });

    it('storage that throws on every access keeps the SDK running and deletes nothing', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('a').text]);
      const page = openPage(storage);
      const chunks = walk(page);
      storage.failAccess = true;

      expect(page.store.write([line('b')])).toEqual({ stored: 0, dropped: 1, droppedLines: [0] });
      expect(page.store.walk()).toBeUndefined();
      expect(page.store.buildBatch(chunks, { sentAt: SENT_AT })).toEqual({ status: 'unusable' });
      page.store.delete(chunks);
      page.store.release();
      page.store.unrelease();
      page.store.clear();

      storage.failAccess = false;
      expect(queueKeys(storage)).toHaveLength(1);
      expect(page.dropped.get('storage_error')).toBe(1);
      expect(page.dropped.get('corrupt')).toBeUndefined();
    });

    it('a getItem that throws while building a batch sends, deletes and counts nothing', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('a').text, 'corrupt'], { seq: 0 });
      plantChunk(storage, [line('b').text], { seq: 1 });
      const page = openPage(storage);
      const chunks = walk(page);
      page.watched.onRead = (key) => {
        if (key === chunks[1]?.key) storage.failAccess = true;
      };

      expect(page.store.buildBatch(chunks, { sentAt: SENT_AT })).toEqual({ status: 'unusable' });

      storage.failAccess = false;
      expect(queueKeys(storage)).toHaveLength(2);
      expect(page.dropped.size).toBe(0);
    });
  });

  describe('access levels (step 4.1)', () => {
    it('refused: expireStored deletes only expired chunks, from key names, and writes nothing; the count stays in memory', () => {
      const storage = new MemoryStorage();
      const old = NOW - THREE_DAYS - 1;
      const expiredOwn = plantChunk(storage, [line('o1', old).text, line('o2', old).text], {
        seq: 0,
        newestEventAt: old,
      });
      const kept = plantChunk(storage, [line('k').text], { seq: 1, newestEventAt: NOW - THREE_DAYS });
      const expiredOther = plantChunk(storage, [line('x', old).text], { hash: OTHER_HASH, newestEventAt: old });
      const untouched: Record<string, string> = {
        [markerKey(KEY_HASH, PAGE_A)]: '',
        [`rubicon.${KEY_HASH}.q1.junk`]: 'x',
        [`rubicon.${KEY_HASH}.consent`]: '{"v":1,"state":"denied","decided_at":1}',
        'host-key': 'v',
      };
      for (const [key, value] of Object.entries(untouched)) storage.area.entries.set(key, value);
      // The stores of the same page, refused: counters held in memory (step 4.1).
      const stores = openStores(storage, new TestClock(), { access: 'consent' }).stores;
      const watched = new WatchedStorage(storage);
      const store = new ChunkStore({
        keyHash: KEY_HASH,
        storage: watched,
        access: { level: 'consent' },
        log: new Log({ level: 'debug', debug: false, sink: new RecordingSink() }),
        clock: new TestClock(),
        random: new SeededRandom(1),
        drops: {
          count(reason, events) {
            stores.device.countDropped(reason, events);
          },
        },
      });
      const before = storage.writeCount;

      store.expireStored();

      expect(Array.from(storage.area.entries.keys()).sort()).toEqual(Object.keys(untouched).concat([kept]).sort());
      expect(storage.area.entries.has(expiredOwn) || storage.area.entries.has(expiredOther)).toBe(false);
      expect(watched.reads).toEqual([]);
      expect(storage.writeCount).toBe(before);
      expect(stores.device.state.diagnostics.dropped.get('expired')).toBe(2);
      expect(storage.area.entries.has(`rubicon.${KEY_HASH}.device`)).toBe(false);
    });

    it('pending: nothing of the queue in storage is read, written or deleted, whatever the page does', () => {
      const storage = new MemoryStorage();
      const old = NOW - THREE_DAYS - 1;
      plantChunk(storage, [line('old', old).text], { seq: 0, newestEventAt: old });
      plantChunk(storage, [line('live').text], { seq: 1 });
      storage.area.entries.set(markerKey(KEY_HASH, PAGE_A), '');
      storage.area.entries.set(`rubicon.${KEY_HASH}.q1.junk`, 'x');
      const before = storage.area.snapshot();
      const page = openPage(storage, { level: 'consent' });

      page.store.write(lines('held', 2));
      const chunks = walk(page);
      const result = batch(page, chunks);
      page.store.delete(result.chunks);
      page.store.release();
      page.store.unrelease();
      page.store.write([line('again')]);
      page.store.discardHeld();

      expect(storage.area.snapshot()).toEqual(before);
      expect(page.watched.reads).toEqual([]);
      expect(storage.writeCount).toBe(0);
      expect(page.dropped.size).toBe(0);
    });

    it('expireStored is the walk with full access and does nothing in the memory-only mode', () => {
      const old = NOW - THREE_DAYS - 1;
      for (const level of ['full', 'none'] as const) {
        const storage = new MemoryStorage();
        plantChunk(storage, [line('old', old).text, 'corrupt'], { newestEventAt: old });
        storage.area.entries.set(`rubicon.${KEY_HASH}.q1.junk`, 'x');
        const page = openPage(storage, { level });

        page.store.expireStored();

        expect(queueKeys(storage).length, level).toBe(level === 'full' ? 0 : 2);
        expect(page.dropped.get('expired'), level).toBe(level === 'full' ? 2 : undefined);
      }
    });

    it('while consent is pending, chunks live in memory and nothing of the queue in storage is read or written', () => {
      const storage = new MemoryStorage();
      const stored = plantChunk(storage, [line('old', NOW - THREE_DAYS - 1).text], {
        newestEventAt: NOW - THREE_DAYS - 1,
      });
      const page = openPage(storage, { level: 'consent' });

      page.store.write(lines('held', 3));
      const chunks = walk(page);

      expect(Array.from(storage.area.entries.keys())).toEqual([stored]);
      expect(page.watched.reads).toEqual([]);
      expect(chunks.map((c) => [c.own, c.count])).toEqual([[true, 3]]);
      expect(ids(page, chunks)).toEqual(['held0', 'held1', 'held2']);
      expect(page.dropped.size).toBe(0);
    });

    it('optIn: the held chunks are written to storage at the first use with full access', () => {
      const storage = new MemoryStorage();
      const page = openPage(storage, { level: 'consent' });
      page.store.write(lines('held', 3));

      page.access.level = 'full';
      const chunks = walk(page);

      expect(queueKeys(storage)).toEqual([chunks[0]?.key]);
      expect(ids(page, chunks)).toEqual(['held0', 'held1', 'held2']);
    });

    it('optIn: a held chunk that cannot be written is dropped as storage_error', () => {
      const storage = new MemoryStorage();
      const page = openPage(storage, { level: 'consent' });
      page.store.write(lines('held', 3));
      storage.failWrites = true;

      page.access.level = 'full';

      expect(walk(page)).toEqual([]);
      expect(page.dropped.get('storage_error')).toBe(3);
    });

    it('optOut while pending: the held chunks are dropped uncounted and stored chunks stay', () => {
      const storage = new MemoryStorage();
      const stored = plantChunk(storage, [line('stored').text]);
      const page = openPage(storage, { level: 'consent' });
      page.store.write(lines('held', 3));

      page.store.discardHeld();

      expect(walk(page)).toEqual([]);
      expect(Array.from(storage.area.entries.keys())).toEqual([stored]);
      expect(page.dropped.size).toBe(0);
    });

    it('clearLocalData while pending or refused deletes the stored chunks too, uncounted', () => {
      const storage = new MemoryStorage();
      plantChunk(storage, [line('stored').text]);
      storage.area.entries.set(markerKey(KEY_HASH, PAGE_B), '');
      const page = openPage(storage, { level: 'consent' });
      page.store.write([line('held')]);

      page.store.clear();

      expect(storage.area.entries.size).toBe(0);
      expect(walk(page)).toEqual([]);
      expect(page.dropped.size).toBe(0);
    });

    it('the memory-only mode keeps the same rules in memory and never touches storage', () => {
      const storage = new MemoryStorage();
      const stored = plantChunk(storage, [line('stored').text]);
      const page = openPage(storage, { level: 'none' });

      page.store.write(lines('e', 1001));
      page.store.clear();
      page.store.write([line('after')]);

      expect(page.dropped.get('queue_full')).toBe(200);
      expect(Array.from(storage.area.entries.keys())).toEqual([stored]);
      expect(page.watched.reads).toEqual([]);
      expect(ids(page, walk(page))).toEqual(['after']);
    });
  });
});

describe('MemoryKeyValueStorage', () => {
  it('behaves as localStorage for one page: listing, null for a missing key or index, idempotent removal', () => {
    const memory = new MemoryKeyValueStorage();
    memory.setItem('a', '1');
    memory.setItem('b', '');

    expect(memory.length).toBe(2);
    expect([memory.key(0), memory.key(1), memory.key(2)]).toEqual(['a', 'b', null]);
    expect([memory.getItem('b'), memory.getItem('c')]).toEqual(['', null]);
    memory.removeItem('a');
    memory.removeItem('a');
    expect(memory.keys()).toEqual(['b']);
    memory.clear();
    expect(memory.length).toBe(0);
  });
});
