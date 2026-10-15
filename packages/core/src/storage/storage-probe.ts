import type { KeyValueStorage } from '../platform';

/**
 * The key of the start probe's write, `rubicon.<keyHash>.probe`, written empty and removed in the
 * same turn, as the storage declaration lists it (Web Disk 4, Web Privacy 5; plan section 15, step
 * 7.2, the user's answer 3).
 */
export function probeKey(keyHash: string): string {
  return `rubicon.${keyHash}.probe`;
}

/**
 * The read half of the start probe of Web Disk 4, asked in every consent state: `false` when
 * reading storage throws (a sandboxed iframe, site data blocked). It reads no key and writes nothing,
 * so a page whose consent is pending or refused writes nothing (Web Privacy 1, Web Logging 4).
 */
export function storageReadable(storage: KeyValueStorage): boolean {
  try {
    return typeof storage.length === 'number';
  } catch {
    return false;
  }
}

/**
 * The write half, asked only when the page starts with consent granted: the empty value under `key`
 * written, read back and removed at once. `false` when any step throws or the value does not come
 * back, as with the zero quota of Safari 10's private mode (Web Disk 4).
 */
export function storageWritable(storage: KeyValueStorage, key: string): boolean {
  let written = false;
  try {
    storage.setItem(key, '');
    written = storage.getItem(key) === '';
  } catch {
    // Storage that cannot be written: the memory-only mode.
  }
  try {
    storage.removeItem(key);
  } catch {
    // Nothing more can be done; the key holds an empty value at most.
  }
  return written;
}
