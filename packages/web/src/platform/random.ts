import type { RandomSource } from 'rubicon-analytics-core';

// Words drawn from `crypto.getRandomValues` at a time; a call per word would cost more than the
// words do. Never `Math.random` (Web Event Model 3).
const POOL_SIZE = 16;

/**
 * The browser's {@link RandomSource} over `crypto.getRandomValues`, which the factory checked
 * before building the platform (Web Public API 7). `crypto` is read at every refill, never at import.
 */
export function createCryptoRandom(): RandomSource {
  const pool = new Uint32Array(POOL_SIZE);
  let next = POOL_SIZE;
  return {
    nextUint32(): number {
      if (next === POOL_SIZE) {
        crypto.getRandomValues(pool);
        next = 0;
      }
      const word = pool[next] ?? 0;
      next += 1;
      return word;
    },
  };
}
