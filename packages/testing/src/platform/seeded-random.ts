import type { RandomSource } from 'rubicon-analytics-core';

/**
 * A `RandomSource` that produces the same sequence for the same seed, for reproducible tests
 * (mulberry32, a 32-bit generator; statistical quality is not the point here). Test vectors that
 * need exact draws use a scripted source instead (step 2.3).
 */
export class SeededRandom implements RandomSource {
  private state: number;

  constructor(readonly seed: number = 42) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
}
