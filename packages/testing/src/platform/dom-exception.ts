/**
 * The errors the browser throws from storage and cookie access, as `DOMException`s with the names
 * the core tells them apart by (Web Disk 1, 4, Web Queue 6). Node provides the same global class.
 */
export function securityError(): DOMException {
  return new DOMException('The operation is insecure.', 'SecurityError');
}

export function quotaExceededError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}
