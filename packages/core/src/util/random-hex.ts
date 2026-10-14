import type { RandomSource } from '../platform/random';

/**
 * A new `person_epoch`: 64 bits from the `RandomSource` (`crypto.getRandomValues` in the browser),
 * written as 16 lowercase hex characters (Web Session 5, Web Identity 4). It ties the session cookie
 * to the identity cookie and is renewed on `reset()`, a change of user and `clearLocalData()`.
 */
export function newPersonEpoch(random: RandomSource): string {
  return randomHex(random, 2);
}

/** `words` draws of the `RandomSource`, each as 8 lowercase hex characters, in draw order. */
export function randomHex(random: RandomSource, words: number): string {
  let out = '';
  for (let i = 0; i < words; i += 1) out += (random.nextUint32() >>> 0).toString(16).padStart(8, '0');
  return out;
}
