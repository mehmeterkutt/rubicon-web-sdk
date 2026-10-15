import { describe, expect, it } from 'vitest';
import { chunkId, chunkKey, keyHash, MARKER_VALUE, markerKey, parseQueueKey } from '../../src';
import type { ChunkName } from '../../src';

// The chunk key grammar of Web Disk 2: `rubicon.<keyHash>.q1.<writtenAt>.<newestEventAt>.<pageId>.
// <seq>.<count>.<chars>` and the marker `rubicon.<keyHash>.q1r.<pageId>`.

const HASH = keyHash('test-api-key');
const OTHER_HASH = keyHash('another-api-key');
const PAGE = 'a1b2c3d4e5f60718';

const NAME: ChunkName = {
  keyHash: HASH,
  writtenAt: 1_759_147_200_123,
  newestEventAt: 1_759_147_200_100,
  pageId: PAGE,
  seq: 7,
  count: 30,
  chars: 12_345,
};

describe('chunk keys', () => {
  it('spell every part in decimal without padding, in the order of the page', () => {
    expect(chunkKey(NAME)).toBe(`rubicon.${HASH}.q1.1759147200123.1759147200100.${PAGE}.7.30.12345`);
    expect(chunkKey({ ...NAME, writtenAt: 0, newestEventAt: 0, seq: 0, count: 1, chars: 1 })).toBe(
      `rubicon.${HASH}.q1.0.0.${PAGE}.0.1.1`,
    );
  });

  it('are about 80 characters, as Web Disk 2 counts them in the quota', () => {
    expect(chunkKey(NAME).length).toBe(83);
  });

  it('read back to the same name', () => {
    expect(parseQueueKey(chunkKey(NAME))).toEqual({ kind: 'chunk', name: NAME });
    const other = { ...NAME, keyHash: OTHER_HASH };
    expect(parseQueueKey(chunkKey(other))).toEqual({ kind: 'chunk', name: other });
  });

  it('give the chunk id of the poison-batch counters as pageId.seq (Web Retry 1)', () => {
    expect(chunkId(NAME)).toBe(`${PAGE}.7`);
  });

  it('mark a released page with an empty value', () => {
    expect(markerKey(HASH, PAGE)).toBe(`rubicon.${HASH}.q1r.${PAGE}`);
    expect(MARKER_VALUE).toBe('');
    expect(parseQueueKey(markerKey(OTHER_HASH, PAGE))).toEqual({ kind: 'marker', keyHash: OTHER_HASH, pageId: PAGE });
  });

  it('are malformed under the exact prefixes when they break the grammar', () => {
    const malformed = [
      `rubicon.${HASH}.q1.`,
      `rubicon.${HASH}.q1.x`,
      `rubicon.${HASH}.q1.1.2.${PAGE}.3.4`,
      `rubicon.${HASH}.q1.1.2.${PAGE}.3.4.5.6`,
      `rubicon.${HASH}.q1.-1.2.${PAGE}.3.4.5`,
      `rubicon.${HASH}.q1.1.5.${PAGE.toUpperCase()}.3.4.5`,
      `rubicon.${HASH}.q1.1.2.${PAGE.slice(1)}.3.4.5`,
      `rubicon.${HASH}.q1.1.2.${PAGE}.3.0.5`,
      `rubicon.${HASH}.q1.1.2.${PAGE}.3.4.0`,
      `rubicon.${HASH}.q1.1.2.${PAGE}.3.1e3.5`,
      `rubicon.${HASH}.q1.99999999999999999.2.${PAGE}.3.4.5`,
      `rubicon.${HASH}.q1.1.2.${PAGE}. 3.4.5`,
      `rubicon.${HASH}.q1r.`,
      `rubicon.${HASH}.q1r.${PAGE}.1`,
      `rubicon.${HASH}.q1r.xyz`,
    ];
    for (const key of malformed) expect(parseQueueKey(key), key).toEqual({ kind: 'malformed', keyHash: HASH });
  });

  it('leave every key outside the exact prefixes alone', () => {
    const outside = [
      `rubicon.${HASH}.device`,
      `rubicon.${HASH}.person`,
      `rubicon.${HASH}.q1`,
      `rubicon.${HASH}.q1r`,
      `rubicon.${HASH}.q2.1.2.${PAGE}.3.4.5`,
      `rubicon.${HASH}.q10.1.2.${PAGE}.3.4.5`,
      `rubicon.${HASH.toUpperCase()}.q1.1.2.${PAGE}.3.4.5`,
      `rubicon.${HASH.slice(1)}.q1.1.2.${PAGE}.3.4.5`,
      `Rubicon.${HASH}.q1.1.2.${PAGE}.3.4.5`,
      `x.rubicon.${HASH}.q1.1.2.${PAGE}.3.4.5`,
      `rubicon_${HASH}`,
      'host-key',
      '',
    ];
    for (const key of outside) expect(parseQueueKey(key), key).toBeUndefined();
  });
});
