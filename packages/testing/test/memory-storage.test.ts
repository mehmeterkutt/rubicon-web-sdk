import { describe, expect, it } from 'vitest';
import { MemoryStorage, MemoryStorageArea } from '../src';

function listKeys(storage: MemoryStorage): (string | null)[] {
  const keys: (string | null)[] = [];
  for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
  return keys;
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('MemoryStorage', () => {
  describe('behaves as localStorage', () => {
    it('stores, reads, lists and removes values', () => {
      const storage = new MemoryStorage();
      expect(storage.length).toBe(0);
      expect(storage.getItem('a')).toBeNull();
      storage.setItem('a', '1');
      storage.setItem('b', '2');
      storage.setItem('a', '3');
      expect(storage.getItem('a')).toBe('3');
      expect(storage.length).toBe(2);
      expect(listKeys(storage)).toEqual(['a', 'b']);
      storage.removeItem('a');
      storage.removeItem('missing');
      expect(storage.getItem('a')).toBeNull();
      expect(listKeys(storage)).toEqual(['b']);
    });

    it('gives null for an index out of range', () => {
      const storage = new MemoryStorage();
      storage.setItem('a', '1');
      expect(storage.key(1)).toBeNull();
      expect(storage.key(-1)).toBeNull();
    });

    it('lists keys in reverse when asked, so a test can prove it does not depend on the order', () => {
      const storage = new MemoryStorage(new MemoryStorageArea({ keyOrder: 'reverse' }));
      storage.setItem('a', '1');
      storage.setItem('b', '2');
      storage.setItem('c', '3');
      expect(listKeys(storage)).toEqual(['c', 'b', 'a']);
    });

    it('counts successful writes per page', () => {
      const storage = new MemoryStorage();
      storage.setItem('a', '1');
      storage.setItem('a', '2');
      expect(storage.writeCount).toBe(2);
    });
  });

  describe('two pages over one MemoryStorage see each other’s writes', () => {
    it('shows a write of one page to the other at once', () => {
      const first = new MemoryStorage();
      const second = first.otherPage();
      first.setItem('rubicon.k.device', '{"v":1}');
      expect(second.getItem('rubicon.k.device')).toBe('{"v":1}');
      second.setItem('rubicon.k.person', '{"v":1}');
      expect(listKeys(first)).toEqual(['rubicon.k.device', 'rubicon.k.person']);
      second.removeItem('rubicon.k.device');
      expect(first.getItem('rubicon.k.device')).toBeNull();
      expect(first.area).toBe(second.area);
    });

    it('keeps the faults of one page away from the other', () => {
      const first = new MemoryStorage();
      const second = first.otherPage();
      first.failAccess = true;
      second.setItem('a', '1');
      expect(second.getItem('a')).toBe('1');
    });

    it('tells the other pages, never the writer, of a change as a storage event (Web Privacy 2)', () => {
      const first = new MemoryStorage();
      const second = first.otherPage();
      const third = first.otherPage();
      const heard: string[] = [];
      first.subscribe((key) => heard.push(`first:${String(key)}`));
      second.subscribe((key) => heard.push(`second:${String(key)}`));
      const stop = third.subscribe((key) => heard.push(`third:${String(key)}`));

      first.setItem('a', '1');
      first.setItem('a', '1');
      stop();
      second.removeItem('a');
      second.removeItem('a');

      expect(heard).toEqual(['second:a', 'third:a', 'first:a']);
    });

    it('shares the quota of the origin', () => {
      const first = new MemoryStorage(new MemoryStorageArea({ quotaChars: 10 }));
      const second = first.otherPage();
      first.setItem('aaaa', 'bbbb');
      expect(() => {
        second.setItem('cc', 'dd');
      }).toThrow(expect.objectContaining({ name: 'QuotaExceededError' }));
      expect(second.area.usedChars()).toBe(8);
    });
  });

  describe('fault injection produces each failure as the browser would', () => {
    it('throws a SecurityError DOMException from every member when access fails', () => {
      const storage = new MemoryStorage();
      storage.setItem('a', '1');
      storage.failAccess = true;
      const attempts: (() => unknown)[] = [
        () => storage.length,
        () => storage.key(0),
        () => storage.getItem('a'),
        () => {
          storage.setItem('a', '2');
        },
        () => {
          storage.removeItem('a');
        },
      ];
      for (const attempt of attempts) {
        const error = thrown(attempt);
        expect(error).toBeInstanceOf(DOMException);
        expect(error).toMatchObject({ name: 'SecurityError', code: DOMException.SECURITY_ERR });
      }
      storage.failAccess = false;
      expect(storage.getItem('a')).toBe('1');
    });

    it('throws a QuotaExceededError DOMException on a write and keeps the previous value', () => {
      const storage = new MemoryStorage();
      storage.setItem('a', 'old');
      storage.failWrites = true;
      const error = thrown(() => {
        storage.setItem('a', 'new');
      });
      expect(error).toBeInstanceOf(DOMException);
      expect(error).toMatchObject({ name: 'QuotaExceededError', code: DOMException.QUOTA_EXCEEDED_ERR });
      expect(storage.getItem('a')).toBe('old');
      expect(storage.writeCount).toBe(1);
      // Reads and deletes still work: only writes fail.
      storage.removeItem('a');
      expect(storage.getItem('a')).toBeNull();
    });

    it('fails the writes of the keys failWritesWhere accepts and no others', () => {
      const storage = new MemoryStorage();
      storage.setItem('a', 'old');
      storage.failWritesWhere = (key) => key === 'a';

      expect(() => {
        storage.setItem('a', 'new');
      }).toThrow(expect.objectContaining({ name: 'QuotaExceededError' }));
      storage.setItem('b', '1');
      expect(storage.getItem('a')).toBe('old');
      expect(storage.getItem('b')).toBe('1');
      storage.failWritesWhere = undefined;
      storage.setItem('a', 'new');
      expect(storage.getItem('a')).toBe('new');
    });

    it('throws QuotaExceededError when keys and values together would pass the quota', () => {
      const storage = new MemoryStorage(new MemoryStorageArea({ quotaChars: 20 }));
      storage.setItem('key1', 'x'.repeat(10));
      expect(() => {
        storage.setItem('key2', 'y'.repeat(3));
      }).toThrow(expect.objectContaining({ name: 'QuotaExceededError' }));
      expect(storage.getItem('key2')).toBeNull();
      // Replacing a value frees the old one first.
      storage.setItem('key1', 'z'.repeat(16));
      expect(storage.area.usedChars()).toBe(20);
    });

    it('counts the quota in UTF-16 code units, 5 MiB by default (plan section 15, step 1.4)', () => {
      const area = new MemoryStorageArea();
      expect(area.quotaChars).toBe(5_242_880);
      const storage = new MemoryStorage(area);
      storage.setItem('k', '\u{1F600}');
      expect(area.usedChars()).toBe(3);
    });

    it('lets a key vanish between key(i) and getItem, as another page deleting it does', () => {
      const first = new MemoryStorage();
      const second = first.otherPage();
      first.setItem('rubicon.k.q1.chunk-a', 'line');
      first.setItem('rubicon.k.q1.chunk-b', 'line');
      second.vanishAfterListing('rubicon.k.q1.chunk-a');
      const listed = listKeys(second);
      expect(listed).toContain('rubicon.k.q1.chunk-a');
      expect(second.getItem('rubicon.k.q1.chunk-a')).toBeNull();
      expect(second.getItem('rubicon.k.q1.chunk-b')).toBe('line');
      expect(first.getItem('rubicon.k.q1.chunk-a')).toBeNull();
      // Deleting the vanished key again is a no-op.
      second.removeItem('rubicon.k.q1.chunk-a');
      expect(second.length).toBe(1);
    });

    it('lets the set of keys shrink during a walk, so key(i) gives null past the end', () => {
      const first = new MemoryStorage();
      const second = first.otherPage();
      first.setItem('a', '1');
      first.setItem('b', '2');
      const length = second.length;
      first.removeItem('a');
      expect(second.key(length - 1)).toBeNull();
    });

    it('snapshots the area for assertions', () => {
      const storage = new MemoryStorage();
      storage.setItem('a', '1');
      expect(storage.area.snapshot()).toEqual({ a: '1' });
    });
  });
});
