import type { KeyValueStorage } from 'rubicon-analytics-core';

/**
 * The origin's `localStorage` behind the core's {@link KeyValueStorage} (Web Disk 1). `localStorage`
 * is read from `window` at every access, never at import or once and kept: its getter itself throws a
 * `SecurityError` where storage cannot be used (a sandboxed iframe, site data blocked), and the core
 * catches at every call, since what a failure means depends on what it was doing (step 2.1). Nothing
 * here catches, so a `QuotaExceededError` reaches the chunk store as the drop it is (Web Queue 6).
 * Never `sessionStorage`, IndexedDB or `navigator.storage` (Web Disk 1, 7).
 */
export function createLocalStorage(): KeyValueStorage {
  const area = (): Storage => window.localStorage;
  return {
    get length() {
      return area().length;
    },
    key: (index) => area().key(index),
    getItem: (key) => area().getItem(key),
    setItem: (key, value) => {
      area().setItem(key, value);
    },
    removeItem: (key) => {
      area().removeItem(key);
    },
  };
}
