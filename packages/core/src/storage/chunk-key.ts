/**
 * The format version of the event chunks (Web Disk 2). A later format writes `q2` and keeps reading
 * `q1` for as long as `q1` chunks appear; cleanup touches only `q1` (Web Disk 5). Raising it is a
 * design discussion.
 */
export const CHUNK_FORMAT = 'q1';

/** The released marker's format part, `q1r` (Web Disk 2). */
export const MARKER_FORMAT = 'q1r';

/**
 * The value of a released marker. Only its key carries meaning (Web Queue 2: a hint, never proof of
 * ownership), so the value is empty and the capacity counts the key alone.
 */
export const MARKER_VALUE = '';

/** What a chunk key says about its chunk (Web Disk 2); nothing here needs the value. */
export interface ChunkName {
  /** The first 16 hex characters of the SHA-256 of the API key the chunk belongs to. */
  readonly keyHash: string;
  /** When the chunk was written, epoch ms: the order of chunks and their age for adoption (Web Queue 2). */
  readonly writtenAt: number;
  /** The `timestamp` of the chunk's newest event, epoch ms: the 3-day rule without a read (Web Disk 2). */
  readonly newestEventAt: number;
  /** The writing page load's id, 16 lowercase hex characters (Web Queue 2). */
  readonly pageId: string;
  /** The writing page's chunk counter, from 0. */
  readonly seq: number;
  /** The number of events (lines) in the chunk. */
  readonly count: number;
  /** The value's `length` in UTF-16 code units, for the capacity rule (Web Disk 2). */
  readonly chars: number;
}

/** A parsed key under a `rubicon.<16 hex>.q1.` or `.q1r.` prefix (Web Disk 2, 6). */
export type ParsedQueueKey =
  | { readonly kind: 'chunk'; readonly name: ChunkName }
  | { readonly kind: 'marker'; readonly keyHash: string; readonly pageId: string }
  /** Under one of the exact queue prefixes of `keyHash`, but not of the grammar. */
  | { readonly kind: 'malformed'; readonly keyHash: string };

const PREFIX = 'rubicon.';
const HEX16 = /^[0-9a-f]{16}$/;
const DECIMAL = /^[0-9]{1,16}$/;

/**
 * The key of a chunk: `rubicon.<keyHash>.q1.<writtenAt>.<newestEventAt>.<pageId>.<seq>.<count>.<chars>`
 * (Web Disk 2), every number in decimal without padding.
 */
export function chunkKey(name: ChunkName): string {
  return (
    `${PREFIX}${name.keyHash}.${CHUNK_FORMAT}.${String(name.writtenAt)}.${String(name.newestEventAt)}.` +
    `${name.pageId}.${String(name.seq)}.${String(name.count)}.${String(name.chars)}`
  );
}

/** The key of a released marker: `rubicon.<keyHash>.q1r.<pageId>` (Web Disk 2). */
export function markerKey(keyHash: string, pageId: string): string {
  return `${PREFIX}${keyHash}.${MARKER_FORMAT}.${pageId}`;
}

/** The chunk id of Web Retry 1 (`suspects`): `<pageId>.<seq>`, unique per key hash. */
export function chunkId(name: Pick<ChunkName, 'pageId' | 'seq'>): string {
  return `${name.pageId}.${String(name.seq)}`;
}

/**
 * Reads a `localStorage` key: a chunk or a marker of any key hash, `malformed` for a key under the
 * exact prefixes `rubicon.<16 hex>.q1.` or `rubicon.<16 hex>.q1r.` that does not follow the grammar,
 * and `undefined` for every other key (the host's, the stores, other formats), which the queue never
 * touches (Web Disk 2, 6).
 */
export function parseQueueKey(key: string): ParsedQueueKey | undefined {
  if (key.lastIndexOf(PREFIX, 0) !== 0) return undefined;
  const parts = key.slice(PREFIX.length).split('.');
  const keyHash = parts[0] ?? '';
  const format = parts[1];
  // Only keys that continue after the format part are under the exact prefixes (`...q1.`, `...q1r.`).
  if (!HEX16.test(keyHash) || parts.length < 3 || (format !== CHUNK_FORMAT && format !== MARKER_FORMAT)) {
    return undefined;
  }
  const malformed = { kind: 'malformed', keyHash } as const;
  if (format === MARKER_FORMAT) {
    const pageId = parts[2] ?? '';
    return parts.length === 3 && HEX16.test(pageId) ? { kind: 'marker', keyHash, pageId } : malformed;
  }
  if (parts.length !== 8) return malformed;
  const writtenAt = decimal(parts[2]);
  const newestEventAt = decimal(parts[3]);
  const pageId = parts[4] ?? '';
  const seq = decimal(parts[5]);
  const count = decimal(parts[6]);
  const chars = decimal(parts[7]);
  if (
    writtenAt === undefined ||
    newestEventAt === undefined ||
    !HEX16.test(pageId) ||
    seq === undefined ||
    count === undefined ||
    chars === undefined ||
    // A chunk is never written without an event (Web Queue 2: a chunk holds the events of one write).
    count < 1 ||
    chars < 1
  ) {
    return malformed;
  }
  return { kind: 'chunk', name: { keyHash, writtenAt, newestEventAt, pageId, seq, count, chars } };
}

function decimal(text: string | undefined): number | undefined {
  if (text === undefined || !DECIMAL.test(text)) return undefined;
  const value = Number(text);
  return value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}
