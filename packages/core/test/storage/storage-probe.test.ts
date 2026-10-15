import { MemoryStorage } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { keyHash, probeKey, storageReadable, storageWritable } from '../../src';
import type { KeyValueStorage } from '../../src';

// The start probe of Web Disk 4 in two halves (plan section 15, step 7.2, the user's answer 3): a
// read in every consent state, and a write, read back and removal of `rubicon.<keyHash>.probe` only
// for a page that starts with consent granted (`default-analytics.test.ts` shows when each is asked).

const KEY = probeKey(keyHash('test-api-key'));

describe('the probe key', () => {
  it('is rubicon.<keyHash>.probe', () => {
    expect(KEY).toBe(`rubicon.${keyHash('test-api-key')}.probe`);
  });
});

describe('the read half', () => {
  it('passes where storage can be read, reading no key and writing nothing', () => {
    const storage = new MemoryStorage();
    expect(storageReadable(storage)).toBe(true);
    expect(storage.area.entries.size).toBe(0);
  });

  it('fails where reading storage throws', () => {
    const storage = new MemoryStorage();
    storage.failAccess = true;
    expect(storageReadable(storage)).toBe(false);
  });

  it('passes where only writes fail, which the write half finds', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(storageReadable(storage)).toBe(true);
    expect(storageWritable(storage, KEY)).toBe(false);
  });
});

describe('the write half', () => {
  it('writes an empty value, reads it back and removes it in the same turn', () => {
    const storage = new MemoryStorage();
    const calls: string[] = [];
    const watched: KeyValueStorage = {
      get length() {
        return storage.length;
      },
      key: (index) => storage.key(index),
      getItem: (key) => {
        calls.push(`get ${key}`);
        return storage.getItem(key);
      },
      setItem: (key, value) => {
        calls.push(`set ${key}=${value}`);
        storage.setItem(key, value);
      },
      removeItem: (key) => {
        calls.push(`remove ${key}`);
        storage.removeItem(key);
      },
    };

    expect(storageWritable(watched, KEY)).toBe(true);
    expect(calls).toEqual([`set ${KEY}=`, `get ${KEY}`, `remove ${KEY}`]);
    expect(storage.area.entries.size).toBe(0);
  });

  it('fails on a QuotaExceededError, a zero quota, and leaves nothing', () => {
    const storage = new MemoryStorage();
    storage.failWritesWhere = (key) => key === KEY;
    expect(storageWritable(storage, KEY)).toBe(false);
    expect(storage.area.entries.size).toBe(0);
  });

  it('fails where storage throws, without throwing', () => {
    const storage = new MemoryStorage();
    storage.failAccess = true;
    expect(storageWritable(storage, KEY)).toBe(false);
  });

  it('fails when the value does not come back', () => {
    const storage = new MemoryStorage();
    const forgetful: KeyValueStorage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(storageWritable(forgetful, KEY)).toBe(false);
    expect(storage.area.entries.size).toBe(0);
  });
});
