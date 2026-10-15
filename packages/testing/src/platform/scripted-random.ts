import type { RandomSource } from 'rubicon-analytics-core';

/**
 * A `RandomSource` that returns the given words in order, for test vectors that need exact draws
 * (the iOS `ScriptedRandom`), such as the Android UUIDv7 ids replayed from the words of Android's
 * draws. Running out is a mistake in the test and throws.
 */
export class ScriptedRandom implements RandomSource {
  private next = 0;

  constructor(private readonly words: readonly number[]) {
    for (const word of words) {
      if (!Number.isInteger(word) || word < 0 || word > 0xffff_ffff) {
        throw new RangeError(`ScriptedRandom: ${String(word)} is not a 32-bit word`);
      }
    }
  }

  /** How many words have been drawn. */
  get drawn(): number {
    return this.next;
  }

  nextUint32(): number {
    const word = this.words[this.next];
    if (word === undefined) throw new Error(`ScriptedRandom: all ${String(this.words.length)} words drawn`);
    this.next += 1;
    return word;
  }
}
