/**
 * The only source of randomness: `crypto.getRandomValues` in the browser, never `Math.random` (Web
 * Event Model 3). It feeds the UUIDv7 generator (`message_id`, `device_id`, the session id), the page
 * id of the chunk keys, `person_epoch` and the jitter of the retry waits. Tests script or seed it.
 */
export interface RandomSource {
  /** An integer in `[0, 2^32)`, uniformly distributed. */
  nextUint32(): number;
}
