/**
 * The errors the browser throws from storage and cookie access, and the rejection of an aborted
 * `fetch`, as `DOMException`s with the names the core tells them apart by (Web Disk 1, 4, Web Queue
 * 6, Web HTTP 3). Node provides the same global class.
 */
export function securityError(): DOMException {
  return new DOMException('The operation is insecure.', 'SecurityError');
}

export function quotaExceededError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

/** What `fetch` rejects with when its `AbortController` aborts (Web HTTP 3). */
export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
