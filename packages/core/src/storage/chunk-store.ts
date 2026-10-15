import { checkLine, utf8ByteLength } from '../json';
import type { DropReason, Log } from '../log';
import type { Clock, KeyValueStorage, RandomSource } from '../platform';
import { randomHex } from '../util';
import { chunkId, chunkKey, MARKER_VALUE, markerKey, parseQueueKey } from './chunk-key';
import type { ChunkName } from './chunk-key';
import { MemoryKeyValueStorage } from './memory-key-value-storage';
import type { StoreAccess } from './store-record';

/** Pending events allowed over every page's chunks of the key (Queue 5, Web Queue 6). */
export const MAX_PENDING_EVENTS = 1000;

/** What trimming for the count goes down to: at most this many events remain (Queue 5, Android log 4.2). */
export const TRIM_TO_EVENTS = 900;

/**
 * The byte limit of Web Queue 6 as Web Disk 2 measures it: 2 × Σ(`key.length` + `value.length`) over
 * the key's chunks and markers at most 1 MiB. The factor two is the conservative reading of how
 * engines count the quota, confirmed in step 1.4 (plan section 15): at WebKit's worst case, two
 * bytes per code unit, the measure is the bytes stored.
 */
export const MAX_QUEUE_MEASURE = 1024 * 1024;

/** What trimming for the byte limit goes down to: below 90 percent of {@link MAX_QUEUE_MEASURE}. */
export const TRIM_TO_MEASURE = 0.9 * MAX_QUEUE_MEASURE;

/** Events older than this are deleted unsent; strictly older, a future time never (Android log 4.2). */
export const MAX_EVENT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Events per batch (Queue 4), and so per chunk at most. */
export const MAX_BATCH_EVENTS = 100;

/** Bytes per batch body before compression (Queue 4). */
export const MAX_BATCH_BYTES = 512 * 1024;

/**
 * The keepalive budget of Web Queue 5: about 75 percent of the browser's 64 KiB quota, measured on
 * the body bytes sent. No chunk is larger: a chunk sent alone, in its envelope, fits it.
 */
export const KEEPALIVE_BUDGET_BYTES = 48 * 1024;

// `{"sent_at":<16 digits at most>,"batch":[]}`: the envelope of a body around a chunk's lines.
const ENVELOPE_MAX_BYTES = '{"sent_at":,"batch":[]}'.length + 16;

/** Counts dropped events by reason for `SDK Diagnostics` and the observer (Queue 5, Logging 5). */
export interface DropCounter {
  count(reason: DropReason, events: number): void;
}

/** One serialized wire event for {@link ChunkStore.write}, with the time the 3-day rule reads. */
export interface ChunkLine {
  /** The wire event as one line of compact JSON, written as it is (Web Disk 2, Serialization 1). */
  readonly text: string;
  /** The event's `timestamp`, epoch ms. */
  readonly timestamp: number;
}

/** A chunk of the key as the walk found it, from its key alone (Web Disk 2). */
export interface ChunkInfo extends ChunkName {
  readonly key: string;
  /** `<pageId>.<seq>`, the chunk id of Web Retry 1. */
  readonly id: string;
  /** Written by this page load. */
  readonly own: boolean;
  /** Its page left a released marker (Web Queue 2, point 4). */
  readonly released: boolean;
}

/** One event line of a batch. */
export interface BatchLine {
  readonly text: string;
  readonly messageId: string;
  readonly timestamp: number;
  /** `undefined` when missing; the device check of Web Privacy 3 is the uploader's (step 6.4). */
  readonly deviceId: string | undefined;
}

/** Limits of {@link ChunkStore.buildBatch}. */
export interface BatchOptions {
  /** `sent_at`, epoch ms, written at every attempt (Event Model 5). */
  readonly sentAt: number;
  /** {@link MAX_BATCH_EVENTS} unless given. */
  readonly maxEvents?: number;
  /** Body bytes; {@link MAX_BATCH_BYTES} unless given, {@link KEEPALIVE_BUDGET_BYTES} on hiding (Web Queue 5). */
  readonly maxBytes?: number;
}

/**
 * What {@link ChunkStore.buildBatch} gave: `built` with the chunks it took whole, in order, and their
 * event lines (an empty `lines` means every line was skipped and the chunks are deleted without an
 * upload, Android `BatchResult.Written`); `unusable` when reading storage threw, so nothing is sent,
 * deleted or counted and the upload waits (Web Disk 5, reading 2).
 */
export type BatchResult =
  | {
      readonly status: 'built';
      readonly chunks: readonly ChunkInfo[];
      readonly lines: readonly BatchLine[];
      /** `{"sent_at":..,"batch":[` + the lines joined by commas + `]}` (Web Disk 2). */
      readonly body: string;
    }
  | { readonly status: 'unusable' };

/** What {@link ChunkStore.write} did with the lines it was given. */
export interface ChunkWriteResult {
  /** Events now in chunks. */
  readonly stored: number;
  /** Events of chunks whose `setItem` threw, counted as `storage_error` (Web Queue 6). */
  readonly dropped: number;
}

/** What {@link ChunkStore} is made of. */
export interface ChunkStoreOptions {
  /** The first 16 hex characters of the SHA-256 of the API key (Web Identity 4). */
  readonly keyHash: string;
  readonly storage: KeyValueStorage;
  /** Shared with the stores (step 4.1); set by the privacy and startup code. */
  readonly access: StoreAccess;
  readonly log: Log;
  readonly clock: Clock;
  /** Draws the page id. */
  readonly random: RandomSource;
  readonly drops: DropCounter;
}

interface Skipped {
  readonly corrupt: number;
  readonly expired: number;
}

interface Walked {
  readonly key: string;
  readonly name: ChunkName;
}

/** The body of a batch: the envelope around the stored lines, never serialized again (Web Disk 2). */
export function batchBody(sentAt: number, lines: readonly string[]): string {
  return `{"sent_at":${String(sentAt)},"batch":[${lines.join(',')}]}`;
}

/**
 * The event chunks of one instance (Web Disk 1, 2; Web Queue 2, 5, 6), the web form of the Android
 * `FileEventStore`. A chunk is one immutable `localStorage` key and value, written once by its page
 * and never appended to; its key carries what the queue's rules need, so capacity, age and adoption
 * are decided from names and a value is read only to send it.
 *
 * - The page id is 16 hex characters from the `RandomSource`, in memory only; `seq` counts this
 *   page's chunks from 0 (Web Queue 2, point 1).
 * - Every chunk write walks the keys (Web Disk 2): all keys are collected first, then parsed, then
 *   the expired, malformed and over-capacity ones deleted. The walk also runs before every upload.
 * - Deletes are by key and idempotent: a chunk another page deleted is skipped and never counted
 *   (Web Disk 1). A throwing `getItem` means storage is unusable: nothing is deleted or counted.
 * - Corrupt and expired lines of a chunk that is read are counted when this page deletes the chunk,
 *   once (Android log 4.2); a chunk deleted unread for its age counts all its events as `expired`.
 * - While consent is pending or refused and in the memory-only mode, chunks live in this page's
 *   memory under the same rules and nothing of the queue in storage is read or written (Web Privacy
 *   1, Web Logging 4, Web Disk 4); held chunks move to storage at the first use under `full`. A
 *   refused page deletes expired stored chunks only through {@link expireStored}.
 *
 * Nothing here throws.
 */
export class ChunkStore {
  /** This page load's id (Web Queue 2). */
  readonly pageId: string;

  private readonly keyHash: string;
  private readonly storage: KeyValueStorage;
  private readonly access: StoreAccess;
  private readonly log: Log;
  private readonly clock: Clock;
  private readonly drops: DropCounter;
  private readonly memory = new MemoryKeyValueStorage();
  private nextSeq = 0;

  // The chunks of the batch on its way to the server, never trimmed (Android log 6.7), by key.
  private readonly inFlight = new Set<string>();
  // What the last read of a chunk skipped, counted when this page deletes it, by key.
  private readonly skipped = new Map<string, Skipped>();
  // Chunks whose corrupt lines this page has logged, by key.
  private readonly corruptReported = new Set<string>();

  constructor(options: ChunkStoreOptions) {
    this.keyHash = options.keyHash;
    this.storage = options.storage;
    this.access = options.access;
    this.log = options.log;
    this.clock = options.clock;
    this.drops = options.drops;
    this.pageId = randomHex(options.random, 2);
  }

  /**
   * Writes `lines` as this page's next chunks, in order: as many as needed so that none holds more
   * than {@link MAX_BATCH_EVENTS} events or, in its envelope, more than {@link KEEPALIVE_BUDGET_BYTES}
   * (Web Queue 5), each with one `setItem`; then walks the keys for age and capacity (Web Disk 2). A
   * `setItem` that throws drops that chunk's events as `storage_error`, and nothing of the host's is
   * deleted to make room (Web Queue 6).
   */
  write(lines: readonly ChunkLine[]): ChunkWriteResult {
    if (lines.length === 0) return { stored: 0, dropped: 0 };
    const area = this.area();
    let stored = 0;
    let dropped = 0;
    for (const group of splitIntoChunks(lines)) {
      let value = '';
      let newest = 0;
      for (const line of group) {
        // One wire event per line, each ended by a line break, as Android 3 writes them.
        value += `${line.text}\n`;
        newest = Math.max(newest, line.timestamp);
      }
      const name: ChunkName = {
        keyHash: this.keyHash,
        writtenAt: keyTime(this.clock.now()),
        newestEventAt: keyTime(newest),
        pageId: this.pageId,
        seq: this.nextSeq,
        count: group.length,
        chars: value.length,
      };
      this.nextSeq += 1;
      try {
        area.setItem(chunkKey(name), value);
        stored += group.length;
      } catch (error) {
        dropped += group.length;
        this.drops.count('storage_error', group.length);
        this.log.error(
          'STORAGE_WRITE_FAILED',
          () => `Could not write a chunk of ${String(group.length)} events; they were dropped`,
          { error },
        );
      }
    }
    if (stored > 0) this.walk();
    return { stored, dropped };
  }

  /**
   * The key walk of Web Disk 2 and 6, at start, after every chunk write and before every upload:
   * collects every key, then deletes this key's malformed queue keys (`UNKNOWN_FILE`), its chunks
   * whose newest event is strictly older than 3 days (`expired`, unread), other key hashes' expired
   * chunks (uncounted), markers whose page has no chunk left, and this key's oldest whole chunks
   * over the capacity (`queue_full`). Returns this key's remaining chunks, oldest first by
   * `writtenAt`, `pageId` and `seq`, never by the order of `key(i)`; `undefined` when storage
   * cannot be listed, and then nothing was deleted.
   */
  walk(): ChunkInfo[] | undefined {
    const area = this.area();
    const now = this.clock.now();
    const listed = attempt(() => listKeys(area));
    if (!listed.ok) {
      this.log.debug(() => 'Could not list the stored keys; the queue waits');
      return undefined;
    }
    const keys = listed.value;

    const own: Walked[] = [];
    const others: Walked[] = [];
    const markers: { readonly key: string; readonly keyHash: string; readonly owner: string }[] = [];
    let malformed = 0;
    for (const key of keys) {
      const parsed = parseQueueKey(key);
      if (parsed === undefined) continue;
      if (parsed.kind === 'malformed') {
        // Only under this key's exact prefixes (Web Disk 2); another key's are never touched.
        if (parsed.keyHash === this.keyHash && this.remove(area, key)) malformed += 1;
      } else if (parsed.kind === 'marker') {
        markers.push({ key, keyHash: parsed.keyHash, owner: owner(parsed.keyHash, parsed.pageId) });
      } else if (parsed.name.keyHash === this.keyHash) {
        own.push({ key, name: parsed.name });
      } else {
        others.push({ key, name: parsed.name });
      }
    }
    if (malformed > 0) {
      this.log.warn(
        'UNKNOWN_FILE',
        () => `Deleted ${String(malformed)} malformed keys under the event chunk prefix of this API key`,
      );
    }

    const remaining = new Set<string>();
    let expired = 0;
    const live: Walked[] = [];
    for (const chunk of own) {
      if (!this.inFlight.has(chunk.key) && isExpired(chunk.name.newestEventAt, now)) {
        if (this.remove(area, chunk.key)) {
          expired += chunk.name.count;
          this.forget(chunk.key);
          continue;
        }
      }
      live.push(chunk);
      remaining.add(owner(chunk.name.keyHash, chunk.name.pageId));
    }
    for (const chunk of others) {
      // Another project's events, worthless after 3 days and never counted here (Web Disk 6).
      if (isExpired(chunk.name.newestEventAt, now) && this.remove(area, chunk.key)) continue;
      remaining.add(owner(chunk.name.keyHash, chunk.name.pageId));
    }
    this.countExpired(expired);

    const released = new Set<string>();
    let markerMeasure = 0;
    for (const marker of markers) {
      // A marker goes with the last chunk of its page (Web Disk 2, 6).
      if (!remaining.has(marker.owner) && this.remove(area, marker.key)) continue;
      if (marker.keyHash === this.keyHash) {
        released.add(marker.owner);
        markerMeasure += 2 * (marker.key.length + MARKER_VALUE.length);
      }
    }

    live.sort(compareChunks);
    const kept = this.trim(area, live, markerMeasure);
    return kept.map((chunk) => ({
      ...chunk.name,
      key: chunk.key,
      id: chunkId(chunk.name),
      own: chunk.name.pageId === this.pageId,
      released: released.has(owner(chunk.name.keyHash, chunk.name.pageId)),
    }));
  }

  /**
   * Reads `chunks` in the order given, from a fresh read of storage (Web Queue 2, point 6), into one
   * batch of whole chunks: it stops before the first chunk that would take it past `maxEvents` or
   * `maxBytes`, though the first chunk is always taken. A chunk that vanished is skipped and counted
   * nowhere (Web Disk 1). Corrupt lines are skipped and logged once per chunk and page with the
   * chunk key, the line number and the `message_id` when readable, never the content (Disk 5);
   * expired lines of a partly expired chunk are skipped (Web Disk 2). Both are counted when this
   * page deletes the chunk. The chunks taken are in flight until deleted or the next batch.
   */
  buildBatch(chunks: readonly ChunkInfo[], options: BatchOptions): BatchResult {
    const area = this.area();
    const now = this.clock.now();
    const maxEvents = options.maxEvents ?? MAX_BATCH_EVENTS;
    const maxBytes = options.maxBytes ?? MAX_BATCH_BYTES;
    const envelope = batchBody(options.sentAt, []).length;
    this.inFlight.clear();
    const taken: ChunkInfo[] = [];
    const lines: BatchLine[] = [];
    let lineBytes = 0;
    for (const chunk of chunks) {
      // The key's count decides without a read when the chunk cannot fit.
      if (taken.length > 0 && lines.length + chunk.count > maxEvents) break;
      const got = attempt(() => area.getItem(chunk.key));
      if (!got.ok) {
        this.inFlight.clear();
        this.log.debug(() => 'Could not read the stored events; the upload waits');
        return { status: 'unusable' };
      }
      const value = got.value;
      if (value === null) {
        this.forget(chunk.key);
        continue;
      }
      const read = this.read(chunk.key, value, now);
      let bytes = lineBytes;
      for (const line of read) bytes += utf8ByteLength(line.text);
      const count = lines.length + read.length;
      const total = envelope + bytes + Math.max(0, count - 1);
      if (taken.length > 0 && (count > maxEvents || total > maxBytes)) break;
      taken.push(chunk);
      this.inFlight.add(chunk.key);
      for (const line of read) lines.push(line);
      lineBytes = bytes;
    }
    const body = batchBody(
      options.sentAt,
      lines.map((line) => line.text),
    );
    return { status: 'built', chunks: taken, lines, body };
  }

  /**
   * Deletes chunks by key after the server acknowledged them or when they are dropped, idempotent: a
   * chunk already gone is skipped, and only a chunk this call deleted counts the corrupt and expired
   * lines its last read skipped (Web Disk 1, Android log 4.2).
   */
  delete(chunks: readonly Pick<ChunkInfo, 'key'>[]): void {
    const area = this.area();
    let corrupt = 0;
    let expired = 0;
    for (const chunk of chunks) {
      const skipped = this.skipped.get(chunk.key);
      this.forget(chunk.key);
      const got = attempt(() => area.getItem(chunk.key));
      if (!got.ok) {
        this.log.debug(() => 'Could not read the stored events; nothing was deleted');
        continue;
      }
      if (got.value === null || !this.remove(area, chunk.key) || skipped === undefined) continue;
      corrupt += skipped.corrupt;
      expired += skipped.expired;
    }
    if (corrupt > 0) this.drops.count('corrupt', corrupt);
    this.countExpired(expired);
  }

  /**
   * Writes this page's released marker, on `pagehide` (Web Disk 2, Web Queue 2 point 4): a hint
   * that other pages may send its chunks. Only with full access; a failure loses nothing.
   */
  release(): void {
    if (this.access.level !== 'full') return;
    const written = attempt(() => {
      this.storage.setItem(markerKey(this.keyHash, this.pageId), MARKER_VALUE);
    });
    if (!written.ok) this.log.debug(() => 'Could not write the released marker');
  }

  /** Removes this page's released marker, on a return from the back/forward cache (Web Disk 2). */
  unrelease(): void {
    if (this.access.level !== 'full') return;
    this.remove(this.storage, markerKey(this.keyHash, this.pageId));
  }

  /**
   * Deletes every chunk and marker of the key, other pages' included, and this page's held chunks,
   * without counting them: `clearLocalData()` (Web Privacy 3, Android log 6.5). An erasure, so it
   * reaches storage while consent is pending or refused as well; only the memory-only mode leaves
   * storage alone. `seq` keeps growing.
   */
  clear(): void {
    this.memory.clear();
    this.inFlight.clear();
    this.skipped.clear();
    this.corruptReported.clear();
    if (this.access.level === 'none') return;
    const listed = attempt(() => listKeys(this.storage));
    if (!listed.ok) {
      this.log.debug(() => 'Could not list the stored keys; nothing was cleared');
      return;
    }
    for (const key of listed.value) {
      const parsed = parseQueueKey(key);
      const hash = parsed === undefined ? undefined : parsed.kind === 'chunk' ? parsed.name.keyHash : parsed.keyHash;
      if (hash === this.keyHash) this.remove(this.storage, key);
    }
  }

  /**
   * The 3-day rule for a page whose consent is refused, called by the privacy code at start and
   * whenever the page would walk (step 6.5): the queue in storage waits for `optIn()` "or the 3-day
   * age rule removes it" (Web Privacy 3 note of 2026-10-14, Web Logging 4), so the declaration's
   * "at most 3 days" holds. Deletes, from key names alone, this key's chunks whose newest event is
   * strictly older than 3 days (counted `expired`; the counters stay in memory while refused, step
   * 4.1) and other key hashes' expired chunks (uncounted, Web Disk 6); it reads no value, writes
   * nothing and touches no other key. A pending page never calls it: it reads only the consent
   * record (Web Privacy 1). Under `full` it is the walk; in the memory-only mode it does nothing.
   */
  expireStored(): void {
    if (this.access.level === 'none') return;
    if (this.access.level === 'full') {
      this.walk();
      return;
    }
    const listed = attempt(() => listKeys(this.storage));
    if (!listed.ok) {
      this.log.debug(() => 'Could not list the stored keys; nothing expired');
      return;
    }
    const now = this.clock.now();
    let expired = 0;
    for (const key of listed.value) {
      const parsed = parseQueueKey(key);
      if (parsed === undefined || parsed.kind !== 'chunk') continue;
      const own = parsed.name.keyHash === this.keyHash;
      if (own && this.inFlight.has(key)) continue;
      if (!isExpired(parsed.name.newestEventAt, now) || !this.remove(this.storage, key)) continue;
      if (own) {
        expired += parsed.name.count;
        this.forget(key);
      }
    }
    this.countExpired(expired);
  }

  /**
   * Drops this page's held chunks without counting them, when a pending consent becomes a refusal
   * (Web Privacy 1: `optOut()` drops the waiting events uncounted). Stored chunks stay.
   */
  discardHeld(): void {
    this.memory.keys().forEach((key) => {
      this.forget(key);
    });
    this.memory.clear();
  }

  /** Where the queue lives now: storage with full access, else this page's memory (Web Disk 4, Web Privacy 1). */
  private area(): KeyValueStorage {
    if (this.access.level !== 'full') return this.memory;
    if (this.memory.length > 0) this.moveHeld();
    return this.storage;
  }

  /** Writes the chunks held while consent was pending to storage (Web Privacy 1, `optIn()`). */
  private moveHeld(): void {
    for (const key of this.memory.keys()) {
      const value = this.memory.getItem(key);
      this.memory.removeItem(key);
      if (value === null) continue;
      try {
        this.storage.setItem(key, value);
      } catch (error) {
        const parsed = parseQueueKey(key);
        const count = parsed !== undefined && parsed.kind === 'chunk' ? parsed.name.count : 0;
        if (count > 0) this.drops.count('storage_error', count);
        this.log.error(
          'STORAGE_WRITE_FAILED',
          () => `Could not write a chunk of ${String(count)} events; they were dropped`,
          { error },
        );
      }
    }
  }

  /** Deletes the oldest whole chunks over the capacity (Queue 5, Web Queue 6); returns the rest. */
  private trim(area: KeyValueStorage, sorted: readonly Walked[], markerMeasure: number): Walked[] {
    let events = 0;
    let measure = markerMeasure;
    for (const chunk of sorted) {
      events += chunk.name.count;
      measure += 2 * (chunk.key.length + chunk.name.chars);
    }
    const overCount = events > MAX_PENDING_EVENTS;
    const overSize = measure > MAX_QUEUE_MEASURE;
    if (!overCount && !overSize) return sorted.slice();
    const kept: Walked[] = [];
    let dropped = 0;
    for (const chunk of sorted) {
      const trimming = (overCount && events > TRIM_TO_EVENTS) || (overSize && measure >= TRIM_TO_MEASURE);
      // A batch on its way to the server is never trimmed (Android log 6.7).
      if (!trimming || this.inFlight.has(chunk.key) || !this.remove(area, chunk.key)) {
        kept.push(chunk);
        continue;
      }
      this.forget(chunk.key);
      events -= chunk.name.count;
      measure -= 2 * (chunk.key.length + chunk.name.chars);
      dropped += chunk.name.count;
    }
    if (dropped > 0) {
      this.drops.count('queue_full', dropped);
      this.log.warn(
        'QUEUE_FULL',
        () =>
          `More than ${String(MAX_PENDING_EVENTS)} events or more than the storage budget were pending; ` +
          `dropped the oldest ${String(dropped)}`,
      );
    }
    return kept;
  }

  /** The event lines of a chunk's value; records what it skipped and logs corrupt lines once. */
  private read(key: string, value: string, now: number): BatchLine[] {
    const texts = value.split('\n');
    // Every line ends with a line break, so the last piece is empty (Web Disk 2).
    if (texts.length > 0 && texts[texts.length - 1] === '') texts.pop();
    const report = !this.corruptReported.has(key);
    this.corruptReported.add(key);
    const lines: BatchLine[] = [];
    let corrupt = 0;
    let expired = 0;
    texts.forEach((text, index) => {
      const line = checkLine(text);
      if (line.kind === 'corrupt') {
        corrupt += 1;
        if (report) {
          // The chunk key, the line number and the message id when readable; never the content.
          const messageId = line.messageId === undefined ? '' : `, message_id ${line.messageId}`;
          this.log.error('CORRUPT_LINE', () => `Skipped corrupt line ${String(index + 1)} of chunk ${key}${messageId}`);
        }
      } else if (isExpired(line.timestamp, now)) {
        expired += 1;
      } else {
        lines.push({ text, messageId: line.messageId, timestamp: line.timestamp, deviceId: line.deviceId });
      }
    });
    this.skipped.set(key, { corrupt, expired });
    return lines;
  }

  private countExpired(events: number): void {
    if (events === 0) return;
    this.drops.count('expired', events);
    this.log.warn('EVENTS_EXPIRED', () => `Deleted ${String(events)} events older than 3 days without sending them`);
  }

  private forget(key: string): void {
    this.inFlight.delete(key);
    this.skipped.delete(key);
    this.corruptReported.delete(key);
  }

  /** `removeItem`, idempotent; `false` when it threw. */
  private remove(area: KeyValueStorage, key: string): boolean {
    const removed = attempt(() => {
      area.removeItem(key);
    });
    if (!removed.ok) this.log.debug(() => 'Could not delete a stored event chunk or marker');
    return removed.ok;
  }
}

/** What a storage call gave; storage throws as `localStorage` does and the caller decides (step 2.1). */
type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function attempt<T>(action: () => T): Attempt<T> {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Every key of `area`, collected before anything is deleted; a `null` is skipped (Web Disk 2). */
function listKeys(area: KeyValueStorage): string[] {
  const keys: string[] = [];
  const length = area.length;
  for (let i = 0; i < length; i += 1) {
    const key = area.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/** Groups `lines` in order into chunks of at most 100 events that fit the keepalive budget alone. */
function splitIntoChunks(lines: readonly ChunkLine[]): ChunkLine[][] {
  const groups: ChunkLine[][] = [];
  let group: ChunkLine[] = [];
  let bytes = ENVELOPE_MAX_BYTES;
  for (const line of lines) {
    const size = utf8ByteLength(line.text);
    // A line joins the group with a comma in a body; a line alone always makes a chunk.
    if (group.length > 0 && (group.length >= MAX_BATCH_EVENTS || bytes + 1 + size > KEEPALIVE_BUDGET_BYTES)) {
      groups.push(group);
      group = [];
      bytes = ENVELOPE_MAX_BYTES;
    }
    bytes += size + (group.length > 0 ? 1 : 0);
    group.push(line);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function isExpired(time: number, now: number): boolean {
  return now - time > MAX_EVENT_AGE_MS;
}

/** A time as a key part: a whole number of milliseconds within the key grammar. */
function keyTime(millis: number): number {
  if (!(millis > 0)) return 0;
  return Math.min(Math.floor(millis), Number.MAX_SAFE_INTEGER);
}

function owner(keyHash: string, pageId: string): string {
  return `${keyHash}.${pageId}`;
}

function compareChunks(a: Walked, b: Walked): number {
  if (a.name.writtenAt !== b.name.writtenAt) return a.name.writtenAt - b.name.writtenAt;
  if (a.name.pageId !== b.name.pageId) return a.name.pageId < b.name.pageId ? -1 : 1;
  return a.name.seq - b.name.seq;
}
